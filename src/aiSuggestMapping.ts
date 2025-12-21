// src/aiSuggestMapping.ts
import 'dotenv/config';
import OpenAI from 'openai';
import { db } from './dbClient';

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// For now, all mappings belong to this kitchen / restaurant.
const SOURCE_SYSTEM = 'SODEXO_LADONLUKKO';

// 👉 Change this to the ingredient_core you want to test
const INGREDIENT_CORE = 'PINAATTI_HIENONNETTU_RPA_PINAATTI';

const MAX_CANDIDATES = 12;
const CONF_AUTO = 0.7;        // ≥ 0.7 => auto-save as ai_auto
const CONF_MIN_FOR_ANY = 0.5; // < 0.5 or no foodid => trigger fallback

interface LukeFood {
  foodid: number;
  name_en: string | null;
  name_fi: string | null;
  kg_co2e_per_kg: number | null;
  fuclass?: string | null;
  igclass?: string | null;
}

function normalize(str: string | null | undefined): string {
  return (str || '').toLowerCase();
}

// Phase 1: improved candidate selection (no exampleText scoring, ignore noisy tokens)
function pickPrimaryCandidates(
  ingredientCore: string,
  exampleRaws: string[],
  foods: LukeFood[]
): LukeFood[] {
  // Build tokens from ingredientCore
  const coreTokens = normalize(ingredientCore)
    .split(/[_\s,()]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 3)      // drop very short tokens (rpa, kg, etc.)
    .filter((t) => !/^\d/.test(t));   // drop tokens starting with digits (6kg, 3kg, ...)

  const scored = foods.map((f) => {
    const nameEn = normalize(f.name_en);
    const nameFi = normalize(f.name_fi);

    let score = 0;

    for (const t of coreTokens) {
      if (!t) continue;

      // Strong match: token appears in English or Finnish name
      if (nameEn.includes(t)) score += 2;
      if (nameFi.includes(t)) score += 2;

      // NOTE: we deliberately do NOT add points for exampleText here,
      // because exampleText is the same for all foods and can't help distinguish them.
    }

    return { food: f, score };
  });

  // Only keep reasonably related foods
  const filtered = scored.filter((s) => s.score >= 2.0); // tightened threshold

  filtered.sort((a, b) => b.score - a.score);

  return filtered.slice(0, MAX_CANDIDATES).map((s) => s.food);
}

// Extract a "root" token from the ingredient (Phase 3 helper, used in fallback)
function extractRootToken(
  ingredientCore: string,
  exampleRaws: string[]
): string | null {
  const combined = `${ingredientCore} ${exampleRaws.join(' ')}`;
  const tokens = normalize(combined)
    .split(/[^a-zåäöA-ZÅÄÖ]+/) // keep only letters (Finnish/English)
    .map((t) => t.trim())
    .filter((t) => t.length > 3)
    .filter((t) => !/^\d/.test(t));

  if (tokens.length === 0) return null;

  const freq: Record<string, number> = {};
  for (const t of tokens) {
    if (!t) continue;
    freq[t] = (freq[t] || 0) + 1;
  }

  const entries = Object.entries(freq);
  entries.sort((a, b) => b[1] - a[1]); // most frequent first

  const [root] = entries[0];
  return root || null;
}

// Fetch candidates directly from the DB using the root token in Finnish name.
// This is used ONLY in the fallback, so we don't depend on the in-memory lukeFoods array.
async function fetchRootCandidates(root: string): Promise<LukeFood[]> {
  const pattern = `%${root}%`;

  const { data, error } = await db
    .from('luke_foods')
    .select('foodid, name_en, name_fi, kg_co2e_per_kg, fuclass, igclass')
    .ilike('name_fi', pattern)
    .limit(MAX_CANDIDATES);

  if (error) {
    console.error('Error loading root candidates from luke_foods:', error.message);
    return [];
  }

  return (data || []) as LukeFood[];
}

// Helper: run the model once for a given candidate list
async function runModelOnce(
  label: string,
  ingredientCore: string,
  rawExamples: string[],
  candidates: LukeFood[]
): Promise<{ foodid: number | null; confidence: number; reason: string }> {
  console.log(`\n[${label}] Calling model with ${candidates.length} candidates.`);
  console.log(
    candidates.map((c) => ({
      foodid: c.foodid,
      name_en: c.name_en,
      name_fi: c.name_fi,
      kg_co2e_per_kg: c.kg_co2e_per_kg,
    }))
  );

  const payload = {
    ingredient_core: ingredientCore,
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
  console.log(`\n[${label}] Raw model output:\n`, text);

  let parsed: { foodid: number | null; confidence: number; reason: string };
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    console.error(`[${label}] Failed to parse model output as JSON:`, err);
    return { foodid: null, confidence: 0, reason: 'parse_error' };
  }

  console.log(`\n[${label}] Parsed suggestion:`);
  console.dir(parsed, { depth: null });

  return parsed;
}

async function main() {
  console.log(
    'AI mapping demo for ingredient_core =',
    INGREDIENT_CORE,
    'source_system =',
    SOURCE_SYSTEM
  );

  // 1) Example ingredient_raw values for this core
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

  // 2) Load Luke foods (primary path still uses an in-memory list, but we ensure a large range)
  const { data: lukeRows, error: lukeError } = await db
    .from('luke_foods')
    .select('foodid, name_en, name_fi, kg_co2e_per_kg, fuclass, igclass')
    .range(0, 1999); // explicitly load up to 2000 rows

  if (lukeError) {
    throw new Error('Error loading luke_foods: ' + lukeError.message);
  }

  const lukeFoods = (lukeRows || []) as LukeFood[];
  if (lukeFoods.length === 0) {
    throw new Error('No luke_foods available in DB.');
  }

  // 3) Primary candidate set
  const primaryCandidates = pickPrimaryCandidates(
    INGREDIENT_CORE,
    rawExamples,
    lukeFoods
  );

  if (primaryCandidates.length === 0) {
    console.log(
      '\n[primary] No lexical candidates found at all. Will rely on fallback root search.'
    );
  }

  // 4) First model call (if we have primary candidates)
  let parsed = primaryCandidates.length
    ? await runModelOnce('primary', INGREDIENT_CORE, rawExamples, primaryCandidates)
    : { foodid: null, confidence: 0, reason: 'no_primary_candidates' };

  // Determine if we should trigger fallback:
  //  - no foodid, OR
  //  - confidence < CONF_MIN_FOR_ANY
  let needFallback =
    !parsed.foodid ||
    typeof parsed.confidence !== 'number' ||
    parsed.confidence < CONF_MIN_FOR_ANY;

  if (needFallback) {
    console.log(
      `\nPrimary mapping failed (foodid=${parsed.foodid}, confidence=${parsed.confidence}). Trying fallback...`
    );

    const root = extractRootToken(INGREDIENT_CORE, rawExamples);
    console.log('Fallback root token:', root);

    if (root) {
      // DB-based root search: e.g. name_fi ILIKE '%pinaatti%'
      const rootCandidates = await fetchRootCandidates(root);

      if (rootCandidates.length > 0) {
        const fallbackParsed = await runModelOnce(
          `fallback-root:${root}`,
          INGREDIENT_CORE,
          rawExamples,
          rootCandidates
        );

        // If fallback gives a foodid, use it
        if (fallbackParsed.foodid) {
          parsed = fallbackParsed;
          console.log('\nUsing fallback mapping from root-based DB candidates.');
        } else {
          console.log('\nFallback also returned no foodid.');
        }
      } else {
        console.log(
          '\nNo Luke foods matched the root token in DB. Fallback cannot propose candidates.'
        );
      }
    } else {
      console.log('\nCould not extract a useful root token. No fallback applied.');
    }
  }

  // Final parsed suggestion after primary + optional fallback
  console.log('\nFinal parsed suggestion after fallback (if any):');
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
  const hasFood = !!parsed.foodid;
  const matchTypeForManual = hasFood ? 'ai_manual' : 'manual';
  const confidenceSql =
    typeof parsed.confidence === 'number'
      ? parsed.confidence.toFixed(2)
      : 'NULL';
  const foodidSql = hasFood ? String(parsed.foodid) : 'NULL';

  console.log('\nYou can manually insert/update ingredient_mappings like:');
  console.log(`
insert into ingredient_mappings
(source_system, ingredient_core, luke_foodid, match_type, ai_confidence, weight_state, is_active, co2_override_per_kg)
values
('${SOURCE_SYSTEM}', '${INGREDIENT_CORE}', ${foodidSql},
 '${matchTypeForManual}',
 ${confidenceSql},
 'cooked', true, NULL);
`);
}

main().catch((err) => {
  console.error('aiSuggestMapping failed:', err);
});
