// src/carbonCalculator.ts
import { db } from './dbClient';

export interface DonationCarbonResult {
  donationId: number;
  totalCo2eKg: number;
  totalFoodMassKg: number;
  unmappedMassKg: number;
  co2PerKg: number | null;
}

// Minimum share of component (fraction) for an ingredient to be considered
// in the CO2 calculation / unmapped mass. Smaller ingredients (spices, traces)
// are ignored entirely.
const MIN_SHARE = 0.10; // 10%

/**
 * Compute carbon impact for a single donation.
 * Pipeline:
 *   donations -> component_ingredients -> ingredient_mappings -> luke_foods
 */
export async function computeDonationCarbon(
  donationId: number
): Promise<DonationCarbonResult> {
  // 1) Load donation
  const { data: donation, error: donationError } = await db
    .from('donations')
    .select('*')
    .eq('id', donationId)
    .single();

  if (donationError || !donation) {
    throw new Error(
      `Donation ${donationId} not found: ${donationError?.message ?? 'no row'}`
    );
  }

  if (!donation.component_id) {
    throw new Error(`Donation ${donationId} has no component_id`);
  }

  const totalFoodMassKg: number = Number(donation.donated_weight_kg ?? 0);

  // 2) Load component ingredients
  const { data: ingredients, error: ingredientsError } = await db
    .from('component_ingredients')
    .select('*')
    .eq('component_id', donation.component_id);

  if (ingredientsError) {
    throw new Error(
      `Error loading ingredients for component ${donation.component_id}: ${ingredientsError.message}`
    );
  }

  const componentIngredients = (ingredients || []) as any[];

  if (componentIngredients.length === 0) {
    return {
      donationId,
      totalCo2eKg: 0,
      totalFoodMassKg,
      unmappedMassKg: 0,
      co2PerKg: 0,
    };
  }

  // 3) Load ingredient mappings for the cores in this component
  const cores = Array.from(
    new Set(componentIngredients.map((ci) => ci.ingredient_core))
  );

  const { data: mappingsData, error: mappingsError } = await db
    .from('ingredient_mappings')
    .select('*')
    .in('ingredient_core', cores);

  if (mappingsError) {
    throw new Error(
      `Error loading ingredient mappings: ${mappingsError.message}`
    );
  }

  const mappings = (mappingsData || []) as any[];
  const mappingByCore = new Map<string, any>();
  for (const m of mappings) {
    if (m.is_active !== false) {
      mappingByCore.set(m.ingredient_core, m);
    }
  }

  // 4) Load luke_foods entries for mapped foodids
  const foodIds = Array.from(
    new Set(
      mappings
        .map((m) => m.luke_foodid)
        .filter((id: any) => typeof id === 'number')
    )
  );

  const foodById = new Map<number, any>();

  if (foodIds.length > 0) {
    const { data: foodsData, error: foodsError } = await db
      .from('luke_foods')
      .select('*')
      .in('foodid', foodIds);

    if (foodsError) {
      throw new Error(`Error loading luke_foods: ${foodsError.message}`);
    }

    for (const f of foodsData || []) {
      foodById.set(f.foodid, f);
    }
  }

  // 5) Ingredient-level CO2 calculation
  let totalCo2e = 0;
  let unmappedMass = 0;

  for (const ci of componentIngredients) {
    const share: number = ci.share_of_component ?? 0;

    // Ignore water & salt completely (no CO2, no unmapped)
    if (ci.is_water || ci.is_salt) {
      continue;
    }

    // Ignore very small ingredients (e.g. spices) under MIN_SHARE.
    // They don't contribute to CO2 or to unmappedMass.
    if (!share || share < MIN_SHARE) {
      continue;
    }

    const cookedWeightKg = totalFoodMassKg * share;
    if (cookedWeightKg <= 0) continue;

    const mapping = mappingByCore.get(ci.ingredient_core);

    // Significant ingredient, but no mapping yet -> count as unmapped mass.
    if (!mapping) {
      unmappedMass += cookedWeightKg;
      continue;
    }

    const weightState: string = mapping.weight_state || 'ignore';

    if (weightState === 'ignore') {
      // Explicitly ignored ingredient
      continue;
    }

    // Determine CO2 factor per kg
    let factor: number | null =
      mapping.co2_override_per_kg != null
        ? Number(mapping.co2_override_per_kg)
        : null;

    if (factor == null) {
      const foodid = mapping.luke_foodid;
      if (typeof foodid !== 'number') {
        // Mapping exists but no valid foodid; treat as unmapped mass
        unmappedMass += cookedWeightKg;
        continue;
      }

      const food = foodById.get(foodid);
      if (!food) {
        unmappedMass += cookedWeightKg;
        continue;
      }

      factor = Number(food.kg_co2e_per_kg);
    }

    let co2ForIngredient = 0;

    if (weightState === 'cooked') {
      // factor is per kg cooked food
      co2ForIngredient = cookedWeightKg * factor;
    } else if (weightState === 'raw') {
      // factor is per kg raw ingredient -> adjust using yield
      const yRawToCooked =
        mapping.yield_cooked_per_raw != null
          ? Number(mapping.yield_cooked_per_raw)
          : 1.0;

      const safeY = yRawToCooked === 0 ? 1.0 : yRawToCooked;
      const rawEquivKg = cookedWeightKg / safeY;
      co2ForIngredient = rawEquivKg * factor;
    } else {
      // Unknown weight_state -> treat as ignore
      continue;
    }

    totalCo2e += co2ForIngredient;
  }

  const co2PerKg =
    totalFoodMassKg > 0 ? totalCo2e / totalFoodMassKg : null;

  // 6) Store in donation_metrics (upsert)
  const { error: metricsError } = await db
    .from('donation_metrics')
    .upsert(
      {
        donation_id: donationId,
        total_co2e_kg: totalCo2e,
        total_food_mass_kg: totalFoodMassKg,
        unmapped_mass_kg: unmappedMass,
      },
      { onConflict: 'donation_id' }
    );

  if (metricsError) {
    console.error('Warning: failed to upsert donation_metrics:', metricsError);
  }

  return {
    donationId,
    totalCo2eKg: totalCo2e,
    totalFoodMassKg,
    unmappedMassKg: unmappedMass,
    co2PerKg,
  };
}


