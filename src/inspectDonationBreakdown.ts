/**
 * Inspect donation breakdown: mapped / unmapped / ignored rows + CO2 factor provenance.
 *
 * Usage:
 *   npx ts-node src/inspectDonationBreakdown.ts --donation-id 5
 *   npx ts-node src/inspectDonationBreakdown.ts --donation-id 5 --json
 *
 * Notes:
 * - Mirrors the same heuristics as carbonCalculator.ts:
 *   - ingredient share threshold: <10% => ignored
 *   - water/salt => ignored
 *   - mapping.weight_state = 'ignore' => ignored
 *   - missing mapping or missing factor => unmapped
 *   - raw conversion uses yield_cooked_per_raw
 */

import "dotenv/config";
import { db } from "./dbClient";

const MIN_SHARE_FRAC = 0.10; // ignore ingredient shares < 10% of component
const PLATE_SHARE_NORMALIZE_EPS = 0.03; // normalize if sum close to 1
const ING_SHARE_NORMALIZE_EPS = 5; // normalize if sum close to 100 percentage points

const SOURCE_SYSTEM = process.env.MAPPING_SOURCE_SYSTEM || "SODEXO";

type DonationRow = {
  id: number;
  kitchen_id: string | null;
  dish_id: number | null;
  component_id: number | null;
  donated_weight_kg: number;
  donated_at: string | null;
};

type DishComponentRow = {
  id: number;
  dish_id: number;
  name_raw: string | null;
  component_type: string | null;
  plate_share: number | null;
};

type ComponentIngredientRow = {
  component_id: number;
  seq_no: number | null;
  ingredient_raw: string | null;
  base_name: string | null;
  description: string | null;
  ingredient_core: string;
  share_of_component: number | null; // 0..100
  share_source: string | null;
  is_water: boolean;
  is_salt: boolean;
};

type MappingRow = {
  ingredient_core: string;
  luke_foodid: number | null;
  match_type: string | null;
  weight_state: string | null; // ignore | cooked | raw
  yield_cooked_per_raw: number | null;
  co2_override_per_kg: number | null;
};

type LukeFoodRow = {
  foodid: number;
  name_fi: string | null;
  name_en: string | null;
  kg_co2e_per_kg: number | null;
  g_co2e_per_100g: number | null;
};

type BreakdownRow = {
  component_id: number;
  component_name: string;
  component_type: string | null;
  component_weight_kg: number;

  ingredient_core: string;
  base_name: string;
  share_pct: number | null;
  cooked_mass_kg: number;

  status: "mapped" | "unmapped" | "ignored";
  reason: string;

  luke_foodid: number | null;
  luke_name_fi: string | null;
  luke_name_en: string | null;

  match_type: string | null;
  weight_state: string | null;
  yield_cooked_per_raw: number | null;

  factor_source: "override" | "luke_kg" | "luke_g100" | "none";
  factor_kgco2_per_kg: number | null;

  mass_for_factor_kg: number;
  co2e_kg: number;
};

function getArg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : (process.argv[i + 1] ?? null);
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

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

function factorFromLuke(food: LukeFoodRow | undefined): { source: "luke_kg" | "luke_g100" | "none"; value: number | null } {
  const kg = toNum(food?.kg_co2e_per_kg ?? null);
  if (kg !== null) return { source: "luke_kg", value: kg };

  // g/100g => kg/kg : g * 0.01
  const g = toNum(food?.g_co2e_per_100g ?? null);
  if (g !== null) return { source: "luke_g100", value: g * 0.01 };

  return { source: "none", value: null };
}

function resolveFactor(mapping: MappingRow | undefined, food: LukeFoodRow | undefined): {
  source: "override" | "luke_kg" | "luke_g100" | "none";
  value: number | null;
} {
  const ov = toNum(mapping?.co2_override_per_kg ?? null);
  if (ov !== null) return { source: "override", value: ov };
  return factorFromLuke(food);
}

function normalizeComponentShares(components: DishComponentRow[]): { shares: number[]; note: string } {
  // Return per-component fractional shares that sum to ~1.
  const provided = components.map((c) => {
    const v = toNum(c.plate_share);
    if (v === null) return null;
    return clamp(v, 0, 1);
  });

  const sumProvided = provided.reduce<number>((acc, v) => acc + (v ?? 0), 0);

  // No shares => equal split
  if (sumProvided <= 0) {
    const eq = 1 / components.length;
    return { shares: components.map(() => eq), note: "no plate_share provided => equal split" };
  }

  // Fill missing with remainder if possible
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

  // Normalize if close or overweighted
  if (sumFinal > 0 && Math.abs(sumFinal - 1) <= PLATE_SHARE_NORMALIZE_EPS) {
    shares = shares.map((s) => s / sumFinal);
    return { shares, note: `plate_share normalized (sum=${sumFinal.toFixed(3)})` };
  }
  if (sumFinal > 1) {
    shares = shares.map((s) => s / sumFinal);
    return { shares, note: `plate_share overweight => normalized (sum=${sumFinal.toFixed(3)})` };
  }

  return { shares, note: `plate_share used as-is (sum=${sumFinal.toFixed(3)})` };
}

async function loadDonation(donationId: number): Promise<DonationRow> {
  const { data, error } = await db
    .from("donations")
    .select("id, kitchen_id, dish_id, component_id, donated_weight_kg, donated_at")
    .eq("id", donationId)
    .single();

  if (error || !data) throw new Error(`Donation ${donationId} not found: ${error?.message ?? "no row"}`);

  return {
    id: Number(data.id),
    kitchen_id: data.kitchen_id ?? null,
    dish_id: data.dish_id == null ? null : Number(data.dish_id),
    component_id: data.component_id == null ? null : Number(data.component_id),
    donated_weight_kg: Number(data.donated_weight_kg),
    donated_at: data.donated_at ?? null,
  };
}

async function loadDishComponents(dishId: number): Promise<DishComponentRow[]> {
  const { data, error } = await db
    .from("dish_components")
    .select("id, dish_id, name_raw, component_type, plate_share")
    .eq("dish_id", dishId)
    .order("id", { ascending: true });

  if (error) throw new Error(`Error loading dish_components: ${error.message}`);

  return (data || []).map((r: any) => ({
    id: Number(r.id),
    dish_id: Number(r.dish_id),
    name_raw: r.name_raw ?? null,
    component_type: r.component_type ?? null,
    plate_share: r.plate_share == null ? null : Number(r.plate_share),
  }));
}

async function loadComponentIngredients(componentIds: number[]): Promise<ComponentIngredientRow[]> {
  if (!componentIds.length) return [];

  const { data, error } = await db
    .from("component_ingredients")
    .select(
      "component_id, seq_no, ingredient_raw, base_name, description, ingredient_core, share_of_component, share_source, is_water, is_salt"
    )
    .in("component_id", componentIds);

  if (error) throw new Error(`Error loading component_ingredients: ${error.message}`);

  return (data || []).map((r: any) => ({
    component_id: Number(r.component_id),
    seq_no: r.seq_no == null ? null : Number(r.seq_no),
    ingredient_raw: r.ingredient_raw ?? null,
    base_name: r.base_name ?? null,
    description: r.description ?? null,
    ingredient_core: String(r.ingredient_core),
    share_of_component: r.share_of_component == null ? null : Number(r.share_of_component),
    share_source: r.share_source ?? null,
    is_water: Boolean(r.is_water),
    is_salt: Boolean(r.is_salt),
  }));
}

async function loadMappings(cores: string[]): Promise<Map<string, MappingRow>> {
  if (!cores.length) return new Map();

  const { data, error } = await db
    .from("ingredient_mappings")
    .select("ingredient_core, luke_foodid, match_type, weight_state, yield_cooked_per_raw, co2_override_per_kg")
    .eq("source_system", SOURCE_SYSTEM)
    .eq("is_active", true)
    .in("ingredient_core", cores);

  if (error) throw new Error(`Error loading ingredient_mappings: ${error.message}`);

  const map = new Map<string, MappingRow>();
  for (const m of (data || []) as any[]) {
    map.set(String(m.ingredient_core), {
      ingredient_core: String(m.ingredient_core),
      luke_foodid: m.luke_foodid == null ? null : Number(m.luke_foodid),
      match_type: m.match_type ?? null,
      weight_state: m.weight_state ?? null,
      yield_cooked_per_raw: toNum(m.yield_cooked_per_raw),
      co2_override_per_kg: toNum(m.co2_override_per_kg),
    });
  }
  return map;
}

async function loadLukeFoods(foodids: number[]): Promise<Map<number, LukeFoodRow>> {
  if (!foodids.length) return new Map();

  const { data, error } = await db
    .from("luke_foods")
    .select("foodid, name_fi, name_en, kg_co2e_per_kg, g_co2e_per_100g")
    .in("foodid", foodids);

  if (error) throw new Error(`Error loading luke_foods: ${error.message}`);

  const map = new Map<number, LukeFoodRow>();
  for (const f of (data || []) as any[]) {
    map.set(Number(f.foodid), {
      foodid: Number(f.foodid),
      name_fi: f.name_fi ?? null,
      name_en: f.name_en ?? null,
      kg_co2e_per_kg: toNum(f.kg_co2e_per_kg),
      g_co2e_per_100g: toNum(f.g_co2e_per_100g),
    });
  }
  return map;
}

async function main() {
  const donationId = Number(getArg("--donation-id"));
  const asJson = hasFlag("--json");

  if (!Number.isFinite(donationId) || donationId <= 0) {
    throw new Error("Usage: npx ts-node src/inspectDonationBreakdown.ts --donation-id <number> [--json]");
  }

  const donation = await loadDonation(donationId);

  const donatedWeightKg = donation.donated_weight_kg;
  if (!Number.isFinite(donatedWeightKg) || donatedWeightKg <= 0) {
    throw new Error(`Donation ${donationId} has invalid donated_weight_kg`);
  }

  // Determine which components + their allocated weights
  let allocations: Array<{
    component: DishComponentRow;
    component_weight_kg: number;
    plate_share_note: string;
  }> = [];

  if (donation.component_id != null) {
    // Component donation: look up that component row (may not exist if deleted)
    const { data, error } = await db
      .from("dish_components")
      .select("id, dish_id, name_raw, component_type, plate_share")
      .eq("id", donation.component_id)
      .single();

    if (error || !data) {
      allocations = [
        {
          component: {
            id: donation.component_id,
            dish_id: donation.dish_id ?? -1,
            name_raw: "(missing dish_components row)",
            component_type: null,
            plate_share: null,
          },
          component_weight_kg: donatedWeightKg,
          plate_share_note: "component donation => 100%",
        },
      ];
    } else {
      const c: DishComponentRow = {
        id: Number(data.id),
        dish_id: Number(data.dish_id),
        name_raw: data.name_raw ?? null,
        component_type: data.component_type ?? null,
        plate_share: data.plate_share == null ? null : Number(data.plate_share),
      };

      allocations = [{ component: c, component_weight_kg: donatedWeightKg, plate_share_note: "component donation => 100%" }];
    }
  } else {
    if (donation.dish_id == null) throw new Error(`Donation ${donationId} has neither dish_id nor component_id`);

    const comps = await loadDishComponents(donation.dish_id);
    if (!comps.length) {
      console.log(`[WARN] dish_id=${donation.dish_id} has no dish_components. Everything is unmapped.`);
      const out = {
        donation,
        totals: {
          total_co2e_kg: 0,
          total_food_mass_kg: donatedWeightKg,
          mapped_mass_kg: 0,
          ignored_mass_kg: 0,
          unmapped_mass_kg: donatedWeightKg,
        },
        rows: [] as BreakdownRow[],
      };
      console.log(asJson ? JSON.stringify(out, null, 2) : out);
      return;
    }

    const { shares, note } = normalizeComponentShares(comps);
    allocations = comps.map((c, i) => ({
      component: c,
      component_weight_kg: donatedWeightKg * shares[i],
      plate_share_note: note,
    }));
  }

  const componentIds = allocations.map((a) => a.component.id);
  const compIngredientsAll = await loadComponentIngredients(componentIds);

  // Collect cores
  const cores = Array.from(new Set(compIngredientsAll.map((r) => r.ingredient_core)));
  const mappings = await loadMappings(cores);

  const foodids = Array.from(
    new Set(
      Array.from(mappings.values())
        .map((m) => m.luke_foodid)
        .filter((id) => id !== null && id !== undefined)
        .map((id) => Number(id))
        .filter((id) => Number.isFinite(id))
    )
  );
  const lukeFoods = await loadLukeFoods(foodids);

  const rows: BreakdownRow[] = [];
  let totalCo2 = 0;
  let mappedMass = 0;
  let ignoredMass = 0;
  let unmappedMass = 0;

  for (const alloc of allocations) {
    const componentId = alloc.component.id;
    const componentName = (alloc.component.name_raw || "").trim() || `component#${componentId}`;
    const componentType = alloc.component.component_type ?? null;
    const componentWeightKg = alloc.component_weight_kg;

    const compIngs = compIngredientsAll
      .filter((r) => r.component_id === componentId)
      .sort((a, b) => (a.seq_no ?? 9999) - (b.seq_no ?? 9999));

    if (!compIngs.length) {
      // No ingredient rows => whole component unmapped
      rows.push({
        component_id: componentId,
        component_name: componentName,
        component_type: componentType,
        component_weight_kg: componentWeightKg,
        ingredient_core: "NO_COMPONENT_INGREDIENTS",
        base_name: "NO_COMPONENT_INGREDIENTS",
        share_pct: null,
        cooked_mass_kg: componentWeightKg,
        status: "unmapped",
        reason: "no component_ingredients rows",
        luke_foodid: null,
        luke_name_fi: null,
        luke_name_en: null,
        match_type: null,
        weight_state: null,
        yield_cooked_per_raw: null,
        factor_source: "none",
        factor_kgco2_per_kg: null,
        mass_for_factor_kg: 0,
        co2e_kg: 0,
      });
      unmappedMass += componentWeightKg;
      continue;
    }

    // Compute ingredient share normalization
    const sharePctByRow = compIngs.map((r) => {
      const v = toNum(r.share_of_component);
      if (v === null) return null;
      return clamp(v, 0, 100);
    });

    const sumPct = sumNums(sharePctByRow.map((v) => (v == null ? 0 : v)));
    if (sumPct <= 0) {
      // whole component unmapped (no usable shares)
      rows.push({
        component_id: componentId,
        component_name: componentName,
        component_type: componentType,
        component_weight_kg: componentWeightKg,
        ingredient_core: "NO_SHARES_PROVIDED",
        base_name: "NO_SHARES_PROVIDED",
        share_pct: null,
        cooked_mass_kg: componentWeightKg,
        status: "unmapped",
        reason: "share_of_component missing for all rows",
        luke_foodid: null,
        luke_name_fi: null,
        luke_name_en: null,
        match_type: null,
        weight_state: null,
        yield_cooked_per_raw: null,
        factor_source: "none",
        factor_kgco2_per_kg: null,
        mass_for_factor_kg: 0,
        co2e_kg: 0,
      });
      unmappedMass += componentWeightKg;
      continue;
    }

    let normFactor = 1;
    if (Math.abs(sumPct - 100) <= ING_SHARE_NORMALIZE_EPS) {
      normFactor = 100 / sumPct;
    }

    const allocatedFrac = clamp((sumPct * normFactor) / 100, 0, 1);
    const unallocatedKg = normFactor === 1 ? componentWeightKg * (1 - allocatedFrac) : 0;

    for (let i = 0; i < compIngs.length; i++) {
      const ing = compIngs[i];
      const pctRaw = sharePctByRow[i];
      const baseName = (ing.base_name || "").trim() || ing.ingredient_core;

      // rows without share do not get a mass; remainder bucket covers them if applicable
      if (pctRaw == null) {
        rows.push({
          component_id: componentId,
          component_name: componentName,
          component_type: componentType,
          component_weight_kg: componentWeightKg,
          ingredient_core: ing.ingredient_core,
          base_name: baseName,
          share_pct: null,
          cooked_mass_kg: 0,
          status: "unmapped",
          reason: "missing share_of_component (mass accounted in remainder if any)",
          luke_foodid: null,
          luke_name_fi: null,
          luke_name_en: null,
          match_type: null,
          weight_state: null,
          yield_cooked_per_raw: null,
          factor_source: "none",
          factor_kgco2_per_kg: null,
          mass_for_factor_kg: 0,
          co2e_kg: 0,
        });
        continue;
      }

      const pct = pctRaw * normFactor;
      const frac = clamp(pct / 100, 0, 1);
      const cookedKg = componentWeightKg * frac;

      // Ignore rules
      if (ing.is_water) {
        ignoredMass += cookedKg;
        rows.push({
          component_id: componentId,
          component_name: componentName,
          component_type: componentType,
          component_weight_kg: componentWeightKg,
          ingredient_core: ing.ingredient_core,
          base_name: baseName,
          share_pct: pct,
          cooked_mass_kg: cookedKg,
          status: "ignored",
          reason: "is_water=true",
          luke_foodid: null,
          luke_name_fi: null,
          luke_name_en: null,
          match_type: null,
          weight_state: null,
          yield_cooked_per_raw: null,
          factor_source: "none",
          factor_kgco2_per_kg: null,
          mass_for_factor_kg: 0,
          co2e_kg: 0,
        });
        continue;
      }

      if (ing.is_salt) {
        ignoredMass += cookedKg;
        rows.push({
          component_id: componentId,
          component_name: componentName,
          component_type: componentType,
          component_weight_kg: componentWeightKg,
          ingredient_core: ing.ingredient_core,
          base_name: baseName,
          share_pct: pct,
          cooked_mass_kg: cookedKg,
          status: "ignored",
          reason: "is_salt=true",
          luke_foodid: null,
          luke_name_fi: null,
          luke_name_en: null,
          match_type: null,
          weight_state: null,
          yield_cooked_per_raw: null,
          factor_source: "none",
          factor_kgco2_per_kg: null,
          mass_for_factor_kg: 0,
          co2e_kg: 0,
        });
        continue;
      }

      if (frac < MIN_SHARE_FRAC) {
        ignoredMass += cookedKg;
        rows.push({
          component_id: componentId,
          component_name: componentName,
          component_type: componentType,
          component_weight_kg: componentWeightKg,
          ingredient_core: ing.ingredient_core,
          base_name: baseName,
          share_pct: pct,
          cooked_mass_kg: cookedKg,
          status: "ignored",
          reason: `below threshold (${(MIN_SHARE_FRAC * 100).toFixed(0)}%)`,
          luke_foodid: null,
          luke_name_fi: null,
          luke_name_en: null,
          match_type: null,
          weight_state: null,
          yield_cooked_per_raw: null,
          factor_source: "none",
          factor_kgco2_per_kg: null,
          mass_for_factor_kg: 0,
          co2e_kg: 0,
        });
        continue;
      }

      // Mapping lookup
      const mapping = mappings.get(ing.ingredient_core);

      if (!mapping) {
        unmappedMass += cookedKg;
        rows.push({
          component_id: componentId,
          component_name: componentName,
          component_type: componentType,
          component_weight_kg: componentWeightKg,
          ingredient_core: ing.ingredient_core,
          base_name: baseName,
          share_pct: pct,
          cooked_mass_kg: cookedKg,
          status: "unmapped",
          reason: "no ingredient_mappings row",
          luke_foodid: null,
          luke_name_fi: null,
          luke_name_en: null,
          match_type: null,
          weight_state: null,
          yield_cooked_per_raw: null,
          factor_source: "none",
          factor_kgco2_per_kg: null,
          mass_for_factor_kg: 0,
          co2e_kg: 0,
        });
        continue;
      }

      const weightState = (mapping.weight_state || "ignore").toLowerCase();

      if (weightState === "ignore") {
        ignoredMass += cookedKg;
        rows.push({
          component_id: componentId,
          component_name: componentName,
          component_type: componentType,
          component_weight_kg: componentWeightKg,
          ingredient_core: ing.ingredient_core,
          base_name: baseName,
          share_pct: pct,
          cooked_mass_kg: cookedKg,
          status: "ignored",
          reason: "mapping weight_state=ignore",
          luke_foodid: mapping.luke_foodid,
          luke_name_fi: null,
          luke_name_en: null,
          match_type: mapping.match_type,
          weight_state: mapping.weight_state,
          yield_cooked_per_raw: mapping.yield_cooked_per_raw,
          factor_source: "none",
          factor_kgco2_per_kg: null,
          mass_for_factor_kg: 0,
          co2e_kg: 0,
        });
        continue;
      }

      const food = mapping.luke_foodid != null ? lukeFoods.get(mapping.luke_foodid) : undefined;
      const factor = resolveFactor(mapping, food);

      if (factor.value === null) {
        unmappedMass += cookedKg;
        rows.push({
          component_id: componentId,
          component_name: componentName,
          component_type: componentType,
          component_weight_kg: componentWeightKg,
          ingredient_core: ing.ingredient_core,
          base_name: baseName,
          share_pct: pct,
          cooked_mass_kg: cookedKg,
          status: "unmapped",
          reason: "no CO2 factor (no override and LUKE factor missing)",
          luke_foodid: mapping.luke_foodid,
          luke_name_fi: food?.name_fi ?? null,
          luke_name_en: food?.name_en ?? null,
          match_type: mapping.match_type,
          weight_state: mapping.weight_state,
          yield_cooked_per_raw: mapping.yield_cooked_per_raw,
          factor_source: "none",
          factor_kgco2_per_kg: null,
          mass_for_factor_kg: 0,
          co2e_kg: 0,
        });
        continue;
      }

      // Raw conversion if necessary
      let massForFactorKg = cookedKg;
      if (weightState === "raw") {
        const y = mapping.yield_cooked_per_raw;
        if (y != null && y > 0) {
          massForFactorKg = cookedKg / y;
        } else {
          unmappedMass += cookedKg;
          rows.push({
            component_id: componentId,
            component_name: componentName,
            component_type: componentType,
            component_weight_kg: componentWeightKg,
            ingredient_core: ing.ingredient_core,
            base_name: baseName,
            share_pct: pct,
            cooked_mass_kg: cookedKg,
            status: "unmapped",
            reason: "weight_state=raw but yield_cooked_per_raw missing/invalid",
            luke_foodid: mapping.luke_foodid,
            luke_name_fi: food?.name_fi ?? null,
            luke_name_en: food?.name_en ?? null,
            match_type: mapping.match_type,
            weight_state: mapping.weight_state,
            yield_cooked_per_raw: mapping.yield_cooked_per_raw,
            factor_source: factor.source,
            factor_kgco2_per_kg: factor.value,
            mass_for_factor_kg: 0,
            co2e_kg: 0,
          });
          continue;
        }
      }

      const co2 = massForFactorKg * factor.value;

      mappedMass += cookedKg;
      totalCo2 += co2;

      rows.push({
        component_id: componentId,
        component_name: componentName,
        component_type: componentType,
        component_weight_kg: componentWeightKg,
        ingredient_core: ing.ingredient_core,
        base_name: baseName,
        share_pct: pct,
        cooked_mass_kg: cookedKg,
        status: "mapped",
        reason: "ok",
        luke_foodid: mapping.luke_foodid,
        luke_name_fi: food?.name_fi ?? null,
        luke_name_en: food?.name_en ?? null,
        match_type: mapping.match_type,
        weight_state: mapping.weight_state,
        yield_cooked_per_raw: mapping.yield_cooked_per_raw,
        factor_source: factor.source,
        factor_kgco2_per_kg: factor.value,
        mass_for_factor_kg: massForFactorKg,
        co2e_kg: co2,
      });
    }

    // Remainder bucket (if not normalizing)
    if (unallocatedKg > 1e-9) {
      unmappedMass += unallocatedKg;
      rows.push({
        component_id: componentId,
        component_name: componentName,
        component_type: componentType,
        component_weight_kg: componentWeightKg,
        ingredient_core: "UNALLOCATED_REMAINDER",
        base_name: "UNALLOCATED_REMAINDER",
        share_pct: null,
        cooked_mass_kg: unallocatedKg,
        status: "unmapped",
        reason: "component shares < 100 and no normalization => remainder unmapped",
        luke_foodid: null,
        luke_name_fi: null,
        luke_name_en: null,
        match_type: null,
        weight_state: null,
        yield_cooked_per_raw: null,
        factor_source: "none",
        factor_kgco2_per_kg: null,
        mass_for_factor_kg: 0,
        co2e_kg: 0,
      });
    }
  }

  const out = {
    donation,
    mapping_source_system: SOURCE_SYSTEM,
    totals: {
      total_co2e_kg: totalCo2,
      total_food_mass_kg: donatedWeightKg,
      mapped_mass_kg: mappedMass,
      ignored_mass_kg: ignoredMass,
      unmapped_mass_kg: unmappedMass,
      co2_per_kg: donatedWeightKg > 0 ? totalCo2 / donatedWeightKg : 0,
    },
    component_allocations: allocations.map((a) => ({
      component_id: a.component.id,
      name_raw: a.component.name_raw,
      component_type: a.component.component_type,
      plate_share: a.component.plate_share,
      component_weight_kg: a.component_weight_kg,
      note: a.plate_share_note,
    })),
    rows,
  };

  if (asJson) {
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  console.log("=== Donation breakdown ===");
  console.log(`donation_id=${donation.id} source_system=${SOURCE_SYSTEM} weight_kg=${donatedWeightKg}`);
  console.log("Component allocations:");
  console.table(out.component_allocations);

  console.log("Totals:");
  console.table([out.totals]);

  // Print a compact table of rows (most useful columns)
  const compact = rows.map((r) => ({
    component_id: r.component_id,
    component_name: r.component_name,
    component_type: r.component_type,
    ingredient_core: r.ingredient_core,
    base_name: r.base_name,
    share_pct: r.share_pct == null ? null : Number(r.share_pct.toFixed(2)),
    cooked_mass_kg: Number(r.cooked_mass_kg.toFixed(4)),
    status: r.status,
    reason: r.reason,
    luke_foodid: r.luke_foodid,
    factor_source: r.factor_source,
    factor_kgco2_per_kg: r.factor_kgco2_per_kg == null ? null : Number(r.factor_kgco2_per_kg.toFixed(4)),
    mass_for_factor_kg: Number(r.mass_for_factor_kg.toFixed(4)),
    co2e_kg: Number(r.co2e_kg.toFixed(6)),
  }));

  console.log("Rows (compact):");
  console.table(compact);
}

main().catch((e) => {
  console.error("[FAIL]", e?.message || e);
  process.exit(1);
});
