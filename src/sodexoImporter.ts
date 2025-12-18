// src/sodexoImporter.ts
import { db } from './dbClient';

/**
 * Very simple normalization:
 * - uppercase
 * - strip punctuation
 * - collapse spaces
 * - replace spaces with underscore
 */
function normalizeIngredientCore(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[\.,;:\[\]\(\)]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\s/g, '_');
}

/**
 * Parse one ingredient fragment like "water (69%)" -> { ingredient_raw, core, share }
 */
function parseIngredientFragment(fragment: string) {
  const trimmed = fragment.trim();
  const match = trimmed.match(/\((\d+)\s*%\)/);

  let share: number | null = null;
  let namePart = trimmed;

  if (match) {
    const pct = parseFloat(match[1]);
    if (!Number.isNaN(pct)) {
      share = pct / 100;
    }
    namePart = trimmed.replace(match[0], '').trim();
  }

  const ingredient_core = normalizeIngredientCore(namePart);

  const lower = namePart.toLowerCase();
  const is_water = lower.includes('vesi') || lower === 'water';
  const is_salt = lower.includes('suola') || lower === 'salt';

  return {
    ingredient_raw: trimmed,
    ingredient_core,
    share_of_component: share,
    is_water,
    is_salt,
  };
}

/**
 * Very naive split: split ingredients string by commas.
 * This will not be perfect, but good enough for first experiments.
 */
function splitIngredientsString(ingredients: string): string[] {
  return ingredients
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/**
 * Import a Sodexo menu JSON into:
 *  - dishes
 *  - dish_components
 *  - component_ingredients
 *
 * For now, we:
 *  - use today's date as menu_date
 *  - treat recipeKey "0" as main component
 */
export async function importSodexoMenu(json: any, restaurantId: string) {
  if (!json || !Array.isArray(json.mealdates)) {
    throw new Error('Unexpected Sodexo JSON shape: no mealdates[]');
  }

  let dishCount = 0;
  let componentCount = 0;
  let ingredientCount = 0;

  const today = new Date().toISOString().slice(0, 10);

  for (const day of json.mealdates) {
    const courses = day.courses || {};
    const courseEntries = Object.entries(courses);

    for (const [courseKey, courseVal] of courseEntries) {
      const course: any = courseVal || {};

      // 1) Insert dish
      const { data: dishRows, error: dishError } = await db
        .from('dishes')
        .insert({
          restaurant_id: restaurantId,
          sodexo_course_id: courseKey,
          menu_date: today, // we simplify for now
          title_fi: course.title_fi ?? null,
          title_en: course.title_en ?? null,
          title_sv: course.title_sv ?? null,
          category: course.category ?? null,
          dietcodes: course.dietcodes ?? null,
        })
        .select('id')
        .single();

      if (dishError || !dishRows) {
        console.error('Error inserting dish', dishError);
        continue;
      }

      const dishId = dishRows.id as number;
      dishCount += 1;

      // 2) Insert components (recipes)
      const recipes = course.recipes || {};
      const recipeEntries = Object.entries(recipes);

      for (const [recipeKey, recipeVal] of recipeEntries) {
        const recipe: any = recipeVal || {};
        const name = recipe.name || recipe.title || 'Unnamed component';

        const { data: compRows, error: compError } = await db
          .from('dish_components')
          .insert({
            dish_id: dishId,
            sodexo_recipe_key: recipeKey,
            name_raw: name,
            is_main_component: recipeKey === '0',
            plate_share: null,
          })
          .select('id')
          .single();

        if (compError || !compRows) {
          console.error('Error inserting dish_component', compError);
          continue;
        }

        const componentId = compRows.id as number;
        componentCount += 1;

        // 3) Parse ingredients string
        const ingStr: string = recipe.ingredients || '';
        const fragments = splitIngredientsString(ingStr);

        const ingredientRows = fragments.map((frag) => {
          const parsed = parseIngredientFragment(frag);
          return {
            component_id: componentId,
            ingredient_raw: parsed.ingredient_raw,
            ingredient_core: parsed.ingredient_core,
            share_of_component: parsed.share_of_component,
            is_water: parsed.is_water,
            is_salt: parsed.is_salt,
          };
        });

        if (ingredientRows.length > 0) {
          const { error: ingError } = await db
            .from('component_ingredients')
            .insert(ingredientRows);

          if (ingError) {
            console.error('Error inserting component_ingredients', ingError);
          } else {
            ingredientCount += ingredientRows.length;
          }
        }
      }
    }
  }

  console.log(
    `Sodexo import finished: ${dishCount} dishes, ${componentCount} components, ${ingredientCount} ingredient rows.`
  );
}
