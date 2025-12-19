// src/demoSodexoTray.ts
import 'dotenv/config';
import { db } from './dbClient';
import { computeDonationCarbon } from './carbonCalculator';

async function main() {
  // 👉 Change this to test different components:
  //  - 17 = basmati rice tray (your earlier demo)
  //  - 18 = palak paneer tray (our new fully-mapped example)
  const COMPONENT_ID = 18;

  // How many kg of this component were donated (tray weight)
  const DONATED_WEIGHT_KG = 10;

  console.log('--- Demo: Sodexo component donation ---');
  console.log('Component ID :', COMPONENT_ID);
  console.log('Donated kg   :', DONATED_WEIGHT_KG);

  // 1) Insert a test donation row
  const { data: donation, error: insertError } = await db
    .from('donations')
    .insert({
      kitchen_id: 'SODEXO_LADONLUKKO',   // matches what we’ve used elsewhere
      component_id: COMPONENT_ID,
      donated_weight_kg: DONATED_WEIGHT_KG,
    })
    .select()
    .single();

  if (insertError) {
    console.error('Failed to insert donation:', insertError.message);
    process.exit(1);
  }

  console.log('\nInserted donation:');
  console.log(donation);

  // 2) Run the carbon calculator for this donation
  const result = await computeDonationCarbon(donation.id);

  console.log('\nCarbon result:');
  console.log(JSON.stringify(result, null, 2));

  console.log('\nDone.');
}

main().catch((err) => {
  console.error('demoSodexoTray failed:', err);
  process.exit(1);
});
