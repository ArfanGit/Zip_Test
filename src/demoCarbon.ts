// src/demoCarbon.ts
import { db } from './dbClient';
import { computeDonationCarbon } from './carbonCalculator';

const SOURCE_SYSTEM = process.env.MAPPING_SOURCE_SYSTEM || 'SODEXO_LADONLUKKO';

async function main() {
  // 1) Pick one Luke food (first row) just for demo
  const { data: foods, error: foodsError } = await db
    .from('luke_foods')
    .select('foodid, name_en, kg_co2e_per_kg')
    .limit(1);

  if (foodsError || !foods || foods.length === 0) {
    throw new Error('Could not load any luke_foods');
  }

  const food = foods[0] as any;
  console.log('Using Luke food for demo:', food);

  // 2) Upsert ingredient mapping for a demo ingredient_core (Option B)
  const ingredientCore = 'DEMO_FOOD';

  const { error: mapError } = await db.from('ingredient_mappings').upsert(
    {
      source_system: SOURCE_SYSTEM,
      ingredient_core: ingredientCore,
      luke_foodid: food.foodid,

      // IMPORTANT: must satisfy DB CHECK constraint (match_type_valid)
      match_type: 'manual',

      ai_confidence: null,
      weight_state: 'cooked',
      yield_cooked_per_raw: null,
      co2_override_per_kg: null,
      is_active: true,
    },
    { onConflict: 'source_system,ingredient_core' }
  );

  if (mapError) {
    throw new Error('Error upserting ingredient_mappings: ' + mapError.message);
  }

  // 3) Create a test dish
  const { data: dishRows, error: dishError } = await db
    .from('dishes')
    .insert({
      restaurant_id: 'DEMO_RESTAURANT',
      sodexo_course_id: '0',
      menu_date: new Date().toISOString().slice(0, 10),
      title_fi: 'Demo dish',
      title_en: 'Demo dish',
      title_sv: 'Demo dish',
      category: 'demo',
      dietcodes: '',
    })
    .select('id')
    .single();

  if (dishError || !dishRows) {
    throw new Error('Error inserting demo dish: ' + dishError?.message);
  }

  const dishId = dishRows.id as number;

  // 4) Create a component for this dish
  const { data: compRows, error: compError } = await db
    .from('dish_components')
    .insert({
      dish_id: dishId,
      sodexo_recipe_key: '0',
      name_raw: 'Demo component',
      is_main_component: true,
      plate_share: 1.0,
    })
    .select('id')
    .single();

  if (compError || !compRows) {
    throw new Error('Error inserting demo component: ' + compError?.message);
  }

  const componentId = compRows.id as number;

  // 5) Add one ingredient: 100% of the component mass is DEMO_FOOD
  const { error: ingError } = await db.from('component_ingredients').insert({
    component_id: componentId,
    ingredient_raw: 'Demo ingredient',
    ingredient_core: ingredientCore,
    share_of_component: 1.0,
    is_water: false,
    is_salt: false,
  });

  if (ingError) {
    throw new Error('Error inserting demo ingredient: ' + ingError.message);
  }

  // 6) Insert a donation referencing this component
  const { data: donationRows, error: donationError } = await db
    .from('donations')
    .insert({
      kitchen_id: 'DEMO_KITCHEN',
      dish_id: dishId,
      component_id: componentId,
      donated_weight_kg: 5.0,
    })
    .select('id')
    .single();

  if (donationError || !donationRows) {
    throw new Error('Error inserting demo donation: ' + donationError?.message);
  }

  const donationId = donationRows.id as number;
  console.log('Created demo donation with id', donationId);

  // 7) Compute carbon for this donation
  const result = await computeDonationCarbon(donationId);
  console.log('Carbon result for demo donation:', result);
}

main().catch((err) => {
  console.error('Demo failed:', err);
  process.exit(1);
});
