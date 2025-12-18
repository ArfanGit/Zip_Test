// src/loadLukeFoods.ts
import fs from 'fs';
import { parse } from 'csv-parse/sync';
import { db } from './dbClient';

const CSV_PATH = 'FoodGWP_dataset_1.09_fixed.csv'; 
// If your file has a different name, change this line ONLY.

async function main() {
  // 1) Read CSV file
  const csvText = await fs.promises.readFile(CSV_PATH, 'utf8');

  // 2) Parse CSV into records (one object per row)
  const records = parse(csvText, {
    columns: true,
    skip_empty_lines: true,
  }) as any[];

  console.log(`Parsed ${records.length} rows from ${CSV_PATH}`);

  // 3) Insert in batches to luke_foods
  const batchSize = 500;

  for (let i = 0; i < records.length; i += batchSize) {
    const batch = records.slice(i, i + batchSize).map((row) => ({
      foodid: Number(row.FOODID),
      name_fi: row.FOODNAME_FI,
      name_en: row.FOODNAME_EN,
      name_sv: row.FOODNAME_SV,
      fuclass: row.FUCLASS,
      igclass: row.IGCLASS,
      fuclass_substitute: row.FUCLASS_subsitute ?? null,
      kg_co2e_per_kg: Number(row['kgCO2-eq/kg']),
      g_co2e_per_100g: Number(row['gCO2-eq/100g']),
      data_quality: row['Data quality'],
      average_source: row.Average_source,
    }));

    const { error } = await db
      .from('luke_foods')
      .upsert(batch, { onConflict: 'foodid' } as any);

    if (error) {
      console.error('Error inserting batch', i / batchSize, error);
      process.exit(1);
    } else {
      console.log(
        `Inserted batch ${i / batchSize + 1} (${batch.length} rows)`
      );
    }
  }

  console.log('Done loading luke_foods.');
}

main().catch((err) => {
  console.error('Unexpected error in loadLukeFoods:', err);
});


