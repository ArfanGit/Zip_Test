// src/carbonCalculator.ts
import { db } from "./dbClient";

export interface DonationCarbonResult {
  donation_id: number;
  dish_id: number | null;
  component_id: number | null;
  donated_weight_kg: number;

  total_co2e_kg: number;
  total_food_mass_kg: number;
  unmapped_mass_kg: number;

  co2_per_kg: number;

  mapped_mass_kg: number;
  ignored_mass_kg: number;

  mapping_source_system: string;
}

const MIN_SHARE_FRAC = 0.10; // ignore ingredient shares < 10% of component
const PLATE_SHARE_NORMALIZE_EPS = 0.03; // normalize if sum close to 1
const ING_SHARE_NORMALIZE_EPS = 5; // normalize if sum close to 100 (percentage points)
const ING_SHARE_MAX_OVER_EPS = 0.5; // hard error if shares exceed 100% by more than this

const SOURCE_SYSTEM = process.env.MAPPING_SOURCE_SYSTEM || "SODEXO";

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

function normalizeCoreFromName(nameRaw: string): string {
  let s = (nameRaw || "").trim().toUpperCase();
  s = s.replace(/Ä/g, "A").replace(/Ö/g, "O").replace(/Å/g, "A");
  s = s.replace(/\b\d+[.,]?\d*\s*(KG|G|L|DL|CL|ML)\b/g, " ");
  s = s.replace(/\b\d+[.,]?\d*\b/g, " ");
  s = s.replace(/\b(RTU|KPA|LTN|TANKO)\b/g, " ");
  s = s.replace(/[^A-Z0-9]+/g, "_");
  s = s.replace(/_+/g, "_").replace(/^_+|_+$/g, "");
  return s || "UNKNOWN";
}

function getCo2FactorKgPerKg(mapping: MappingRow | undefined, food: LukeFoodRow | undefined): number | null {
  // 1) override wins
  const override = mapping?.co2_override_per_kg ?? null;
  const ov = toNum(override);
  if (ov !== null) return ov;

  // 2) direct LUKE kg/kg
  const kg = toNum(food?.kg_co2e_per_kg ?? null);
  if (kg !== null) return kg;

  // 3) fallback from g/100g => kg/kg
  // g per 100g -> g per kg = *10 -> kg per kg = (g*10)/1000 = g*0.01
  const g = toNum(food?.g_co2e_per_100g ?? null);
  if (g !== null) return g * 0.01;

  return null;
}

async function computeComponentFallbackCarbonFromName(
  componentId: number,
  componentCookedWeightKg: number
): Promise<{ co2eKg: number; unmappedKg: number; mappedKg: number; ignoredKg: number }> {
  const { data: comp, error: compErr } = await db.from("dish_components").select("id, name_raw").eq("id", componentId).single();
  if (compErr || !comp) {
    return { co2eKg: 0, unmappedKg: componentCookedWeightKg, mappedKg: 0, ignoredKg: 0 };
  }

  const core = normalizeCoreFromName(String((comp as any).name_raw || ""));
  if (!core || core === "UNKNOWN") {
    return { co2eKg: 0, unmappedKg: componentCookedWeightKg, mappedKg: 0, ignoredKg: 0 };
  }

  const { data: mappingsData, error: mapError } = await db
    .from("ingredient_mappings")
    .select("ingredient_core, luke_foodid, weight_state, yield_cooked_per_raw, co2_override_per_kg")
    .eq("source_system", SOURCE_SYSTEM)
    .eq("is_active", true)
    .eq("ingredient_core", core)
    .limit(1);

  if (mapError) throw new Error(`Error loading ingredient_mappings (component fallback): ${mapError.message}`);

  const m = (mappingsData || [])[0] as any;
  if (!m) {
    return { co2eKg: 0, unmappedKg: componentCookedWeightKg, mappedKg: 0, ignoredKg: 0 };
  }

  const mapping: MappingRow = {
    ingredient_core: String(m.ingredient_core),
    luke_foodid: m.luke_foodid == null ? null : Number(m.luke_foodid),
    weight_state: m.weight_state == null ? null : String(m.weight_state),
    yield_cooked_per_raw: toNum(m.yield_cooked_per_raw),
    co2_override_per_kg: toNum(m.co2_override_per_kg),
  };

  const weightState = (mapping.weight_state || "ignore").toLowerCase();
  if (weightState === "ignore") {
    return { co2eKg: 0, unmappedKg: 0, mappedKg: 0, ignoredKg: componentCookedWeightKg };
  }

  let food: LukeFoodRow | undefined;
  if (mapping.luke_foodid != null) {
    const { data: foodsData, error: foodsError } = await db
      .from("luke_foods")
      .select("foodid, kg_co2e_per_kg, g_co2e_per_100g")
      .eq("foodid", mapping.luke_foodid)
      .limit(1);

    if (foodsError) throw new Error(`Error loading luke_foods (component fallback): ${foodsError.message}`);
    const f = (foodsData || [])[0] as any;
    if (f) {
      food = {
        foodid: Number(f.foodid),
        kg_co2e_per_kg: toNum(f.kg_co2e_per_kg),
        g_co2e_per_100g: toNum(f.g_co2e_per_100g),
      };
    }
  }

  const factor = getCo2FactorKgPerKg(mapping, food);
  if (factor === null) {
    return { co2eKg: 0, unmappedKg: componentCookedWeightKg, mappedKg: 0, ignoredKg: 0 };
  }

  let massForFactorKg = componentCookedWeightKg;
  if (weightState === "raw") {
    const y = mapping.yield_cooked_per_raw;
    if (y != null && y > 0) {
      massForFactorKg = componentCookedWeightKg / y;
    } else {
      return { co2eKg: 0, unmappedKg: componentCookedWeightKg, mappedKg: 0, ignoredKg: 0 };
    }
  }

  return {
    co2eKg: massForFactorKg * factor,
    unmappedKg: 0,
    mappedKg: componentCookedWeightKg,
    ignoredKg: 0,
  };
}

async function computeComponentCarbon(
  componentId: number,
  componentCookedWeightKg: number
): Promise<{ co2eKg: number; unmappedKg: number; mappedKg: number; ignoredKg: number }> {
  if (componentCookedWeightKg <= 0) {
    return { co2eKg: 0, unmappedKg: 0, mappedKg: 0, ignoredKg: 0 };
  }

  const { data: ingredientsData, error: ingError } = await db
    .from("component_ingredients")
    .select("component_id, ingredient_core, share_of_component, is_water, is_salt")
    .eq("component_id", componentId);

  if (ingError) throw new Error(`Error loading component_ingredients: ${ingError.message}`);

  const ingredients = (ingredientsData || []) as IngredientRow[];

  if (ingredients.length === 0) {
    // Fallback: map by component name when ingredient breakdown is missing
    return await computeComponentFallbackCarbonFromName(componentId, componentCookedWeightKg);
  }

  // Shares
  const sharePctByRow: Array<number | null> = ingredients.map((r) => {
    const v = r.share_of_component;
    if (v == null) return null;
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    return clamp(n, 0, 100);
  });

  const hasMissingShare = sharePctByRow.some((v) => v == null);
  const validShares: number[] = sharePctByRow.map((v) => (v == null ? 0 : v));
  const sumPct = sumNums(validShares);

  if (sumPct <= 0) {
    // Unusable ingredient shares; try component-name fallback mapping
    return await computeComponentFallbackCarbonFromName(componentId, componentCookedWeightKg);
  }

  // Invariant: ingredient shares cannot exceed 100%
  // If they do, that's a data error (bad parse / bad source) and we should not silently “fix” it.
  if (sumPct > 100 + ING_SHARE_MAX_OVER_EPS) {
    throw new Error(
      `component_id=${componentId} ingredient share_of_component sum exceeds 100% (sum=${sumPct.toFixed(2)}). Fix parsing/data.`
    );
  }

  // Normalize only if close to 100 AND there are no missing shares.
  // If any share_of_component is NULL, the remainder must be treated as unmapped (not normalized away).
  let normFactor = 1;
  if (!hasMissingShare && Math.abs(sumPct - 100) <= ING_SHARE_NORMALIZE_EPS) {
    normFactor = 100 / sumPct;
  }

  // Load mappings
  const cores = Array.from(new Set(ingredients.map((r) => r.ingredient_core)));

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

  // IMPORTANT: accept numeric strings too
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

  let co2eKg = 0;
  let unmappedKg = 0;
  let mappedKg = 0;
  let ignoredKg = 0;

  // remainder only counted as unmapped when not normalizing
  const allocatedFrac = clamp((sumPct * normFactor) / 100, 0, 1);
  const unallocatedKg = componentCookedWeightKg * (1 - allocatedFrac);

  for (let i = 0; i < ingredients.length; i++) {
    const row = ingredients[i];
    const pctRaw = sharePctByRow[i];

    if (pctRaw == null) continue;

    const pct = pctRaw * normFactor;
    const frac = clamp(pct / 100, 0, 1);

    const cookedKg = componentCookedWeightKg * frac;

    // Ignore water/salt
    if (row.is_water || row.is_salt) {
      ignoredKg += cookedKg;
      continue;
    }

    // Ignore tiny shares
    if (frac < MIN_SHARE_FRAC) {
      ignoredKg += cookedKg;
      continue;
    }

    const mapping = mappingByCore.get(row.ingredient_core);

    // No mapping row
    if (!mapping) {
      unmappedKg += cookedKg;
      continue;
    }

    const weightState = (mapping.weight_state || "ignore").toLowerCase();
    if (weightState === "ignore") {
      ignoredKg += cookedKg;
      continue;
    }

    const foodid = mapping.luke_foodid;
    const food = foodid != null ? foodById.get(foodid) : undefined;

    const factor = getCo2FactorKgPerKg(mapping, food);

    // CRITICAL: if we can't get a factor, this mass is unmapped (NOT mapped with 0)
    if (factor === null) {
      unmappedKg += cookedKg;
      continue;
    }

    let massForFactorKg = cookedKg;

    // Convert cooked -> raw if factor is raw-based
    if (weightState === "raw") {
      const y = mapping.yield_cooked_per_raw;
      if (y != null && y > 0) {
        massForFactorKg = cookedKg / y;
      } else {
        unmappedKg += cookedKg;
        continue;
      }
    }

    co2eKg += massForFactorKg * factor;
    mappedKg += cookedKg;
  }

  // If we did not normalize, remainder is unmapped (this includes the “missing share” case).
  if (unallocatedKg > 1e-9 && normFactor === 1) {
    unmappedKg += unallocatedKg;
  }

  return { co2eKg, unmappedKg, mappedKg, ignoredKg };
}

export async function computeDonationCarbon(donationId: number): Promise<DonationCarbonResult> {
  const { data: donation, error: donationError } = await db
    .from("donations")
    .select("*")
    .eq("id", donationId)
    .single();

  if (donationError || !donation) {
    throw new Error(`Donation ${donationId} not found: ${donationError?.message ?? "no row"}`);
  }

  const donated_weight_kg = Number(donation.donated_weight_kg);
  if (!Number.isFinite(donated_weight_kg) || donated_weight_kg <= 0) {
    throw new Error(`Donation ${donationId} has invalid donated_weight_kg`);
  }

  let totalCo2eKg = 0;
  let unmappedMassKg = 0;
  let mappedMassKg = 0;
  let ignoredMassKg = 0;

  const component_id = donation.component_id == null ? null : Number(donation.component_id);
  const dish_id = donation.dish_id == null ? null : Number(donation.dish_id);

  if (component_id != null) {
    const r = await computeComponentCarbon(component_id, donated_weight_kg);
    totalCo2eKg += r.co2eKg;
    unmappedMassKg += r.unmappedKg;
    mappedMassKg += r.mappedKg;
    ignoredMassKg += r.ignoredKg;
  } else if (dish_id != null) {
    const { data: compsData, error: compsError } = await db
      .from("dish_components")
      .select("id, plate_share")
      .eq("dish_id", dish_id);

    if (compsError) throw new Error(`Error loading dish_components: ${compsError.message}`);

    const comps = (compsData || []) as Array<{ id: number; plate_share: number | null }>;

    if (!comps.length) {
      unmappedMassKg = donated_weight_kg;
    } else {
      const providedShares: Array<number | null> = comps.map((c) => {
        const v = c.plate_share;
        if (v == null) return null;
        const n = Number(v);
        if (!Number.isFinite(n)) return null;
        return clamp(n, 0, 1);
      });

      const sumProvided = providedShares.reduce<number>((acc, v) => acc + (v ?? 0), 0);

      let shares: number[] = new Array<number>(comps.length).fill(0);

      if (sumProvided <= 0) {
        const eq = 1 / comps.length;
        shares = shares.map(() => eq);
      } else {
        shares = providedShares.map((v) => v ?? 0);

        const missingIdx = providedShares
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
        // Invariant: dish component shares cannot exceed 1.0
        if (sumFinal > 1 + PLATE_SHARE_NORMALIZE_EPS) {
          throw new Error(
            `dish_id=${dish_id} dish_components plate_share sum exceeds 1.0 (sum=${sumFinal.toFixed(
              4
            )}). Fix AI/manual plate_share values.`
          );
        }

        // Keep prior behavior only for tiny floating error (close-to-1 normalization)
        if (sumFinal > 0 && Math.abs(sumFinal - 1) <= PLATE_SHARE_NORMALIZE_EPS) {
          shares = shares.map((s) => s / sumFinal);
        }
      }

      for (let i = 0; i < comps.length; i++) {
        const compWeightKg = donated_weight_kg * shares[i];
        if (compWeightKg <= 0) continue;

        const r = await computeComponentCarbon(Number(comps[i].id), compWeightKg);
        totalCo2eKg += r.co2eKg;
        unmappedMassKg += r.unmappedKg;
        mappedMassKg += r.mappedKg;
        ignoredMassKg += r.ignoredKg;
      }
    }
  } else {
    throw new Error(`Donation ${donationId} has neither dish_id nor component_id`);
  }

  const totalFoodMassKg = donated_weight_kg;
  const co2PerKg = totalFoodMassKg > 0 ? totalCo2eKg / totalFoodMassKg : 0;

  // persist cache
  const { error: metricsError } = await db.from("donation_metrics").upsert({
    donation_id: donationId,
    total_co2e_kg: totalCo2eKg,
    total_food_mass_kg: totalFoodMassKg,
    unmapped_mass_kg: unmappedMassKg,
  });

  if (metricsError) {
    console.error("Warning: failed to upsert donation_metrics:", metricsError.message);
  }

  return {
    donation_id: donationId,
    dish_id,
    component_id,
    donated_weight_kg,

    total_co2e_kg: totalCo2eKg,
    total_food_mass_kg: totalFoodMassKg,
    unmapped_mass_kg: unmappedMassKg,
    co2_per_kg: co2PerKg,

    mapped_mass_kg: mappedMassKg,
    ignored_mass_kg: ignoredMassKg,

    mapping_source_system: SOURCE_SYSTEM,
  };
}
