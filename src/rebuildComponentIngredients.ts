/**
 * Rebuild component_ingredients rows from dish_components.ingredients_raw.
 * If ingredients_raw is empty/null/[] -> fallback to `${name_raw} (100%)`.
 *
 * Usage:
 *   npx ts-node src/rebuildComponentIngredients.ts --dish-id 16
 *   npx ts-node src/rebuildComponentIngredients.ts --component-id 42
 *   npx ts-node src/rebuildComponentIngredients.ts --restaurant-id <UUID> --limit 200
 *
 * Env:
 *   SUPABASE_URL=...
 *   SUPABASE_SERVICE_ROLE_KEY=...
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

function getArg(name: string): string | null {
  const idx = process.argv.findIndex((a) => a === name);
  if (idx === -1) return null;
  const v = process.argv[idx + 1];
  return v ?? null;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

/** -----------------------------
 * Ingredient parsing helpers (same logic as importer)
 * ------------------------------ */
function parseTrailingSharePct(token: string): number | null {
  const m = token.match(/\((\d+(?:[.,]\d+)?)%\)\s*$/);
  if (!m) return null;
  const v = Number(m[1].replace(",", "."));
  return Number.isFinite(v) ? v : null;
}

function removeTrailingShare(token: string): string {
  return token.replace(/\(\d+(?:[.,]\d+)?%\)\s*$/, "").trim();
}

function splitTopLevelIngredients(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let sq = 0;
  let par = 0;

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];

    if (ch === "[") sq++;
    if (ch === "]" && sq > 0) sq--;
    if (ch === "(") par++;
    if (ch === ")" && par > 0) par--;

    if (ch === "," && sq === 0 && par === 0) {
      const t = cur.trim();
      if (t) out.push(t);
      cur = "";
      continue;
    }

    cur += ch;
  }

  const last = cur.trim();
  if (last) out.push(last);
  return out;
}

function extractBaseAndDescription(tokenNoShare: string): { base: string; desc: string | null } {
  const i = tokenNoShare.indexOf("[");
  if (i === -1) return { base: tokenNoShare.trim(), desc: null };

  const j = tokenNoShare.lastIndexOf("]");
  if (j === -1 || j < i) return { base: tokenNoShare.trim(), desc: null };

  const base = tokenNoShare.slice(0, i).trim();
  const desc = tokenNoShare.slice(i + 1, j).trim();
  return { base: base || tokenNoShare.trim(), desc: desc || null };
}

function normalizeIngredientCore(base: string): string {
  let s = base.trim().toUpperCase();

  s = s.replace(/Ä/g, "A").replace(/Ö/g, "O").replace(/Å/g, "A");

  s = s.replace(/\b\d+[.,]?\d*\s*(KG|G|L|DL|CL|ML)\b/g, " ");
  s = s.replace(/\b\d+[.,]?\d*\b/g, " ");

  s = s.replace(/\b(RTU|KPA|LTN|TANKO)\b/g, " ");

  s = s.replace(/[^A-Z0-9]+/g, "_");
  s = s.replace(/_+/g, "_").replace(/^_+|_+$/g, "");

  return s || "UNKNOWN";
}

function isWater(base: string): boolean {
  return /^vesi\b/i.test(base.trim());
}

function isSalt(base: string): boolean {
  return /\bsuola\b/i.test(base.trim());
}

async function replaceComponentIngredients(componentId: number, rows: any[]): Promise<void> {
  const { error: delErr } = await supabase
    .from("component_ingredients")
    .delete()
    .eq("component_id", componentId);

  if (delErr) throw delErr;

  if (!rows.length) return;

  const { error: insErr } = await supabase.from("component_ingredients").insert(rows);
  if (insErr) throw insErr;
}

function normalizeIngredientsText(ingredientsRaw: any, nameRaw: string): { text: string; isFallback: boolean } {
  const s = (ingredientsRaw ?? "").toString().trim();

  // Treat "", "[]", null as missing
  if (!s || s === "[]") {
    const fallback = `${(nameRaw || "UNKNOWN").trim()} (100%)`;
    return { text: fallback, isFallback: true };
  }

  return { text: s, isFallback: false };
}

async function main() {
  const componentIdArg = getArg("--component-id");
  const dishIdArg = getArg("--dish-id");
  const restaurantIdArg = getArg("--restaurant-id");
  const limitArg = getArg("--limit");
  const dryRun = hasFlag("--dry-run");
  const addRemainderBucket = !hasFlag("--no-remainder-bucket");

  const limit = limitArg ? Number(limitArg) : 500;
  if (limitArg && (!Number.isFinite(limit) || limit <= 0)) {
    throw new Error("--limit must be a positive number");
  }

  if (!componentIdArg && !dishIdArg && !restaurantIdArg) {
    throw new Error("Provide one of: --component-id, --dish-id, --restaurant-id");
  }

  let components: any[] = [];

  if (componentIdArg) {
    const componentId = Number(componentIdArg);
    const { data, error } = await supabase
      .from("dish_components")
      .select("id,dish_id,name_raw,ingredients_raw")
      .eq("id", componentId)
      .limit(1);

    if (error) throw error;
    components = data || [];
  } else if (dishIdArg) {
    const dishId = Number(dishIdArg);
    const { data, error } = await supabase
      .from("dish_components")
      .select("id,dish_id,name_raw,ingredients_raw")
      .eq("dish_id", dishId)
      .order("id", { ascending: true })
      .limit(limit);

    if (error) throw error;
    components = data || [];
  } else if (restaurantIdArg) {
    const restaurantId = restaurantIdArg;

    // Get dish IDs for restaurant
    const { data: dishRows, error: dishErr } = await supabase
      .from("dishes")
      .select("id")
      .eq("restaurant_id", restaurantId)
      .order("menu_date", { ascending: false })
      .limit(limit);

    if (dishErr) throw dishErr;

    const dishIds = (dishRows || []).map((r: any) => r.id);
    if (!dishIds.length) {
      console.log("[DONE] No dishes found for restaurant.");
      return;
    }

    // Get components for those dish IDs
    const { data: compRows, error: compErr } = await supabase
      .from("dish_components")
      .select("id,dish_id,name_raw,ingredients_raw")
      .in("dish_id", dishIds)
      .order("dish_id", { ascending: true })
      .order("id", { ascending: true })
      .limit(limit);

    if (compErr) throw compErr;
    components = compRows || [];
  }

  if (!components.length) {
    console.log("[DONE] No components selected.");
    return;
  }

  // Determine which components already have ingredient rows (batch)
  const componentIds = components.map((c) => c.id);
  const { data: existingRows, error: existErr } = await supabase
    .from("component_ingredients")
    .select("component_id")
    .in("component_id", componentIds);

  if (existErr) throw existErr;

  const existingSet = new Set<number>((existingRows || []).map((r: any) => r.component_id));

  // Only rebuild when missing OR when explicitly component-id/dish-id used (safer default)
  const forceAll = hasFlag("--force");
  const toProcess = forceAll ? components : components.filter((c) => !existingSet.has(c.id));

  console.log(
    `[REBUILD] selected=${components.length} to_process=${toProcess.length} dryRun=${dryRun} addRemainderBucket=${addRemainderBucket}`
  );

  let idx = 0;

  for (const c of toProcess) {
    idx++;
    const componentId = c.id as number;
    const dishId = c.dish_id as number;
    const nameRaw = (c.name_raw || "").toString();

    const { text: ingredientsText, isFallback } = normalizeIngredientsText(c.ingredients_raw, nameRaw);
    const tokens = splitTopLevelIngredients(ingredientsText);

    const rows: any[] = [];
    let seq = 1;

    let declaredSum = 0;
    const missing: string[] = [];

    for (const token of tokens) {
      const share = parseTrailingSharePct(token);
      if (share !== null) declaredSum += share;

      const tokenNoShare = removeTrailingShare(token);
      const { base, desc } = extractBaseAndDescription(tokenNoShare);

      const core = normalizeIngredientCore(base);
      const water = isWater(base);
      const salt = isSalt(base);

      if (share === null) missing.push(token);

      rows.push({
        component_id: componentId,
        seq_no: seq++,
        ingredient_raw: token,
        base_name: base,
        description: desc,
        share_of_component: share,
        share_source: share !== null ? (isFallback ? "assumed_later" : "declared_top") : "unknown",
        ingredient_core: core,
        is_water: water,
        is_salt: salt,
        description_facts: isFallback ? { fallback_from: "name_raw" } : null,
      });
    }

    if (addRemainderBucket && declaredSum > 0 && declaredSum < 100 && missing.length > 0) {
      const remainder = Math.max(0, 100 - declaredSum);
      rows.push({
        component_id: componentId,
        seq_no: seq++,
        ingredient_raw: "OTHER_UNSPECIFIED",
        base_name: "OTHER_UNSPECIFIED",
        description: missing.join(", "),
        share_of_component: remainder,
        share_source: "remainder_bucket",
        ingredient_core: "OTHER_UNSPECIFIED",
        is_water: false,
        is_salt: false,
        description_facts: { missing_count: missing.length },
      });
    }

    console.log(
      `[${idx}/${toProcess.length}] component_id=${componentId} dish_id=${dishId} name="${nameRaw}" tokens=${tokens.length} fallback=${isFallback}`
    );

    if (!dryRun) {
      await replaceComponentIngredients(componentId, rows);
    }
  }

  console.log("[DONE] rebuildComponentIngredients complete.");
}

main().catch((err) => {
  console.error("[FAIL]", err);
  process.exit(1);
});
