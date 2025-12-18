// src/demoSodexoTray.ts
import { db } from './dbClient';
import { computeDonationCarbon } from './carbonCalculator';

// TODO: put your real values here (from Supabase)
const COMPONENT_ID = 17;                // e.g. 17
const INGREDIENT_CORE = 'RIISI_BASMATI_1KG_BASMATIRIISI_INTIA';     // e.g. 'RIISI_BASMATI_1KG_BASMATIRIISI_INTIA'
const LUKE_FOODID = 11521;                // e.g. 4001

// How much cooked food was donated (kg)
const DONATED_WEIGHT_KG = 10;

async function main() {
  console.log('Using:');
  console.log('  COMPONENT_ID   =', COMPONENT_ID);
  console.log('  INGREDIENT_CORE=', INGREDIENT_CORE);
  console.log('  LUKE_FOODID    =', LUKE_FOODID);

  // 1) Upsert ingredient mapping
  const { error: mapError } = await db.from('ingredient_mappings').upsert(
    {
      ingredient_core: INGREDIENT_CORE,
      luke_foodid: LUKE_FOODID,
      match_type: 'exact',
      weight_state: 'cooked',      // simplified for now
      yield_cooked_per_raw: null,  // later: set if you use raw factors + yields
      co2_override_per_kg: null,
      is_active: true,
    },
    { onConflict: 'ingredient_core' }
  );

  if (mapError) {
    throw new Error('Error upserting ingredient_mappings: ' + mapError.message);
  }

  console.log('Mapping upserted for', INGREDIENT_CORE);

  // 2) Create a donation for this component
  const { data: donationRows, error: donationError } = await db
    .from('donations')
    .insert({
      kitchen_id: 'SODEXO_LADONLUKKO',
      dish_id: null, // optional; computeDonationCarbon uses component_id
      component_id: COMPONENT_ID,
      donated_weight_kg: DONATED_WEIGHT_KG,
    })
    .select('id')
    .single();

  if (donationError || !donationRows) {
    throw new Error('Error inserting donation: ' + donationError?.message);
  }

  const donationId = donationRows.id as number;
  console.log('Created donation with id', donationId);

  // 3) Compute CO2 for this donation
  const result = await computeDonationCarbon(donationId);
  console.log('Carbon result for Sodexo component donation:');
  console.log(result);
}

main().catch((err) => {
  console.error('demoSodexoTray failed:', err);
});
