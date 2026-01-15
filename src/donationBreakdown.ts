import { db } from "./dbClient";

const MIN_SHARE_FRAC = 0.10; // ignore ingredient shares < 10% of component
const PLATE_SHARE_NORMALIZE_EPS = 0.03; // normalize if sum close to 1
const ING_SHARE_NORMALIZE_EPS = 5; // normalize if sum close to 100 (percentage points)
const ING_SHARE_MAX_OVER_EPS = 0.5; // hard error if shares exceed 100% by more than this

const SOURCE_SYSTEM = process.env.MAPPING_SOURCE_SYSTEM || "SODEXO";

type DonationRow = {
  id: number;
  kitchen_id: string | null;
  dish_id: number | null;
  component_id: number | null;
  donated_weight_kg: number;
  donated_at: string | null;
};

type DishRow = {
  id: number;
  restaurant_id: string;
  menu_date: string;
  title_fi: string | null;
  title_en: string | null;
  category: string | null;
};

type RestaurantRow = {
  id: string;
  branch_name?: string | null;
  city?: string | null;
  source_system?: string | null;
};

type DishComponentRow = {
  id: number;
  dish_id: number;
  name_raw: string | null;
  component_type: string | null;
  plate_share: number | null;
  ingredients_raw?: string | null;
};

type ComponentIngredientRow = {
  component_id: number;
  seq_no: number | null;
  ingredient_raw: string | null;
  base_name: string | null;
  ingredient_core: string;
  share_of_component: number | null; // 0..100
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

function resolveFactor(mapping: MappingRow | undefined, food: LukeFoodRow | undefined): { source: string; value: number | null } {
  const ov = toNum(mapping?.co2_override_per_kg ?? null);
  if (ov !== null) return { source: "override", value: ov };

  const kg = toNum(food?.kg_co2e_per_kg ?? null);
  if (kg !== null) return { source: "luke_kg", value: kg };

  // g/100g => kg/kg : g * 0.01
  const g = toNum(food?.g_co2e_per_100g ?? null);
  if (g !== null) return { source: "luke_g100", value: g * 0.01 };

  return { source: "none", value: null };
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
  if (sumFinal > 1 + PLATE_SHARE_NORMALIZE_EPS) {
    throw new Error(`dish_id=${components[0]?.dish_id ?? "?"} plate_share sum exceeds 1.0 (sum=${sumFinal.toFixed(4)})`);
  }
  if (sumFinal > 0 && Math.abs(sumFinal - 1) <= PLATE_SHARE_NORMALIZE_EPS) {
    shares = shares.map((s) => s / sumFinal);
  }

  return shares;
}

export type BreakdownStatus = "mapped" | "unmapped" | "ignored";

export type BreakdownItem = {
  status: BreakdownStatus;
  reason: string;

  component_id: number;
  component_name: string;
  component_type: string | null;
  component_weight_kg: number;

  ingredient_core: string;
  base_name: string;
  share_pct: number | null;
  cooked_mass_kg: number;

  luke_foodid: number | null;
  luke_name_fi: string | null;
  luke_name_en: string | null;
  factor_source: string;
  factor_kgco2_per_kg: number | null;
  mass_for_factor_kg: number;
  co2e_kg: number;
};

export type DonationBreakdown = {
  donation: DonationRow;
  restaurant: { id: string; label: string } | null;
  dish: DishRow | null;
  mapping_source_system: string;
  totals: {
    total_food_mass_kg: number;
    total_co2e_kg: number;
    co2_per_kg: number;
    mapped_mass_kg: number;
    unmapped_mass_kg: number;
    ignored_mass_kg: number;
  };
  items: BreakdownItem[];
};

async function loadDonation(donationId: number): Promise<DonationRow> {
  const { data, error } = await db
    .from("donations")
    .select("id, kitchen_id, dish_id, component_id, donated_weight_kg, donated_at")
    .eq("id", donationId)
    .single();

  if (error || !data) throw new Error(`Donation ${donationId} not found: ${error?.message ?? "no row"}`);

  return {
    id: Number((data as any).id),
    kitchen_id: (data as any).kitchen_id ?? null,
    dish_id: (data as any).dish_id == null ? null : Number((data as any).dish_id),
    component_id: (data as any).component_id == null ? null : Number((data as any).component_id),
    donated_weight_kg: Number((data as any).donated_weight_kg),
    donated_at: (data as any).donated_at ?? null,
  };
}

async function loadDish(dishId: number): Promise<DishRow | null> {
  const { data, error } = await db
    .from("dishes")
    .select("id, restaurant_id, menu_date, title_fi, title_en, category")
    .eq("id", dishId)
    .maybeSingle();
  if (error) throw new Error(`Failed to load dish: ${error.message}`);
  if (!data) return null;

  return {
    id: Number((data as any).id),
    restaurant_id: String((data as any).restaurant_id),
    menu_date: String((data as any).menu_date),
    title_fi: (data as any).title_fi ?? null,
    title_en: (data as any).title_en ?? null,
    category: (data as any).category ?? null,
  };
}

async function loadRestaurant(restaurantId: string): Promise<{ id: string; label: string } | null> {
  // schema variant A: branch_name/city/source_system
  const a = await db.from("restaurants").select("id, branch_name, city, source_system").eq("id", restaurantId).maybeSingle();
  if (!a.error && a.data) {
    const r = a.data as any as RestaurantRow;
    const primary = (r.branch_name ? String(r.branch_name) : "") || restaurantId;
    const suffix = [r.city ? String(r.city) : null, r.source_system ? String(r.source_system) : null].filter(Boolean).join(" • ");
    return { id: restaurantId, label: suffix ? `${primary} (${suffix})` : primary };
  }

  // schema variant B: name
  const b = await db.from("restaurants").select("id, name").eq("id", restaurantId).maybeSingle();
  if (!b.error && b.data) {
    const nm = String((b.data as any).name || restaurantId);
    return { id: restaurantId, label: nm };
  }

  return null;
}

async function loadDishComponents(dishId: number): Promise<DishComponentRow[]> {
  const { data, error } = await db
    .from("dish_components")
    .select("id, dish_id, name_raw, component_type, plate_share, ingredients_raw")
    .eq("dish_id", dishId)
    .order("id", { ascending: true });

  if (error) throw new Error(`Error loading dish_components: ${error.message}`);

  return (data || []).map((r: any) => ({
    id: Number(r.id),
    dish_id: Number(r.dish_id),
    name_raw: r.name_raw ?? null,
    component_type: r.component_type ?? null,
    plate_share: r.plate_share == null ? null : Number(r.plate_share),
    ingredients_raw: r.ingredients_raw == null ? null : String(r.ingredients_raw),
  }));
}

async function loadComponentIngredients(componentIds: number[]): Promise<ComponentIngredientRow[]> {
  if (!componentIds.length) return [];

  const { data, error } = await db
    .from("component_ingredients")
    .select("component_id, seq_no, ingredient_raw, base_name, ingredient_core, share_of_component, is_water, is_salt")
    .in("component_id", componentIds);

  if (error) throw new Error(`Error loading component_ingredients: ${error.message}`);

  return (data || []).map((r: any) => ({
    component_id: Number(r.component_id),
    seq_no: r.seq_no == null ? null : Number(r.seq_no),
    ingredient_raw: r.ingredient_raw ?? null,
    base_name: r.base_name ?? null,
    ingredient_core: String(r.ingredient_core),
    share_of_component: r.share_of_component == null ? null : Number(r.share_of_component),
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

export async function computeDonationBreakdown(donationId: number): Promise<DonationBreakdown> {
  const donation = await loadDonation(donationId);

  const donatedWeightKg = donation.donated_weight_kg;
  if (!Number.isFinite(donatedWeightKg) || donatedWeightKg <= 0) {
    throw new Error(`Donation ${donationId} has invalid donated_weight_kg`);
  }

  const dish = donation.dish_id != null ? await loadDish(donation.dish_id) : null;
  const restaurantId = dish?.restaurant_id ?? donation.kitchen_id ?? null;
  const restaurant = restaurantId ? await loadRestaurant(String(restaurantId)) : null;

  // Determine component allocations
  let allocations: Array<{
    component: DishComponentRow;
    component_weight_kg: number;
    used_component_fallback: boolean;
  }> = [];

  if (donation.component_id != null) {
    const { data, error } = await db
      .from("dish_components")
      .select("id, dish_id, name_raw, component_type, plate_share, ingredients_raw")
      .eq("id", donation.component_id)
      .maybeSingle();

    if (error) throw new Error(`Failed to load dish_component ${donation.component_id}: ${error.message}`);

    const comp: DishComponentRow = data
      ? {
          id: Number((data as any).id),
          dish_id: Number((data as any).dish_id),
          name_raw: (data as any).name_raw ?? null,
          component_type: (data as any).component_type ?? null,
          plate_share: (data as any).plate_share == null ? null : Number((data as any).plate_share),
          ingredients_raw: (data as any).ingredients_raw == null ? null : String((data as any).ingredients_raw),
        }
      : {
          id: donation.component_id,
          dish_id: donation.dish_id ?? -1,
          name_raw: "(missing dish_components row)",
          component_type: null,
          plate_share: null,
          ingredients_raw: null,
        };

    allocations = [{ component: comp, component_weight_kg: donatedWeightKg, used_component_fallback: false }];
  } else {
    if (donation.dish_id == null) throw new Error(`Donation ${donationId} has neither dish_id nor component_id`);

    const comps = await loadDishComponents(donation.dish_id);
    if (!comps.length) {
      return {
        donation,
        restaurant,
        dish,
        mapping_source_system: SOURCE_SYSTEM,
        totals: {
          total_food_mass_kg: donatedWeightKg,
          total_co2e_kg: 0,
          co2_per_kg: 0,
          mapped_mass_kg: 0,
          ignored_mass_kg: 0,
          unmapped_mass_kg: donatedWeightKg,
        },
        items: [
          {
            status: "unmapped",
            reason: "dish has no dish_components rows",
            component_id: -1,
            component_name: "NO_COMPONENTS",
            component_type: null,
            component_weight_kg: donatedWeightKg,
            ingredient_core: "NO_COMPONENTS",
            base_name: "NO_COMPONENTS",
            share_pct: null,
            cooked_mass_kg: donatedWeightKg,
            luke_foodid: null,
            luke_name_fi: null,
            luke_name_en: null,
            factor_source: "none",
            factor_kgco2_per_kg: null,
            mass_for_factor_kg: 0,
            co2e_kg: 0,
          },
        ],
      };
    }

    const shares = normalizeComponentShares(comps);
    allocations = comps.map((c, i) => ({ component: c, component_weight_kg: donatedWeightKg * shares[i], used_component_fallback: false }));
  }

  const componentIds = allocations.map((a) => a.component.id);
  const allIngs = await loadComponentIngredients(componentIds);

  // Load mappings for:
  // - ingredient-level cores (from component_ingredients)
  // - component-level fallback cores (normalized from dish_components.name_raw) for components that have no ingredient rows
  const coresSet = new Set<string>(allIngs.map((r) => r.ingredient_core));
  const hasIngredientsForComponent = new Set<number>(allIngs.map((r) => r.component_id));
  for (const alloc of allocations) {
    if (hasIngredientsForComponent.has(alloc.component.id)) continue;
    const core = normalizeCoreFromName(String(alloc.component.name_raw || ""));
    if (core && core !== "UNKNOWN") coresSet.add(core);
  }

  const cores = Array.from(coresSet);
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

  const items: BreakdownItem[] = [];
  let totalCo2 = 0;
  let mappedMass = 0;
  let ignoredMass = 0;
  let unmappedMass = 0;

  for (const alloc of allocations) {
    const componentId = alloc.component.id;
    const componentName = (alloc.component.name_raw || "").trim() || `component#${componentId}`;
    const componentType = alloc.component.component_type ?? null;
    const componentWeightKg = alloc.component_weight_kg;

    const compIngs = allIngs
      .filter((r) => r.component_id === componentId)
      .sort((a, b) => (a.seq_no ?? 9999) - (b.seq_no ?? 9999));

    if (!compIngs.length) {
      // Component-level fallback: treat the whole component as one mappable "core" derived from name_raw.
      // We store these mappings in ingredient_mappings under the same source_system.
      const componentCore = normalizeCoreFromName(componentName);
      const mapping = componentCore ? mappings.get(componentCore) : undefined;
      const weightState = (mapping?.weight_state || "ignore").toLowerCase();

      if (!mapping) {
        unmappedMass += componentWeightKg;
        items.push({
          status: "unmapped",
          reason: "no component_ingredients rows; no component-name mapping",
          component_id: componentId,
          component_name: componentName,
          component_type: componentType,
          component_weight_kg: componentWeightKg,
          ingredient_core: componentCore || "UNKNOWN",
          base_name: componentName,
          share_pct: null,
          cooked_mass_kg: componentWeightKg,
          luke_foodid: null,
          luke_name_fi: null,
          luke_name_en: null,
          factor_source: "none",
          factor_kgco2_per_kg: null,
          mass_for_factor_kg: 0,
          co2e_kg: 0,
        });
        continue;
      }

      if (weightState === "ignore") {
        ignoredMass += componentWeightKg;
        items.push({
          status: "ignored",
          reason: "component-level fallback; mapping weight_state=ignore",
          component_id: componentId,
          component_name: componentName,
          component_type: componentType,
          component_weight_kg: componentWeightKg,
          ingredient_core: componentCore,
          base_name: componentName,
          share_pct: null,
          cooked_mass_kg: componentWeightKg,
          luke_foodid: mapping.luke_foodid,
          luke_name_fi: null,
          luke_name_en: null,
          factor_source: "none",
          factor_kgco2_per_kg: null,
          mass_for_factor_kg: 0,
          co2e_kg: 0,
        });
        continue;
      }

      const food = mapping.luke_foodid != null ? lukeFoods.get(mapping.luke_foodid) : undefined;
      const factor = resolveFactor(mapping, food);
      if (factor.value == null) {
        unmappedMass += componentWeightKg;
        items.push({
          status: "unmapped",
          reason: "component-level fallback; no CO2 factor",
          component_id: componentId,
          component_name: componentName,
          component_type: componentType,
          component_weight_kg: componentWeightKg,
          ingredient_core: componentCore,
          base_name: componentName,
          share_pct: null,
          cooked_mass_kg: componentWeightKg,
          luke_foodid: mapping.luke_foodid,
          luke_name_fi: food?.name_fi ?? null,
          luke_name_en: food?.name_en ?? null,
          factor_source: "none",
          factor_kgco2_per_kg: null,
          mass_for_factor_kg: 0,
          co2e_kg: 0,
        });
        continue;
      }

      let massForFactorKg = componentWeightKg;
      if (weightState === "raw") {
        const y = mapping.yield_cooked_per_raw;
        if (y != null && y > 0) massForFactorKg = componentWeightKg / y;
        else {
          unmappedMass += componentWeightKg;
          items.push({
            status: "unmapped",
            reason: "component-level fallback; weight_state=raw but yield missing/invalid",
            component_id: componentId,
            component_name: componentName,
            component_type: componentType,
            component_weight_kg: componentWeightKg,
            ingredient_core: componentCore,
            base_name: componentName,
            share_pct: null,
            cooked_mass_kg: componentWeightKg,
            luke_foodid: mapping.luke_foodid,
            luke_name_fi: food?.name_fi ?? null,
            luke_name_en: food?.name_en ?? null,
            factor_source: factor.source,
            factor_kgco2_per_kg: factor.value,
            mass_for_factor_kg: 0,
            co2e_kg: 0,
          });
          continue;
        }
      }

      const co2 = massForFactorKg * factor.value;
      mappedMass += componentWeightKg;
      totalCo2 += co2;
      items.push({
        status: "mapped",
        reason: "component-level fallback (no ingredient breakdown)",
        component_id: componentId,
        component_name: componentName,
        component_type: componentType,
        component_weight_kg: componentWeightKg,
        ingredient_core: componentCore,
        base_name: componentName,
        share_pct: null,
        cooked_mass_kg: componentWeightKg,
        luke_foodid: mapping.luke_foodid,
        luke_name_fi: food?.name_fi ?? null,
        luke_name_en: food?.name_en ?? null,
        factor_source: factor.source,
        factor_kgco2_per_kg: factor.value,
        mass_for_factor_kg: massForFactorKg,
        co2e_kg: co2,
      });
      continue;
    }

    const sharePctByRow = compIngs.map((r) => {
      const v = toNum(r.share_of_component);
      if (v === null) return null;
      return clamp(v, 0, 100);
    });

    const hasMissingShare = sharePctByRow.some((v) => v == null);
    const sumPct = sumNums(sharePctByRow.map((v) => (v == null ? 0 : v)));
    if (sumPct <= 0) {
      unmappedMass += componentWeightKg;
      items.push({
        status: "unmapped",
        reason: "share_of_component missing for all rows",
        component_id: componentId,
        component_name: componentName,
        component_type: componentType,
        component_weight_kg: componentWeightKg,
        ingredient_core: "NO_SHARES_PROVIDED",
        base_name: "NO_SHARES_PROVIDED",
        share_pct: null,
        cooked_mass_kg: componentWeightKg,
        luke_foodid: null,
        luke_name_fi: null,
        luke_name_en: null,
        factor_source: "none",
        factor_kgco2_per_kg: null,
        mass_for_factor_kg: 0,
        co2e_kg: 0,
      });
      continue;
    }

    let normFactor = 1;
    if (sumPct > 100 + ING_SHARE_MAX_OVER_EPS) {
      throw new Error(
        `component_id=${componentId} ingredient share_of_component sum exceeds 100% (sum=${sumPct.toFixed(2)}). Fix parsing/data.`
      );
    }

    // Only normalize if close to 100 AND there are no missing shares.
    // If any share is NULL, remainder must stay as unmapped (unallocated remainder).
    if (!hasMissingShare && Math.abs(sumPct - 100) <= ING_SHARE_NORMALIZE_EPS) {
      normFactor = 100 / sumPct;
    }

    const allocatedFrac = clamp((sumPct * normFactor) / 100, 0, 1);
    const unallocatedKg = normFactor === 1 ? componentWeightKg * (1 - allocatedFrac) : 0;

    for (let i = 0; i < compIngs.length; i++) {
      const ing = compIngs[i];
      const pctRaw = sharePctByRow[i];
      const baseName = (ing.base_name || "").trim() || ing.ingredient_core;

      if (pctRaw == null) {
        // Missing share; mass accounted via UNALLOCATED_REMAINDER item below
        items.push({
          status: "unmapped",
          reason: "missing share_of_component (mass accounted in unallocated remainder if any)",
          component_id: componentId,
          component_name: componentName,
          component_type: componentType,
          component_weight_kg: componentWeightKg,
          ingredient_core: ing.ingredient_core,
          base_name: baseName,
          share_pct: null,
          cooked_mass_kg: 0,
          luke_foodid: null,
          luke_name_fi: null,
          luke_name_en: null,
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

      // Ignore rules (your definition)
      if (ing.is_water) {
        ignoredMass += cookedKg;
        items.push({
          status: "ignored",
          reason: "water",
          component_id: componentId,
          component_name: componentName,
          component_type: componentType,
          component_weight_kg: componentWeightKg,
          ingredient_core: ing.ingredient_core,
          base_name: baseName,
          share_pct: pct,
          cooked_mass_kg: cookedKg,
          luke_foodid: null,
          luke_name_fi: null,
          luke_name_en: null,
          factor_source: "none",
          factor_kgco2_per_kg: null,
          mass_for_factor_kg: 0,
          co2e_kg: 0,
        });
        continue;
      }

      if (ing.is_salt) {
        ignoredMass += cookedKg;
        items.push({
          status: "ignored",
          reason: "salt",
          component_id: componentId,
          component_name: componentName,
          component_type: componentType,
          component_weight_kg: componentWeightKg,
          ingredient_core: ing.ingredient_core,
          base_name: baseName,
          share_pct: pct,
          cooked_mass_kg: cookedKg,
          luke_foodid: null,
          luke_name_fi: null,
          luke_name_en: null,
          factor_source: "none",
          factor_kgco2_per_kg: null,
          mass_for_factor_kg: 0,
          co2e_kg: 0,
        });
        continue;
      }

      if (frac < MIN_SHARE_FRAC) {
        ignoredMass += cookedKg;
        items.push({
          status: "ignored",
          reason: `below ${Math.round(MIN_SHARE_FRAC * 100)}% threshold`,
          component_id: componentId,
          component_name: componentName,
          component_type: componentType,
          component_weight_kg: componentWeightKg,
          ingredient_core: ing.ingredient_core,
          base_name: baseName,
          share_pct: pct,
          cooked_mass_kg: cookedKg,
          luke_foodid: null,
          luke_name_fi: null,
          luke_name_en: null,
          factor_source: "none",
          factor_kgco2_per_kg: null,
          mass_for_factor_kg: 0,
          co2e_kg: 0,
        });
        continue;
      }

      const mapping = mappings.get(ing.ingredient_core);
      if (!mapping) {
        unmappedMass += cookedKg;
        items.push({
          status: "unmapped",
          reason: "no ingredient_mappings row",
          component_id: componentId,
          component_name: componentName,
          component_type: componentType,
          component_weight_kg: componentWeightKg,
          ingredient_core: ing.ingredient_core,
          base_name: baseName,
          share_pct: pct,
          cooked_mass_kg: cookedKg,
          luke_foodid: null,
          luke_name_fi: null,
          luke_name_en: null,
          factor_source: "none",
          factor_kgco2_per_kg: null,
          mass_for_factor_kg: 0,
          co2e_kg: 0,
        });
        continue;
      }

      const weightState = (mapping.weight_state || "ignore").toLowerCase();
      if (weightState === "ignore") {
        // carbonCalculator treats this as ignored; keep in ignored bucket (extra reason)
        ignoredMass += cookedKg;
        items.push({
          status: "ignored",
          reason: "mapping weight_state=ignore",
          component_id: componentId,
          component_name: componentName,
          component_type: componentType,
          component_weight_kg: componentWeightKg,
          ingredient_core: ing.ingredient_core,
          base_name: baseName,
          share_pct: pct,
          cooked_mass_kg: cookedKg,
          luke_foodid: mapping.luke_foodid,
          luke_name_fi: null,
          luke_name_en: null,
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
        items.push({
          status: "unmapped",
          reason: "no CO2 factor (no override and LUKE factor missing)",
          component_id: componentId,
          component_name: componentName,
          component_type: componentType,
          component_weight_kg: componentWeightKg,
          ingredient_core: ing.ingredient_core,
          base_name: baseName,
          share_pct: pct,
          cooked_mass_kg: cookedKg,
          luke_foodid: mapping.luke_foodid,
          luke_name_fi: food?.name_fi ?? null,
          luke_name_en: food?.name_en ?? null,
          factor_source: "none",
          factor_kgco2_per_kg: null,
          mass_for_factor_kg: 0,
          co2e_kg: 0,
        });
        continue;
      }

      let massForFactorKg = cookedKg;
      if (weightState === "raw") {
        const y = mapping.yield_cooked_per_raw;
        if (y != null && y > 0) {
          massForFactorKg = cookedKg / y;
        } else {
          unmappedMass += cookedKg;
          items.push({
            status: "unmapped",
            reason: "weight_state=raw but yield_cooked_per_raw missing/invalid",
            component_id: componentId,
            component_name: componentName,
            component_type: componentType,
            component_weight_kg: componentWeightKg,
            ingredient_core: ing.ingredient_core,
            base_name: baseName,
            share_pct: pct,
            cooked_mass_kg: cookedKg,
            luke_foodid: mapping.luke_foodid,
            luke_name_fi: food?.name_fi ?? null,
            luke_name_en: food?.name_en ?? null,
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

      items.push({
        status: "mapped",
        reason: "ok",
        component_id: componentId,
        component_name: componentName,
        component_type: componentType,
        component_weight_kg: componentWeightKg,
        ingredient_core: ing.ingredient_core,
        base_name: baseName,
        share_pct: pct,
        cooked_mass_kg: cookedKg,
        luke_foodid: mapping.luke_foodid,
        luke_name_fi: food?.name_fi ?? null,
        luke_name_en: food?.name_en ?? null,
        factor_source: factor.source,
        factor_kgco2_per_kg: factor.value,
        mass_for_factor_kg: massForFactorKg,
        co2e_kg: co2,
      });
    }

    if (unallocatedKg > 1e-9) {
      // This is what you called "unmapped because missing share"
      unmappedMass += unallocatedKg;
      items.push({
        status: "unmapped",
        reason: "unallocated remainder (shares < 100)",
        component_id: componentId,
        component_name: componentName,
        component_type: componentType,
        component_weight_kg: componentWeightKg,
        ingredient_core: "UNALLOCATED_REMAINDER",
        base_name: "UNALLOCATED_REMAINDER",
        share_pct: null,
        cooked_mass_kg: unallocatedKg,
        luke_foodid: null,
        luke_name_fi: null,
        luke_name_en: null,
        factor_source: "none",
        factor_kgco2_per_kg: null,
        mass_for_factor_kg: 0,
        co2e_kg: 0,
      });
    }
  }

  return {
    donation,
    restaurant,
    dish,
    mapping_source_system: SOURCE_SYSTEM,
    totals: {
      total_food_mass_kg: donatedWeightKg,
      total_co2e_kg: totalCo2,
      co2_per_kg: donatedWeightKg > 0 ? totalCo2 / donatedWeightKg : 0,
      mapped_mass_kg: mappedMass,
      ignored_mass_kg: ignoredMass,
      unmapped_mass_kg: unmappedMass,
    },
    items,
  };
}

