import { db } from "./dbClient";

const MIN_SHARE_FRAC = 0.10; // ignore ingredient shares < 10% of component
const PLATE_SHARE_NORMALIZE_EPS = 0.03; // normalize if sum close to 1

const SOURCE_SYSTEM = process.env.MAPPING_SOURCE_SYSTEM || "SODEXO";

type DonationRow = {
  id: number;
  dish_id: number | null;
  component_id: number | null;
  donated_weight_kg: number;
};

type DishComponentRow = {
  id: number;
  dish_id: number;
  plate_share: number | null;
};

type IngredientRow = {
  component_id: number;
  ingredient_core: string;
  share_of_component: number | null; // 0..100
  is_water: boolean;
  is_salt: boolean;
};

type MappingRow = {
  ingredient_core: string;
  luke_foodid: number | null;
  weight_state: string | null; // ignore | cooked | raw
  yield_cooked_per_raw: number | null;
  co2_override_per_kg: number | null;
};

type LukeFoodRow = {
  foodid: number;
  kg_co2e_per_kg: number | null;
  g_co2e_per_100g: number | null;
};

function toNum(x: unknown): number | null {
  if (x === null || x === undefined) return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function sumNums(arr: number[]): number {
  return arr.reduce<number>((acc, v) => acc + v, 0);
}

function getCo2FactorKgPerKg(mapping: MappingRow | undefined, food: LukeFoodRow | undefined): number | null {
  const ov = toNum(mapping?.co2_override_per_kg ?? null);
  if (ov !== null) return ov;

  const kg = toNum(food?.kg_co2e_per_kg ?? null);
  if (kg !== null) return kg;

  // g/100g -> kg/kg : g * 0.01
  const g = toNum(food?.g_co2e_per_100g ?? null);
  if (g !== null) return g * 0.01;

  return null;
}

function normalizeComponentShares(components: DishComponentRow[]): number[] {
  const provided = components.map((c) => {
    const v = toNum(c.plate_share);
    if (v === null) return null;
    return clamp(v, 0, 1);
  });

  const sumProvided = provided.reduce<number>((acc, v) => acc + (v ?? 0), 0);
  if (sumProvided <= 0) {
    const eq = 1 / components.length;
    return components.map(() => eq);
  }

  let shares = provided.map((v) => v ?? 0);

  const missingIdx = provided
    .map((v, i) => ({ v, i }))
    .filter((x) => x.v == null)
    .map((x) => x.i);

  const sumNow = sumNums(shares);
  const remainder = 1 - sumNow;
  if (missingIdx.length && remainder > 0) {
    const add = remainder / missingIdx.length;
    for (const i of missingIdx) shares[i] += add;
  }

  const sumFinal = sumNums(shares);
  if (sumFinal > 0 && Math.abs(sumFinal - 1) <= PLATE_SHARE_NORMALIZE_EPS) {
    shares = shares.map((s) => s / sumFinal);
  } else if (sumFinal > 1) {
    shares = shares.map((s) => s / sumFinal);
  }

  return shares;
}

export type DonationUnmappedBuckets = {
  donation_id: number;
  mapping_source_system: string;
  missing_share_mass_kg: number;
  mapping_or_factor_unmapped_mass_kg: number;
};

/**
 * Buckets for "unmapped" mass:
 * - missing_share_mass_kg: mass we cannot allocate because ingredient shares are missing / don't sum to 100.
 * - mapping_or_factor_unmapped_mass_kg: mass that had a share but couldn't be mapped to a CO2 factor (missing mapping, missing factor, invalid raw yield).
 *
 * NOTE: This does NOT try to reproduce the full carbonCalculator mass accounting exactly; it's intended for UI buckets.
 */
export async function computeDonationUnmappedBuckets(donationId: number): Promise<DonationUnmappedBuckets> {
  const { data: donation, error: donationError } = await db
    .from("donations")
    .select("id, dish_id, component_id, donated_weight_kg")
    .eq("id", donationId)
    .single();

  if (donationError || !donation) {
    throw new Error(`Donation ${donationId} not found: ${donationError?.message ?? "no row"}`);
  }

  const donatedWeightKg = Number((donation as any).donated_weight_kg);
  if (!Number.isFinite(donatedWeightKg) || donatedWeightKg <= 0) {
    throw new Error(`Donation ${donationId} has invalid donated_weight_kg`);
  }

  const componentId = (donation as any).component_id == null ? null : Number((donation as any).component_id);
  const dishId = (donation as any).dish_id == null ? null : Number((donation as any).dish_id);

  let allocations: Array<{ component_id: number; component_weight_kg: number }> = [];

  if (componentId != null) {
    allocations = [{ component_id: componentId, component_weight_kg: donatedWeightKg }];
  } else {
    if (dishId == null) throw new Error(`Donation ${donationId} has neither dish_id nor component_id`);

    const { data: compsData, error: compsError } = await db.from("dish_components").select("id, dish_id, plate_share").eq("dish_id", dishId);
    if (compsError) throw new Error(`Error loading dish_components: ${compsError.message}`);

    const comps = (compsData || []).map((c: any) => ({
      id: Number(c.id),
      dish_id: Number(c.dish_id),
      plate_share: c.plate_share == null ? null : Number(c.plate_share),
    })) as DishComponentRow[];

    if (!comps.length) {
      // Can't allocate; treat as missing-share by definition
      return {
        donation_id: donationId,
        mapping_source_system: SOURCE_SYSTEM,
        missing_share_mass_kg: donatedWeightKg,
        mapping_or_factor_unmapped_mass_kg: 0,
      };
    }

    const shares = normalizeComponentShares(comps);
    allocations = comps.map((c, i) => ({ component_id: c.id, component_weight_kg: donatedWeightKg * shares[i] }));
  }

  const componentIds = allocations.map((a) => a.component_id);
  const { data: ingredientsData, error: ingError } = await db
    .from("component_ingredients")
    .select("component_id, ingredient_core, share_of_component, is_water, is_salt")
    .in("component_id", componentIds);

  if (ingError) throw new Error(`Error loading component_ingredients: ${ingError.message}`);

  const ingredients = (ingredientsData || []) as IngredientRow[];

  let missingShareMassKg = 0;
  let mappingUnmappedMassKg = 0;

  for (const alloc of allocations) {
    const componentWeightKg = alloc.component_weight_kg;
    if (componentWeightKg <= 0) continue;

    const rows = ingredients.filter((r) => Number(r.component_id) === Number(alloc.component_id));

    if (!rows.length) {
      // No rows => can't allocate anything
      missingShareMassKg += componentWeightKg;
      continue;
    }

    const sharePct = rows
      .map((r) => toNum(r.share_of_component))
      .map((v) => (v == null ? null : clamp(v, 0, 100)));

    const sumPct = sumNums(sharePct.map((v) => (v == null ? 0 : v)));

    // missing share bucket: whatever is not covered by explicit shares
    if (sumPct <= 0) {
      missingShareMassKg += componentWeightKg;
      continue;
    }
    if (sumPct < 100) {
      missingShareMassKg += componentWeightKg * clamp(1 - sumPct / 100, 0, 1);
    }

    // mapping/factor unmapped bucket: only for rows with an explicit share
    const cores = Array.from(new Set(rows.map((r) => String(r.ingredient_core))));

    const { data: mappingsData, error: mapError } = await db
      .from("ingredient_mappings")
      .select("ingredient_core, luke_foodid, weight_state, yield_cooked_per_raw, co2_override_per_kg")
      .eq("source_system", SOURCE_SYSTEM)
      .eq("is_active", true)
      .in("ingredient_core", cores);

    if (mapError) throw new Error(`Error loading ingredient_mappings: ${mapError.message}`);

    const mappingByCore = new Map<string, MappingRow>();
    for (const m of (mappingsData || []) as any[]) {
      mappingByCore.set(String(m.ingredient_core), {
        ingredient_core: String(m.ingredient_core),
        luke_foodid: m.luke_foodid == null ? null : Number(m.luke_foodid),
        weight_state: m.weight_state == null ? null : String(m.weight_state),
        yield_cooked_per_raw: toNum(m.yield_cooked_per_raw),
        co2_override_per_kg: toNum(m.co2_override_per_kg),
      });
    }

    const foodids: number[] = Array.from(
      new Set(
        (mappingsData || [])
          .map((m: any) => m.luke_foodid)
          .filter((id: any) => id !== null && id !== undefined)
          .map((id: any) => Number(id))
          .filter((id: number) => Number.isFinite(id))
      )
    );

    const foodById = new Map<number, LukeFoodRow>();
    if (foodids.length) {
      const { data: foodsData, error: foodsError } = await db
        .from("luke_foods")
        .select("foodid, kg_co2e_per_kg, g_co2e_per_100g")
        .in("foodid", foodids);

      if (foodsError) throw new Error(`Error loading luke_foods: ${foodsError.message}`);

      for (const f of (foodsData || []) as any[]) {
        foodById.set(Number(f.foodid), {
          foodid: Number(f.foodid),
          kg_co2e_per_kg: toNum(f.kg_co2e_per_kg),
          g_co2e_per_100g: toNum(f.g_co2e_per_100g),
        });
      }
    }

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const pct = sharePct[i];
      if (pct == null) continue; // missing share handled by missingShareMassKg

      const frac = clamp(pct / 100, 0, 1);
      const cookedKg = componentWeightKg * frac;

      // ignore bucket by your definition (water/salt/<10%) => not counted here
      if (row.is_water || row.is_salt) continue;
      if (frac < MIN_SHARE_FRAC) continue;

      const mapping = mappingByCore.get(String(row.ingredient_core));
      if (!mapping) {
        mappingUnmappedMassKg += cookedKg;
        continue;
      }

      const weightState = (mapping.weight_state || "ignore").toLowerCase();
      if (weightState === "ignore") continue;

      const foodid = mapping.luke_foodid;
      const food = foodid != null ? foodById.get(foodid) : undefined;
      const factor = getCo2FactorKgPerKg(mapping, food);

      if (factor === null) {
        mappingUnmappedMassKg += cookedKg;
        continue;
      }

      if (weightState === "raw") {
        const y = mapping.yield_cooked_per_raw;
        if (!(y != null && y > 0)) {
          mappingUnmappedMassKg += cookedKg;
          continue;
        }
      }
    }
  }

  return {
    donation_id: donationId,
    mapping_source_system: SOURCE_SYSTEM,
    missing_share_mass_kg: missingShareMassKg,
    mapping_or_factor_unmapped_mass_kg: mappingUnmappedMassKg,
  };
}

