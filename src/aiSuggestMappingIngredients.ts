// src/aiSuggestMappingTwoPass.ts
// Two-pass AI mapping: ingredient_core -> luke_foods.foodid
// v2 update: supports batch processing per restaurant (UUID) and unmapped-only runs.
//
// Usage (single core):
//   npx ts-node src/aiSuggestMappingTwoPass.ts --core "PINAATTI_HIENONNETTU_RPA_PINAATTI" --source SODEXO --save
//
// Usage (batch per restaurant):
//   npx ts-node src/aiSuggestMappingTwoPass.ts --restaurant-id <uuid> --source SODEXO --limit 50 --save
//   (default in restaurant mode: only unmapped cores)
//
// Optional filters:
//   --date-from YYYY-MM-DD   (limits dishes considered for restaurant)
//   --date-to   YYYY-MM-DD
//   --core-prefix "PINAATTI_" (limits ingredient_cores)
//
// Save behavior:
//   --save      (enables DB upsert)
//   --save-low  (also saves low-confidence results as ai_manual/unknown)

import 'dotenv/config';
import OpenAI from 'openai';
import { db } from './dbClient';

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Defaults
const DEFAULT_SOURCE_SYSTEM = process.env.MAPPING_SOURCE_SYSTEM || 'SODEXO_LADONLUKKO';
const DEFAULT_MODEL = process.env.OPENAI_MODEL || 'gpt-4.1-mini';

// Auto-save threshold for ai_auto
const CONF_AUTO = 0.7;

// Candidate caps
const MAX_CANDIDATES_DB_PER_TOKEN = 40;
const MAX_CANDIDATES_FINAL = 12;

// Query paging/chunking caps
const PAGE_SIZE = 1000;
const IN_CHUNK = 500;

type LukeFood = {
  foodid: number;
  name_en: string | null;
  name_fi: string | null;
  kg_co2e_per_kg: number | null;
  fuclass?: string | null;
  igclass?: string | null;
};

type Pass1Query = {
  canonical_name: string | null;
  language: 'fi' | 'en' | 'mixed' | 'unknown';
  keywords_fi: string[];
  keywords_en: string[];
  negative_keywords: string[];
  attributes: Record<string, any>;
  notes: string;
};

type Pass2Choice = {
  foodid: number | null;
  confidence: number;
  reason: string;
};

type CliOptions = {
  sourceSystem: string;
  core?: string;
  restaurantId?: string;
  model: string;
  save: boolean;
  saveLow: boolean;
  verbose: boolean;
  maxCandidates: number;
  limit: number;
  includeMapped: boolean;
  dateFrom?: string;
  dateTo?: string;
  corePrefix?: string;
};

// ---------------------- small utils ----------------------

function parseArgs(argv: string[]): CliOptions {
  const args = argv.slice(2);

  const get = (k: string) => {
    const i = args.indexOf(k);
    if (i === -1) return undefined;
    return args[i + 1];
  };
  const has = (k: string) => args.includes(k);

  const sourceSystem = get('--source') || DEFAULT_SOURCE_SYSTEM;
  const core = get('--core');
  const restaurantId = get('--restaurant-id');
  const model = get('--model') || DEFAULT_MODEL;

  const maxCandidates = get('--max-candidates') ? Number(get('--max-candidates')) : MAX_CANDIDATES_FINAL;
  const limit = get('--limit') ? Number(get('--limit')) : 50;

  const dateFrom = get('--date-from');
  const dateTo = get('--date-to');
  const corePrefix = get('--core-prefix');

  const save = has('--save');
  const saveLow = has('--save-low');
  const verbose = has('--verbose');
  const includeMapped = has('--include-mapped');

  return {
    sourceSystem,
    core,
    restaurantId,
    model,
    save,
    saveLow,
    verbose,
    maxCandidates,
    limit: Number.isFinite(limit) && limit > 0 ? limit : 50,
    includeMapped,
    dateFrom,
    dateTo,
    corePrefix,
  };
}

function uniqStrings(arr: string[]) {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const s of arr) {
    const v = (s || '').trim();
    if (!v) continue;
    const k = v.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(v);
  }
  return out;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function sanitizeKeyword(s: string): string {
  // keep letters/numbers/space/hyphen, remove brackets/punct that breaks ilike
  return (s || '')
    .toLowerCase()
    .replace(/[\[\]\(\)\{\}]/g, ' ')
    .replace(/[^a-z0-9åäö\s\-]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function clamp01(x: any): number {
  const n = typeof x === 'number' ? x : Number(x);
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function safeJsonParse<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    // Try to salvage: find the first {...} block
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1)) as T;
      } catch {
        return fallback;
      }
    }
    return fallback;
  }
}

function isLikelyUuid(s: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test((s || '').trim());
}

// ---------------------- DB helpers ----------------------

async function loadRawExamples(ingredientCore: string, limit = 8): Promise<string[]> {
  const { data, error } = await db
    .from('component_ingredients')
    .select('ingredient_raw')
    .eq('ingredient_core', ingredientCore)
    .limit(limit);

  if (error) throw new Error(`Failed to load component_ingredients examples: ${error.message}`);

  const raws = (data || [])
    .map((r: any) => String(r.ingredient_raw || '').trim())
    .filter(Boolean);

  return uniqStrings(raws);
}

async function fetchLukeByToken(token: string): Promise<LukeFood[]> {
  const t = sanitizeKeyword(token);
  if (!t || t.length < 3) return [];

  const pattern = `%${t}%`;

  const { data, error } = await db
    .from('luke_foods')
    .select('foodid, name_en, name_fi, kg_co2e_per_kg, fuclass, igclass')
    .or(`name_fi.ilike.${pattern},name_en.ilike.${pattern}`)
    .limit(MAX_CANDIDATES_DB_PER_TOKEN);

  if (error) throw new Error(`Luke query failed for token "${t}": ${error.message}`);

  return (data || []) as LukeFood[];
}

async function buildCandidatesFromPass1(pass1: Pass1Query, verbose: boolean, maxCandidates: number) {
  // Merge canonical + FI + EN keywords, remove negatives, query DB per token, rank by hit-count
  const tokensRaw = [pass1.canonical_name || '', ...(pass1.keywords_fi || []), ...(pass1.keywords_en || [])];

  const negatives = new Set((pass1.negative_keywords || []).map((x) => sanitizeKeyword(x)).filter(Boolean));

  const tokens = uniqStrings(tokensRaw)
    .map(sanitizeKeyword)
    .filter((t) => t.length >= 3)
    .filter((t) => !negatives.has(t));

  // Hard cap to avoid too many DB queries
  const tokenList = tokens.slice(0, 8);

  if (verbose) {
    console.log('\n[db] Tokens used for Luke retrieval:', tokenList);
    console.log('[db] Negative tokens:', Array.from(negatives));
  }

  const scoreMap = new Map<number, { row: LukeFood; score: number }>();

  for (const tok of tokenList) {
    const rows = await fetchLukeByToken(tok);
    for (const r of rows) {
      const cur = scoreMap.get(r.foodid);
      if (!cur) scoreMap.set(r.foodid, { row: r, score: 1 });
      else scoreMap.set(r.foodid, { row: r, score: cur.score + 1 });
    }
  }

  const ranked = Array.from(scoreMap.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(maxCandidates, 8))
    .map((x) => x.row);

  // If retrieval is still empty, try a last-resort split on canonical words
  if (ranked.length === 0 && pass1.canonical_name) {
    const parts = sanitizeKeyword(pass1.canonical_name).split(' ').filter((p) => p.length >= 3);
    for (const p of parts.slice(0, 3)) {
      const rows = await fetchLukeByToken(p);
      for (const r of rows) {
        const cur = scoreMap.get(r.foodid);
        if (!cur) scoreMap.set(r.foodid, { row: r, score: 1 });
        else scoreMap.set(r.foodid, { row: r, score: cur.score + 1 });
      }
    }
    const reranked = Array.from(scoreMap.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(maxCandidates, 8))
      .map((x) => x.row);
    return reranked.slice(0, maxCandidates);
  }

  return ranked.slice(0, maxCandidates);
}

async function getRestaurantInfo(restaurantId: string): Promise<{ id: string; source_system: string; branch_name: string; city: string | null } | null> {
  const { data, error } = await db
    .from('restaurants')
    .select('id, source_system, branch_name, city')
    .eq('id', restaurantId)
    .maybeSingle();

  if (error) throw new Error(`Failed to load restaurant: ${error.message}`);
  if (!data) return null;

  return {
    id: String((data as any).id),
    source_system: String((data as any).source_system),
    branch_name: String((data as any).branch_name),
    city: (data as any).city ? String((data as any).city) : null,
  };
}

async function fetchAllDishIdsForRestaurant(restaurantId: string, dateFrom?: string, dateTo?: string): Promise<number[]> {
  const all: number[] = [];
  let from = 0;

  while (true) {
    let q = db.from('dishes').select('id').eq('restaurant_id', restaurantId);
    if (dateFrom) q = q.gte('menu_date', dateFrom);
    if (dateTo) q = q.lte('menu_date', dateTo);

    const { data, error } = await q.range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`Failed to load dishes for restaurant: ${error.message}`);

    const rows = (data || []) as any[];
    for (const r of rows) {
      const id = Number(r.id);
      if (Number.isFinite(id)) all.push(id);
    }

    if (rows.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }

  return all;
}

async function fetchComponentIdsForDishIds(dishIds: number[]): Promise<number[]> {
  const out: number[] = [];
  for (const chunkIds of chunk(dishIds, IN_CHUNK)) {
    const { data, error } = await db
      .from('dish_components')
      .select('id')
      .in('dish_id', chunkIds)
      .limit(PAGE_SIZE);

    if (error) throw new Error(`Failed to load dish_components: ${error.message}`);

    for (const r of (data || []) as any[]) {
      const id = Number(r.id);
      if (Number.isFinite(id)) out.push(id);
    }
  }
  return out;
}

async function fetchIngredientCoresForComponentIds(componentIds: number[]): Promise<string[]> {
  const out: string[] = [];
  for (const chunkIds of chunk(componentIds, IN_CHUNK)) {
    let from = 0;
    while (true) {
      const { data, error } = await db
        .from('component_ingredients')
        .select('ingredient_core')
        .in('component_id', chunkIds)
        .range(from, from + PAGE_SIZE - 1);

      if (error) throw new Error(`Failed to load component_ingredients: ${error.message}`);

      const rows = (data || []) as any[];
      for (const r of rows) {
        const core = String(r.ingredient_core || '').trim();
        if (core) out.push(core);
      }

      if (rows.length < PAGE_SIZE) break;
      from += PAGE_SIZE;
    }
  }
  return uniqStrings(out);
}

async function filterUnmappedCores(sourceSystem: string, ingredientCores: string[]): Promise<string[]> {
  if (ingredientCores.length === 0) return [];

  const mapped = new Set<string>();

  for (const chunkCores of chunk(ingredientCores, IN_CHUNK)) {
    const { data, error } = await db
      .from('ingredient_mappings')
      .select('ingredient_core')
      .eq('source_system', sourceSystem)
      .eq('is_active', true)
      .in('ingredient_core', chunkCores)
      .limit(PAGE_SIZE);

    if (error) throw new Error(`Failed to load ingredient_mappings: ${error.message}`);

    for (const r of (data || []) as any[]) {
      const core = String(r.ingredient_core || '').trim();
      if (core) mapped.add(core);
    }
  }

  return ingredientCores.filter((c) => !mapped.has(c));
}

// ---------------------- AI Pass 1 ----------------------

async function aiPass1BuildQuery(model: string, ingredientCore: string, rawExamples: string[], verbose: boolean): Promise<Pass1Query> {
  const schemaHint = {
    canonical_name: 'string | null',
    language: 'fi | en | mixed | unknown',
    keywords_fi: ['string'],
    keywords_en: ['string'],
    negative_keywords: ['string'],
    attributes: { any: 'any' },
    notes: 'string',
  };

  const instructions = `
You are extracting a clean search query for matching a kitchen ingredient to a food database.

Input contains:
- ingredient_core: a noisy normalized identifier
- ingredient_raw_examples: 1-8 examples with packaging/noise like weights, bracket notes, % shares, product specs.

Task:
1) Infer the canonical ingredient name (e.g., "tomato puree", "kidney beans", "jalapeno pepper", "spinach").
2) Produce a SHORT set of FI and EN keywords useful for database search.
3) Include negative_keywords to exclude packaging/noise tokens (e.g., "5kg", "pss", "rpa", "%", etc.)
4) Extract useful attributes when present (e.g., dry_matter_pct, fat_pct, form like fresh/frozen/puree/dried, etc.)

Important interpretation rules:
- "Kuiva-ainepitoisuus (dry matter %)" on tomato typically indicates puree/paste/concentrate, NOT "sun-dried in oil".
- Prefer base ingredient terms over composite meals.
- Your output will be used to search name_fi and name_en columns.

Return ONLY strict JSON with this shape:
${JSON.stringify(schemaHint)}

No extra text, no markdown.
`;

  const payload = {
    ingredient_core: ingredientCore,
    ingredient_raw_examples: rawExamples,
  };

  const resp = await client.responses.create({
    model,
    instructions,
    input: JSON.stringify(payload),
  });

  const text = resp.output_text || '';
  if (verbose) {
    console.log('\n[pass1] Raw model output:\n', text);
  }

  const fallback: Pass1Query = {
    canonical_name: null,
    language: 'unknown',
    keywords_fi: [],
    keywords_en: [],
    negative_keywords: [],
    attributes: {},
    notes: 'fallback_parse_error',
  };

  const parsed = safeJsonParse<Pass1Query>(text, fallback);

  // Normalize lists
  parsed.keywords_fi = uniqStrings((parsed.keywords_fi || []).map(String));
  parsed.keywords_en = uniqStrings((parsed.keywords_en || []).map(String));
  parsed.negative_keywords = uniqStrings((parsed.negative_keywords || []).map(String));
  parsed.canonical_name = parsed.canonical_name ? String(parsed.canonical_name).trim() : null;
  parsed.notes = String(parsed.notes || '');

  return parsed;
}

// ---------------------- AI Pass 2 ----------------------

async function aiPass2Choose(
  model: string,
  ingredientCore: string,
  rawExamples: string[],
  pass1: Pass1Query,
  candidates: LukeFood[],
  verbose: boolean
): Promise<Pass2Choice> {
  const instructions = `
You are selecting the best matching foodid from a short candidate list.

Rules:
- Prefer the simplest base ingredient over composite meals or prepared products.
- Avoid "in oil", "meal replacement", and ready dishes unless raw text explicitly indicates it.
- If tomato has "kuiva-ainepitoisuus (dry matter %)" or looks like concentrate/puree, pick tomato puree/paste/crushed/puree rather than sun-dried in oil.
- If none is acceptable, return foodid = null.

Return ONLY strict JSON:
{ "foodid": number | null, "confidence": number (0..1), "reason": string }
No extra text.
`;

  const payload = {
    ingredient_core: ingredientCore,
    ingredient_raw_examples: rawExamples,
    pass1_query: pass1,
    candidates: candidates.map((c) => ({
      foodid: c.foodid,
      name_en: c.name_en,
      name_fi: c.name_fi,
      kg_co2e_per_kg: c.kg_co2e_per_kg,
      fuclass: c.fuclass || null,
      igclass: c.igclass || null,
    })),
  };

  if (verbose) {
    console.log('\n[pass2] Candidates sent to model:');
    console.log(
      payload.candidates.map((c) => ({
        foodid: c.foodid,
        name_en: c.name_en,
        name_fi: c.name_fi,
        kg_co2e_per_kg: c.kg_co2e_per_kg,
      }))
    );
  }

  const resp = await client.responses.create({
    model,
    instructions,
    input: JSON.stringify(payload),
  });

  const text = resp.output_text || '';
  if (verbose) {
    console.log('\n[pass2] Raw model output:\n', text);
  }

  const fallback: Pass2Choice = { foodid: null, confidence: 0, reason: 'parse_error' };
  const parsed = safeJsonParse<Pass2Choice>(text, fallback);

  parsed.confidence = clamp01(parsed.confidence);
  parsed.reason = String(parsed.reason || '');

  // Ensure foodid is either null or number
  if (parsed.foodid !== null) {
    const n = Number(parsed.foodid);
    parsed.foodid = Number.isFinite(n) ? n : null;
  }

  return parsed;
}

// ---------------------- Save mapping (optional) ----------------------

async function upsertMapping(args: {
  sourceSystem: string;
  ingredientCore: string;
  foodid: number | null;
  confidence: number;
  matchType: 'ai_auto' | 'ai_manual' | 'unknown';
}) {
  const { error } = await db
    .from('ingredient_mappings')
    .upsert(
      {
        source_system: args.sourceSystem,
        ingredient_core: args.ingredientCore,
        luke_foodid: args.foodid,
        match_type: args.matchType,
        ai_confidence: args.confidence,
        weight_state: 'cooked',
        is_active: true,
      },
      { onConflict: 'source_system,ingredient_core' }
    );

  if (error) throw new Error(`DB upsert failed: ${error.message}`);
}

// ---------------------- Single-core runner ----------------------

async function runOneCore(opt: CliOptions, ingredientCore: string) {
  const rawExamples = await loadRawExamples(ingredientCore, 8);

  if (opt.verbose) {
    console.log('\nExample ingredient_raw values:', rawExamples);
  }

  // Pass 1: build query
  const pass1 = await aiPass1BuildQuery(opt.model, ingredientCore, rawExamples, opt.verbose);

  if (opt.verbose) {
    console.log('\n[pass1] Parsed query object:');
    console.dir(pass1, { depth: null });
  }

  // DB retrieval using pass1 tokens
  const candidates = await buildCandidatesFromPass1(pass1, opt.verbose, opt.maxCandidates);

  if (opt.verbose) {
    console.log(`\n[db] Retrieved candidates: ${candidates.length}`);
    console.log(
      candidates.map((c) => ({
        foodid: c.foodid,
        name_en: c.name_en,
        name_fi: c.name_fi,
        kg_co2e_per_kg: c.kg_co2e_per_kg,
      }))
    );
  }

  if (candidates.length === 0) {
    return {
      ingredientCore,
      pass1,
      candidates: 0,
      choice: { foodid: null, confidence: 0, reason: 'no_candidates' } as Pass2Choice,
      saved: false,
    };
  }

  // Pass 2: choose among candidates
  const choice = await aiPass2Choose(opt.model, ingredientCore, rawExamples, pass1, candidates, opt.verbose);

  let saved = false;
  let savedAs: 'ai_auto' | 'ai_manual' | 'unknown' | 'none' = 'none';

  const eligibleAuto = !!choice.foodid && choice.confidence >= CONF_AUTO;

  if (opt.save) {
    if (eligibleAuto) {
      await upsertMapping({
        sourceSystem: opt.sourceSystem,
        ingredientCore,
        foodid: choice.foodid,
        confidence: choice.confidence,
        matchType: 'ai_auto',
      });
      saved = true;
      savedAs = 'ai_auto';
    } else if (opt.saveLow) {
      // Optional: save even if low confidence / no foodid
      await upsertMapping({
        sourceSystem: opt.sourceSystem,
        ingredientCore,
        foodid: choice.foodid,
        confidence: choice.confidence,
        matchType: choice.foodid ? 'ai_manual' : 'unknown',
      });
      saved = true;
      savedAs = choice.foodid ? 'ai_manual' : 'unknown';
    }
  }

  return { ingredientCore, pass1, candidates: candidates.length, choice, saved, savedAs };
}

// ---------------------- Main ----------------------

async function main() {
  const opt = parseArgs(process.argv);

  const isBatch = !!opt.restaurantId && !opt.core;
  const isSingle = !!opt.core;

  if (!isBatch && !isSingle) {
    console.error('Provide either --core "..." OR --restaurant-id <uuid>.');
    process.exit(1);
  }

  if (opt.restaurantId && !isLikelyUuid(opt.restaurantId)) {
    console.error(`Invalid --restaurant-id (expected UUID): ${opt.restaurantId}`);
    process.exit(1);
  }

  console.log('AI two-pass ingredient mapping');
  console.log('model =', opt.model);
  console.log('mapping_source_system =', opt.sourceSystem);
  console.log('save_enabled =', opt.save);
  console.log('save_low_conf =', opt.saveLow);
  console.log('auto_threshold =', CONF_AUTO);

  if (isSingle && opt.core) {
    console.log('mode = single');
    console.log('ingredient_core =', opt.core);

    const result = await runOneCore(opt, opt.core);

    console.log('\n[pass2] Final choice:');
    console.dir(result.choice, { depth: null });

    if (result.saved) {
      console.log(`\n✅ Saved (${result.savedAs}): ${opt.core} -> ${result.choice.foodid} (conf=${result.choice.confidence.toFixed(2)})`);
    } else {
      if (result.choice.foodid && result.choice.confidence >= CONF_AUTO) {
        console.log('\nEligible for auto-save, but --save was not provided.');
      } else {
        console.log('\nNot saved (foodid missing or confidence below threshold; use --save-low if you want to persist anyway).');
      }
    }

    // Manual SQL snippet (always helpful)
    const sqlFoodid = result.choice.foodid ? String(result.choice.foodid) : 'NULL';
    const sqlConf = (result.choice.confidence ?? 0).toFixed(2);
    const sqlMatchType = result.choice.foodid ? 'ai_manual' : 'unknown';

    console.log('\nManual SQL example (if you want to approve/save manually):\n');
    console.log(
      `
insert into ingredient_mappings
(source_system, ingredient_core, luke_foodid, match_type, ai_confidence, weight_state, is_active, co2_override_per_kg)
values
('${opt.sourceSystem}', '${opt.core}', ${sqlFoodid},
 '${sqlMatchType}',
 ${sqlConf},
 'cooked', true, NULL)
on conflict (source_system, ingredient_core)
do update set
  luke_foodid = excluded.luke_foodid,
  match_type = excluded.match_type,
  ai_confidence = excluded.ai_confidence,
  weight_state = excluded.weight_state,
  is_active = excluded.is_active,
  co2_override_per_kg = excluded.co2_override_per_kg;
`.trim()
    );

    console.log('\nDone.');
    return;
  }

  // Batch mode (per restaurant)
  const restaurantId = opt.restaurantId!;
  const info = await getRestaurantInfo(restaurantId);
  if (!info) {
    console.error(`Restaurant not found: ${restaurantId}`);
    process.exit(1);
  }

  console.log('mode = batch');
  console.log(`restaurant = ${info.branch_name}${info.city ? ', ' + info.city : ''} (${info.source_system})`);

  const dishIds = await fetchAllDishIdsForRestaurant(restaurantId, opt.dateFrom, opt.dateTo);
  console.log(`dishes_found = ${dishIds.length}`);

  if (dishIds.length === 0) {
    console.log('No dishes found. Done.');
    return;
  }

  const componentIds = await fetchComponentIdsForDishIds(dishIds);
  console.log(`components_found = ${componentIds.length}`);

  if (componentIds.length === 0) {
    console.log('No dish_components found. Done.');
    return;
  }

  let cores = await fetchIngredientCoresForComponentIds(componentIds);

  if (opt.corePrefix) {
    const p = String(opt.corePrefix).trim();
    if (p) cores = cores.filter((c) => c.startsWith(p));
  }

  if (!opt.includeMapped) {
    cores = await filterUnmappedCores(opt.sourceSystem, cores);
  }

  // Stable ordering helps “resume”
  cores = cores.sort((a, b) => a.localeCompare(b));

  console.log(`ingredient_cores_selected = ${cores.length}`);
  console.log(`processing_limit = ${opt.limit}`);

  const toProcess = cores.slice(0, opt.limit);

  if (toProcess.length === 0) {
    console.log('Nothing to process. Done.');
    return;
  }

  let ok = 0;
  let saved = 0;
  let failed = 0;
  let autoSaved = 0;
  let lowSaved = 0;

  for (let i = 0; i < toProcess.length; i++) {
    const core = toProcess[i];

    console.log(`\n[${i + 1}/${toProcess.length}] core=${core}`);

    try {
      const r = await runOneCore(opt, core);
      ok++;

      const foodidStr = r.choice.foodid ? String(r.choice.foodid) : 'NULL';
      console.log(`choice foodid=${foodidStr} conf=${r.choice.confidence.toFixed(2)} candidates=${r.candidates}`);
      if (r.choice.reason) console.log(`reason: ${r.choice.reason}`);

      if (r.saved) {
        saved++;
        if (r.savedAs === 'ai_auto') autoSaved++;
        if (r.savedAs === 'ai_manual' || r.savedAs === 'unknown') lowSaved++;
        console.log(`✅ saved_as=${r.savedAs}`);
      } else {
        console.log('not_saved');
      }
    } catch (e: any) {
      failed++;
      console.error('[FAIL]', e?.message || e);
      // continue
    }
  }

  console.log('\n[DONE] Batch mapping complete.');
  console.log(`processed_ok=${ok} failed=${failed}`);
  console.log(`saved_total=${saved} (ai_auto=${autoSaved}, low/unknown=${lowSaved})`);
}

main().catch((e) => {
  console.error('aiSuggestMappingTwoPass failed:', e);
  process.exit(1);
});
