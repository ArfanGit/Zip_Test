// src/aiSuggestMapping.ts
import 'dotenv/config';
import OpenAI from 'openai';
import { db } from './dbClient';

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// For now, all mappings belong to this kitchen / restaurant.
// Later you can change this or make it dynamic.
const SOURCE_SYSTEM = 'SODEXO_LADONLUKKO';

// Choose which ingredient_core you want to map for this run.
// Change this as needed, e.g. '6KG_KIKHERNE', 'PINAATTI_HIENONNETTU_RPA_PINAATTI', etc.
const INGREDIENT_CORE = 'PINAATTI_HIENONNETTU_RPA_PINAATTI';

const MAX_CANDIDATES = 12;
const CONF_AUTO = 0.7; // ≥ 0.7 => auto-insert as ai_auto

interface LukeFood {
  foodid: number;
  name_en: string | null;
  name_fi: string | null;
  kg_co2e_per_kg: number | null;
}

function normalize(str: string | null | undefined): string {
  return (str || '').toLowerCase();
}

// Choose a small candidate subset from luke_foods using lexical scoring.
function pickCandidates(
  ingredientCore: string,
  exampleRaws: string[],
  foods: LukeFood[]
): LukeFood[] {
  const coreTokens = normalize(ingredientCore)
    .split(/[_\s,()]+/)
    .filter((t) => t.length > 2);

  const exampleText = normalize(exampleRaws.join(' '));

  const scored = foods.map((f) => {
    const nameEn = normalize(f.name_en);
    const nameFi = normalize(f.name_fi);

    let score = 0;
    for (const t of coreTokens) {
      if (nameEn.includes(t)) score += 2;
      if (nameFi.includes(t)) score += 2;
      if (exampleText.includes(t)) score += 1;
    }

    return { food: f, score };
  });

  // Only keep reasonably related foods
  const filtered = scored.filter((s) => s.score >= 1.0);
  filtered.sort((a, b) => b.score - a.score);

  return filtered.slice(0, MAX_CANDIDATES).map((s) => s.food);
}

async function main() {
  console.log(
    'AI mapping demo for ingredient_core =',
    INGREDIENT_CORE,
    'source_system =',
    SOURCE_SYSTEM
  );

  // 1) Get example ingredient_raw strings
  const { data: ingRows, error: ingError } = await db
    .from('component_ingredients')
    .select('ingredient_raw')
    .eq('ingredient_core', INGREDIENT_CORE)
    .limit(5);

  if (ingError) {
    throw new Error('Error loading component_ingredients: ' + ingError.message);
  }

  const rawExamples = Array.from(
    new Set((ingRows || []).map((r: any) => r.ingredient_raw).filter(Boolean))
  );

  console.log('Example ingredient_raw values:', rawExamples);

  // 2) Load all Luke foods
  const { data: lukeRows, error: lukeError } = await db
    .from('luke_foods')
    .select('foodid, name_en, name_fi, kg_co2e_per_kg');

  if (lukeError) {
    throw new Error('Error loading luke_foods: ' + lukeError.message);
  }

  const lukeFoods = (lukeRows || []) as LukeFood[];
  if (lukeFoods.length === 0) {
    throw new Error('No luke_foods available in DB.');
  }

  // 3) Choose candidate subset
  const candidates = pickCandidates(INGREDIENT_CORE, rawExamples, lukeFoods);
  if (candidates.length === 0) {
    console.log('No lexical candidates found. Consider adjusting pickCandidates().');
    return;
  }

  console.log(`Selected ${candidates.length} candidate Luke foods for AI to choose from.`);
  console.log(
    candidates.map((c) => ({
      foodid: c.foodid,
      name_en: c.name_en,
      name_fi: c.name_fi,
      kg_co2e_per_kg: c.kg_co2e_per_kg,
    }))
  );

  // 4) Call OpenAI
  const payload = {
    ingredient_core: INGREDIENT_CORE,
    ingredient_raw_examples: rawExamples,
    candidates: candidates.map((c) => ({
      foodid: c.foodid,
      name_en: c.name_en,
      name_fi: c.name_fi,
      kg_co2e_per_kg: c.kg_co2e_per_kg,
    })),
  };

  const instructions = `
You are helping map commercial kitchen ingredients to a national food database.

You will receive:
- ingredient_core (an internal key)
- ingredient_raw_examples (plain-language strings from kitchen ERP)
- candidates: a list of possible Luke foods (foodid, name_en, name_fi, kg_co2e_per_kg).

Tasks:
1. Choose the single best matching candidate.foodid for this ingredient.
2. If none is acceptable, choose null.
3. Rate your confidence from 0.0 to 1.0.
4. Explain briefly, in one sentence, why you chose that mapping.

VERY IMPORTANT: 
Return ONLY a single JSON object with keys:
  { "foodid": number | null, "confidence": number, "reason": string }
No extra commentary, no backticks, no Markdown.
`;

  const response = await client.responses.create({
    model: 'gpt-4.1-mini',
    instructions,
    input: JSON.stringify(payload),
  });

  const text = response.output_text;
  console.log('\nRaw model output:\n', text);

  let parsed: { foodid: number | null; confidence: number; reason: string };
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    console.error('Failed to parse model output as JSON:', err);
    return;
  }

  console.log('\nParsed suggestion:');
  console.dir(parsed, { depth: null });

  // 5) Auto-insert when confidence is high enough
  if (parsed.foodid && parsed.confidence >= CONF_AUTO) {
    console.log(
      `\nConfidence ${parsed.confidence} >= ${CONF_AUTO}, saving as ai_auto mapping...`
    );

    const { error } = await db
      .from('ingredient_mappings')
      .upsert(
        {
          source_system: SOURCE_SYSTEM,
          ingredient_core: INGREDIENT_CORE,
          luke_foodid: parsed.foodid,
          match_type: 'ai_auto',
          ai_confidence: parsed.confidence,
          weight_state: 'cooked',
          is_active: true,
        },
        // composite key: source_system + ingredient_core
        { onConflict: 'source_system,ingredient_core' }
      );

    if (error) {
      console.error('DB upsert failed:', error.message);
    } else {
      console.log(
        `✅ Saved AI mapping for ${INGREDIENT_CORE} -> foodid=${parsed.foodid} as ai_auto (${parsed.confidence})`
      );
    }
  } else {
    console.log(
      `\nConfidence ${parsed.confidence} is below ${CONF_AUTO} or no foodid; NOT auto-saving.`
    );
  }

  // 6) Always print SQL snippet for manual approval (ai_manual or manual)
  const matchTypeForManual = parsed.foodid ? 'ai_manual' : 'manual';
  const confidenceSql =
    typeof parsed.confidence === 'number'
      ? parsed.confidence.toFixed(2)
      : 'NULL';

  console.log('\nYou can manually insert/update ingredient_mappings like:');
  console.log(`
insert into ingredient_mappings
(source_system, ingredient_core, luke_foodid, match_type, ai_confidence, weight_state, is_active, co2_override_per_kg)
values
('${SOURCE_SYSTEM}', '${INGREDIENT_CORE}', ${parsed.foodid ?? 'NULL'},
 '${matchTypeForManual}',
 ${confidenceSql},
 'cooked', true, NULL);
`);
}

main().catch((err) => {
  console.error('aiSuggestMapping failed:', err);
});
