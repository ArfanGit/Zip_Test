// src/runSodexoImport.ts
import fs from 'fs/promises';
import { importSodexoMenu } from './sodexoImporter';

async function main() {
  // 1) Read JSON from project root
  const jsonText = await fs.readFile('json_sodexo.txt', 'utf8');

  // 2) Parse JSON
  const json = JSON.parse(jsonText);

  // 3) Import under a restaurant id (you can change this label)
  const restaurantId = 'SODEXO_LADONLUKKO';

  await importSodexoMenu(json, restaurantId);
}

main().catch((err) => {
  console.error('runSodexoImport failed:', err);
});
