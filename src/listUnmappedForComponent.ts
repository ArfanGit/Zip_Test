// src/listUnmappedForComponent.ts
import { db } from './dbClient';

// IMPORTANT: set this to the component you want to inspect
const COMPONENT_ID = 18; // e.g. your basmati component

// Keep this in sync with carbonCalculator.ts
const MIN_SHARE = 0.10; // 10%

async function main() {
  console.log('Listing unmapped ingredients for component_id =', COMPONENT_ID);

  // 1) Load all ingredients for this component
  const { data: ingredients, error: ingError } = await db
    .from('component_ingredients')
    .select('*')
    .eq('component_id', COMPONENT_ID);

  if (ingError) {
    throw new Error('Error loading component_ingredients: ' + ingError.message);
  }

  if (!ingredients || ingredients.length === 0) {
    console.log('No ingredients found for this component.');
    return;
  }

  // 2) Build list of ingredient_cores
  const cores = Array.from(new Set(ingredients.map((ci: any) => ci.ingredient_core)));

  // 3) Load mappings for these cores
  const { data: mappingsData, error: mapError } = await db
    .from('ingredient_mappings')
    .select('*')
    .in('ingredient_core', cores);

  if (mapError) {
    throw new Error('Error loading ingredient_mappings: ' + mapError.message);
  }

  const mappingByCore = new Map<string, any>();
  for (const m of mappingsData || []) {
    if (m.is_active !== false) {
      mappingByCore.set(m.ingredient_core, m);
    }
  }

  // 4) Filter to "big + unmapped" ingredients (ignoring water/salt + tiny)
  type Unmapped = {
    ingredient_core: string;
    example_raw: string;
    share_of_component: number | null;
    is_water: boolean;
    is_salt: boolean;
  };

  const unmapped: Unmapped[] = [];

  for (const ci of ingredients as any[]) {
    const share: number = ci.share_of_component ?? 0;

    // Skip water/salt (we ignore them in CO2 calc as well)
    if (ci.is_water || ci.is_salt) continue;

    // Skip tiny ingredients
    if (!share || share < MIN_SHARE) continue;

    // If mapping exists and is active, skip (already covered)
    const mapping = mappingByCore.get(ci.ingredient_core);
    if (mapping) continue;

    unmapped.push({
      ingredient_core: ci.ingredient_core,
      example_raw: ci.ingredient_raw,
      share_of_component: ci.share_of_component,
      is_water: !!ci.is_water,
      is_salt: !!ci.is_salt,
    });
  }

  if (unmapped.length === 0) {
    console.log('No significant unmapped ingredients for this component.');
    return;
  }

  console.log(`Found ${unmapped.length} significant unmapped ingredients:`);
  for (const u of unmapped) {
    const sharePct = u.share_of_component != null ? (u.share_of_component * 100).toFixed(1) + '%' : 'n/a';
    console.log(
      `- core="${u.ingredient_core}", share=${sharePct}, example_raw="${u.example_raw}"`
    );
  }
}

main().catch((err) => {
  console.error('listUnmappedForComponent failed:', err);
});
