/**
 * src/aiAnnotateDishComponents.ts
 *
 * AI annotator: fills dish_components with:
 * - component_type
 * - component_type_confidence
 * - plate_share
 * - plate_share_confidence
 * - ai_meta
 *
 * Improvements:
 * 1) Strict json_schema fixed (all properties required; optional is nullable).
 * 2) Detects percent plate_share and converts (60 => 0.60).
 * 3) One retry if sum still bad.
 * 4) NEW: If still bad but all components returned, FORCE NORMALIZE and write shares anyway.
 *    -> prevents plate_share staying NULL for dishes like your dish_id=28.
 *
 * Env (.env):
 *   SUPABASE_URL=...
 *   SUPABASE_SERVICE_ROLE_KEY=...
 *   OPENAI_API_KEY=...
 *   OPENAI_MODEL=gpt-4o-mini-2024-07-18   (optional)
 *
 * Usage:
 *   npx ts-node src/aiAnnotateDishComponents.ts --restaurant-id <uuid> --limit 50
 *   npx ts-node src/aiAnnotateDishComponents.ts --source SODEXO --branch "Keilaranta 1" --city Espoo --limit 50
 *   npx ts-node src/aiAnnotateDishComponents.ts --restaurant-id <uuid> --dry-run
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import crypto from "node:crypto";

type RestaurantRow = { id: string };

type DishRow = {
  id: number;
  menu_date: string;
  title_fi: string | null;
  title_en: string | null;
  category: string | null;
  dietcodes: string | null;
};

type ComponentRow = {
  id: number;
  dish_id: number;
  name_raw: string;
  ingredients_raw: string | null;
  component_type: string;
  plate_share: number | null;
};

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env");
}
if (!OPENAI_API_KEY) {
  throw new Error("Missing OPENAI_API_KEY in .env");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

const COMPONENT_TYPE_ENUM = [
  "unknown",
  "main",
  "side",
  "salad",
  "sauce",
  "starch",
  "veg",
  "soup",
  "dessert",
  "beverage",
  "bread",
  "condiment",
  "other",
] as const;

type ComponentType = (typeof COMPONENT_TYPE_ENUM)[number];

type AiComponent = {
  component_id: number;
  component_type: ComponentType;
  component_type_confidence: number; // 0..1
  plate_share: number; // expected 0..1, but may arrive as percent
  plate_share_confidence: number; // 0..1
  notes: string | null;
};

function getArg(name: string): string | null {
  const idx = process.argv.findIndex((a) => a === name);
  if (idx === -1) return null;
  return process.argv[idx + 1] ?? null;
}
function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}
function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

async function resolveRestaurantId(): Promise<string> {
  const rid = getArg("--restaurant-id");
  if (rid) return rid;

  const source = getArg("--source");
  const branch = getArg("--branch");
  const city = getArg("--city");

  if (!source || !branch) {
    throw new Error('Provide either --restaurant-id OR (--source AND --branch) (+ optional --city).');
  }

  let q = supabase
    .from("restaurants")
    .select("id")
    .eq("source_system", source)
    .eq("branch_name", branch);

  q = city ? q.eq("city", city) : q;

  const { data, error } = await q.limit(1);
  if (error) throw error;
  if (!data || data.length === 0) {
    throw new Error(`Restaurant not found for source=${source} branch=${branch} city=${city ?? "(any)"}`);
  }
  return (data[0] as RestaurantRow).id;
}

async function fetchDish(dishId: number): Promise<DishRow> {
  const { data, error } = await supabase
    .from("dishes")
    .select("id,menu_date,title_fi,title_en,category,dietcodes")
    .eq("id", dishId)
    .single();
  if (error) throw error;
  return data as DishRow;
}

async function fetchDishComponents(dishId: number): Promise<ComponentRow[]> {
  const { data, error } = await supabase
    .from("dish_components")
    .select("id,dish_id,name_raw,ingredients_raw,component_type,plate_share")
    .eq("dish_id", dishId)
    .order("id", { ascending: true });
  if (error) throw error;
  return (data as any[]) as ComponentRow[];
}

function buildPrompt(dish: DishRow, comps: ComponentRow[], retryHint: string | null): string {
  const lines: string[] = [];

  lines.push(`Dish meta:`);
  lines.push(`- menu_date: ${dish.menu_date}`);
  lines.push(`- title_fi: ${dish.title_fi ?? ""}`);
  lines.push(`- title_en: ${dish.title_en ?? ""}`);
  lines.push(`- category: ${dish.category ?? ""}`);
  lines.push(`- dietcodes: ${dish.dietcodes ?? ""}`);
  lines.push("");

  lines.push(`Task: For each component, output component_type and plate_share for a typical lunch plate.`);
  lines.push(`Rules:`);
  lines.push(`- plate_share MUST be a DECIMAL in [0,1], NOT a percentage.`);
  lines.push(`- Shares across all components MUST sum to exactly 1.0.`);
  lines.push(`- Sauces/condiments usually small (0.03–0.12).`);
  lines.push(`- If uncertain, use component_type="unknown" and lower confidence, but still allocate a reasonable share.`);
  lines.push("");
  lines.push(`Allowed component_type enum: ${COMPONENT_TYPE_ENUM.join(", ")}`);
  lines.push("");

  if (retryHint) {
    lines.push(`IMPORTANT RETRY NOTE: ${retryHint}`);
    lines.push("");
  }

  for (const c of comps) {
    const ingPreview = (c.ingredients_raw ?? "").slice(0, 180).replace(/\s+/g, " ").trim();
    lines.push(`- component_id=${c.id} name="${c.name_raw}" ingredients_preview="${ingPreview}"`);
  }

  return lines.join("\n");
}

function getOutputText(resp: any): string {
  const content = resp?.output?.[0]?.content;
  if (!Array.isArray(content)) throw new Error("OpenAI response missing output content");

  const refusal = content.find((c: any) => c.type === "refusal");
  if (refusal) throw new Error(`Model refusal: ${refusal.refusal}`);

  const out = content.find((c: any) => c.type === "output_text");
  if (!out?.text) throw new Error("No output_text returned from model");
  return out.text as string;
}

function strictSchema() {
  // Strict-mode requirement: every property must appear in required; optional must be nullable.
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      components: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            component_id: { type: "integer" },
            component_type: { type: "string", enum: COMPONENT_TYPE_ENUM },
            component_type_confidence: { type: "number" },
            plate_share: { type: "number" },
            plate_share_confidence: { type: "number" },
            notes: { type: ["string", "null"] },
          },
          required: [
            "component_id",
            "component_type",
            "component_type_confidence",
            "plate_share",
            "plate_share_confidence",
            "notes",
          ],
        },
      },
    },
    required: ["components"],
  } as const;
}

async function callAI(dish: DishRow, comps: ComponentRow[], retryHint: string | null): Promise<AiComponent[]> {
  const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini-2024-07-18";

  const response = await openai.responses.create({
    model: MODEL,
    input: [
      {
        role: "system",
        content:
          "You are a careful food-menu analyst. Classify each component and estimate plate shares for a typical lunch plate. Follow the JSON schema strictly.",
      },
      { role: "user", content: buildPrompt(dish, comps, retryHint) },
    ],
    text: {
      format: {
        type: "json_schema",
        name: "dish_component_annotation",
        strict: true,
        schema: strictSchema(),
      },
    },
    max_output_tokens: 700,
  });

  const jsonText = getOutputText(response);
  const parsed = JSON.parse(jsonText) as { components: AiComponent[] };

  if (!parsed?.components || !Array.isArray(parsed.components)) {
    throw new Error("Model returned invalid JSON: missing components[]");
  }

  return parsed.components.map((c) => ({
    ...c,
    component_type: (COMPONENT_TYPE_ENUM.includes(c.component_type) ? c.component_type : "unknown") as ComponentType,
  }));
}

function sumShares(items: AiComponent[]): number {
  return items.reduce((acc, c) => acc + (Number.isFinite(Number(c.plate_share)) ? Number(c.plate_share) : 0), 0);
}

function detectAndConvertPercent(items: AiComponent[]) {
  const rawShares = items.map((c) => Number(c.plate_share));
  const rawSum = rawShares.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);

  const looksLikePercent =
    rawShares.some((v) => Number.isFinite(v) && v > 1) ||
    (rawSum > 1.5 && rawSum <= 120); // 60+40=100 etc

  if (looksLikePercent) {
    for (const c of items) c.plate_share = Number(c.plate_share) / 100;
  }

  return { looksLikePercent, rawSum };
}

function clampAll(items: AiComponent[]) {
  for (const c of items) {
    c.component_type_confidence = clamp01(Number(c.component_type_confidence));
    c.plate_share_confidence = clamp01(Number(c.plate_share_confidence));
    c.plate_share = Number(c.plate_share);
  }
}

function normalize(items: AiComponent[]): { ok: boolean; sumBefore: number } {
  const sum = sumShares(items);
  if (!Number.isFinite(sum) || sum <= 0) return { ok: false, sumBefore: sum };
  for (const c of items) c.plate_share = c.plate_share / sum;
  return { ok: true, sumBefore: sum };
}

function clampShares01(items: AiComponent[]) {
  for (const c of items) {
    c.plate_share = clamp01(Number(c.plate_share));
  }
}

async function annotateOneDish(dish: DishRow, comps: ComponentRow[], runId: string, dryRun: boolean) {
  const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini-2024-07-18";

  // attempt 1
  let ai = await callAI(dish, comps, null);
  let retried = false;

  // build map
  let byId = new Map<number, AiComponent>();
  for (const c of ai) byId.set(c.component_id, c);

  // keep only known ids in DB order
  let filtered = comps.map((db) => byId.get(db.id)).filter(Boolean) as AiComponent[];
  const expectedCount = comps.length;
  const returnedCount1 = filtered.length;

  // if missing components, we will still write types; shares will be handled later (cannot guarantee sum=1)
  let missingComponents = returnedCount1 !== expectedCount;

  // percent detect + clamp
  const pct1 = detectAndConvertPercent(filtered);
  clampAll(filtered);

  // after converting percent, try strict sum=1 with close-normalize window first
  // (but we will FORCE NORMALIZE if needed later)
  let sumAfterPct1 = sumShares(filtered);

  // If full coverage but sum is obviously bad, do one retry
  // Example: sum==2.0 (likely percent or overshoot) or sum==1.8 etc.
  let retryReason: string | null = null;
  if (!missingComponents) {
    // Prefer retry if sum far from 1 (and not a simple percent case already fixed)
    if (!Number.isFinite(sumAfterPct1) || Math.abs(sumAfterPct1 - 1) > 0.15) {
      retryReason = `sum_after_percent_convert=${sumAfterPct1.toFixed(4)} (need exactly 1.0)`;
    }
  }

  if (retryReason) {
    retried = true;
    ai = await callAI(
      dish,
      comps,
      `Your last output did not produce plate_share that sums to 1. Return DECIMALS in [0,1] and ensure total is EXACTLY 1.0. Do not use percentages.`
    );
    byId = new Map<number, AiComponent>();
    for (const c of ai) byId.set(c.component_id, c);
    filtered = comps.map((db) => byId.get(db.id)).filter(Boolean) as AiComponent[];
  }

  const returnedCountFinal = filtered.length;
  missingComponents = returnedCountFinal !== expectedCount;

  // percent detect again (after retry)
  const pct2 = detectAndConvertPercent(filtered);
  clampAll(filtered);

  const sumAfterPctFinal = sumShares(filtered);

  // Decide plate_share write mode
  // - if missing components: skip shares
  // - else: if sum close to 1, normalize lightly; otherwise FORCE NORMALIZE
  let plateShareWritten = false;
  let plateShareWriteMode: "skipped_missing_components" | "direct_ok" | "normalized_close" | "forced_normalize" = "skipped_missing_components";
  let skipReason: string | null = null;
  let normalizedClose = false;
  let forcedNormalized = false;

  let sumBeforeNormalize: number | null = null;
  let sumFinal: number | null = null;

  if (missingComponents) {
    skipReason = `missing_components_returned_${returnedCountFinal}_expected_${expectedCount}`;
  } else {
    // if sum is already fine
    if (Number.isFinite(sumAfterPctFinal) && Math.abs(sumAfterPctFinal - 1) <= 1e-6) {
      plateShareWritten = true;
      plateShareWriteMode = "direct_ok";
      sumBeforeNormalize = sumAfterPctFinal;
      sumFinal = sumAfterPctFinal;
    } else {
      // if sum close-ish, normalize (close normalize)
      if (Number.isFinite(sumAfterPctFinal) && sumAfterPctFinal > 0 && Math.abs(sumAfterPctFinal - 1) <= 0.02) {
        sumBeforeNormalize = sumAfterPctFinal;
        const n = normalize(filtered);
        if (n.ok) {
          normalizedClose = true;
          plateShareWritten = true;
          plateShareWriteMode = "normalized_close";
          sumFinal = sumShares(filtered);
        } else {
          skipReason = `normalize_failed_sum=${sumAfterPctFinal}`;
        }
      } else {
        // FORCE NORMALIZE fallback (your missing dish_id=28 issue)
        sumBeforeNormalize = sumAfterPctFinal;
        const n = normalize(filtered);
        if (n.ok) {
          forcedNormalized = true;
          plateShareWritten = true;
          plateShareWriteMode = "forced_normalize";
          // clamp for safety after normalize
          clampShares01(filtered);
          sumFinal = sumShares(filtered);

          // Degrade confidence because forced normalize means model was inconsistent
          for (const c of filtered) {
            c.plate_share_confidence = Math.min(c.plate_share_confidence, 0.75);
          }
        } else {
          skipReason = `forced_normalize_failed_sum=${sumAfterPctFinal}`;
        }
      }
    }
  }

  // Ensure final clamp on shares if writing
  if (plateShareWritten) {
    clampShares01(filtered);
    sumFinal = sumShares(filtered);
  }

  if (dryRun) {
    console.log(`[DRY RUN] dish_id=${dish.id} title="${dish.title_fi ?? ""}"`);
    console.log({
      expectedCount,
      returnedCount1,
      returnedCountFinal,
      missingComponents,
      pct_detected_first: pct1.looksLikePercent,
      pct_raw_sum_first: pct1.rawSum,
      pct_detected_final: pct2.looksLikePercent,
      pct_raw_sum_final: pct2.rawSum,
      sumAfterPctFinal,
      sumBeforeNormalize,
      sumFinal,
      retried,
      plateShareWritten,
      plateShareWriteMode,
      normalizedClose,
      forcedNormalized,
      skipReason,
    });
    console.log(filtered);
    return;
  }

  // Write updates per component
  for (const dbComp of comps) {
    const ann = byId.get(dbComp.id);
    if (!ann) continue;

    const update: any = {
      component_type: ann.component_type,
      component_type_confidence: clamp01(Number(ann.component_type_confidence)),
      ai_meta: {
        run_id: runId,
        model: MODEL,
        at: new Date().toISOString(),
        dish_id: dish.id,
        dish_title_fi: dish.title_fi,

        expected_component_count: expectedCount,
        returned_component_count_first: returnedCount1,
        returned_component_count_final: returnedCountFinal,

        percent_detected_first: pct1.looksLikePercent,
        percent_raw_sum_first: pct1.rawSum,
        percent_detected_final: pct2.looksLikePercent,
        percent_raw_sum_final: pct2.rawSum,

        sum_after_percent_convert: sumAfterPctFinal,
        sum_before_normalize: sumBeforeNormalize,
        sum_final: sumFinal,

        retried,
        plate_share_written: plateShareWritten,
        plate_share_write_mode: plateShareWriteMode,
        normalized_close: normalizedClose,
        forced_normalize: forcedNormalized,
        plate_share_skip_reason: skipReason,

        notes: ann.notes ?? null,
      },
    };

    if (plateShareWritten) {
      // Use the processed/normalized share for this component id
      const finalAnn = filtered.find((x) => x.component_id === dbComp.id);
      if (finalAnn) {
        update.plate_share = clamp01(Number(finalAnn.plate_share));
        update.plate_share_confidence = clamp01(Number(finalAnn.plate_share_confidence));
      }
    }

    const { error } = await supabase.from("dish_components").update(update).eq("id", dbComp.id);
    if (error) throw error;
  }
}

async function main() {
  const restaurantId = await resolveRestaurantId();
  const limit = Number(getArg("--limit") ?? "50");
  const dryRun = hasFlag("--dry-run");

  // Dish ids needing AI: unknown type OR missing plate_share
  const { data: needs, error } = await supabase
    .from("dish_components")
    .select("dish_id")
    .or("component_type.eq.unknown,plate_share.is.null")
    .limit(5000);
  if (error) throw error;

  const needsSet = new Set<number>((needs as any[]).map((r) => Number(r.dish_id)).filter(Boolean));

  // Dishes for this restaurant
  const { data: dishRows, error: dishErr } = await supabase
    .from("dishes")
    .select("id")
    .eq("restaurant_id", restaurantId);
  if (dishErr) throw dishErr;

  const dishIds = (dishRows as any[])
    .map((d) => Number(d.id))
    .filter((id) => needsSet.has(id))
    .slice(0, limit);

  const runId = crypto.randomUUID();
  console.log(`[AI] restaurant_id=${restaurantId} dishes_to_process=${dishIds.length} dryRun=${dryRun} run_id=${runId}`);

  for (let i = 0; i < dishIds.length; i++) {
    const dishId = dishIds[i];
    const dish = await fetchDish(dishId);
    const comps = await fetchDishComponents(dishId);
    if (!comps.length) continue;

    console.log(`[AI] (${i + 1}/${dishIds.length}) dish_id=${dishId} date=${dish.menu_date} title=${dish.title_fi ?? ""}`);
    await annotateOneDish(dish, comps, runId, dryRun);
    await sleep(250);
  }

  console.log("[DONE] AI annotation complete.");
}

main().catch((err) => {
  console.error("[FAIL]", err);
  process.exit(1);
});
