/**
 * Ingest Sodexo JSON from a direct URL and run the full backend pipeline:
 *  - download JSON to temp file
 *  - import into DB (restaurants/dishes/dish_components/component_ingredients)
 *  - resolve restaurant UUID
 *  - AI annotate dish_components (plate_share + component_type)
 *  - AI suggest ingredient mappings (ingredient_core -> luke_foods.foodid) and save
 *
 * Run:
 *   npm run ingest:url -- --url "<json_url>" --city "Espoo"
 *
 * Required env:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   OPENAI_API_KEY
 *
 * Optional env:
 *   OPENAI_MODEL
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import prompts from "prompts";
import { db } from "./dbClient";

type SodexoJson = {
  meta: {
    generated_timestamp: number;
    ref_url?: string;
    ref_title?: string;
    restaurant_mashie_id?: string;
  };
  timeperiod?: string;
  mealdates?: any[];
};

function getArg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : (process.argv[i + 1] ?? null);
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function requireEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name} in .env`);
  return v;
}

function safeFileName(s: string) {
  return (s || "")
    .trim()
    .replace(/[^\w.-]+/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 120);
}

async function downloadJson(url: string): Promise<{ json: SodexoJson; rawText: string }> {
  const res = await fetch(url, {
    headers: {
      accept: "application/json,text/plain,*/*",
      "user-agent": "Zip_Test_V2/ingestFromUrl",
    },
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch url=${url} status=${res.status} ${res.statusText}`);
  }
  const rawText = await res.text();
  const json = JSON.parse(rawText) as SodexoJson;
  if (!json?.meta?.generated_timestamp) {
    throw new Error("Downloaded JSON does not look like expected Sodexo shape (missing meta.generated_timestamp)");
  }
  return { json, rawText };
}

async function runCmd(exe: string, args: string[], opts?: { title?: string }) {
  const title = opts?.title || `${exe} ${args.join(" ")}`;
  console.log(`\n[RUN] ${title}`);
  return await new Promise<void>((resolve, reject) => {
    const child = spawn(exe, args, {
      stdio: "inherit",
      shell: true, // important for Windows + npx
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Command failed (exit=${code}): ${title}`));
    });
  });
}

async function findRestaurantId(params: {
  mashieId: string | null;
  branchName: string | null;
  city: string | null;
}): Promise<string> {
  const { mashieId, branchName, city } = params;

  // Prefer external id if available (most stable)
  if (mashieId) {
    const { data, error } = await db
      .from("restaurants")
      .select("id")
      .eq("external_system", "MASHIE")
      .eq("external_restaurant_id", mashieId)
      .limit(1);

    if (error) throw new Error(`Failed querying restaurants by external id: ${error.message}`);
    if (data && data.length) return String((data[0] as any).id);
  }

  // Fallback: source_system + branch_name + city
  if (branchName) {
    let q = db.from("restaurants").select("id").eq("source_system", "SODEXO").eq("branch_name", branchName);
    q = city === null ? q.is("city", null) : q.eq("city", city);

    const { data, error } = await q.limit(1);
    if (error) throw new Error(`Failed querying restaurants by branch/city: ${error.message}`);
    if (data && data.length) return String((data[0] as any).id);
  }

  throw new Error(
    `Could not resolve restaurant id after import (mashieId=${mashieId ?? "null"} branchName=${branchName ?? "null"} city=${city ?? "null"})`
  );
}

async function lukeFoodsSeemsLoaded(): Promise<boolean> {
  const { data, error } = await db.from("luke_foods").select("foodid").limit(1);
  if (error) throw new Error(`Failed querying luke_foods: ${error.message}`);
  return Array.isArray(data) && data.length > 0;
}

async function main() {
  // env requirements
  requireEnv("SUPABASE_URL");
  requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  requireEnv("OPENAI_API_KEY");

  const url = getArg("--url");
  if (!url) {
    throw new Error('Usage: npm run ingest:url -- --url "<direct_json_url>" [--city "Espoo"] [--limit-annotate 200] [--limit-map 50]');
  }

  // User preference: process everything by default (use huge limits).
  const limitAnnotate = Number(getArg("--limit-annotate") ?? "999999");
  const limitMap = Number(getArg("--limit-map") ?? "999999");
  const keepFile = hasFlag("--keep-file");

  let city = getArg("--city");
  if (!city) {
    const ans = await prompts(
      {
        type: "text",
        name: "city",
        message: "City to store on restaurants.city (optional, press enter for null)",
      },
      {
        onCancel: () => process.exit(0),
      }
    );
    city = (ans.city || "").trim() || null;
  }

  // User preference: fixed mapping source system for now
  const mappingSource = "SODEXO";

  console.log("\n[INGEST] downloading json...");
  const { json, rawText } = await downloadJson(url);

  const mashieId = json?.meta?.restaurant_mashie_id ? String(json.meta.restaurant_mashie_id).trim() : null;
  const branchName = json?.meta?.ref_title ? String(json.meta.ref_title).trim() : null;

  const tmpDir = path.join(process.cwd(), ".tmp");
  fs.mkdirSync(tmpDir, { recursive: true });

  const base = safeFileName(branchName || mashieId || "sodexo");
  const filePath = path.join(tmpDir, `ingest_${base}_${Date.now()}.json`);
  fs.writeFileSync(filePath, rawText, "utf8");

  console.log(`[INGEST] saved json: ${filePath}`);

  // 1) Import
  await runCmd("npx", ["--yes", "ts-node", "src/importSodexoMenus.ts", "--files", filePath, ...(city ? ["--city", String(city)] : [])], {
    title: "importSodexoMenus",
  });

  // 2) Resolve restaurant UUID
  const restaurantId = await findRestaurantId({ mashieId, branchName, city: city ? String(city) : null });
  console.log(`[INGEST] resolved restaurant_id=${restaurantId}`);

  // 3) Optional: ensure LUKE foods exist before mapping
  const hasLuke = await lukeFoodsSeemsLoaded();
  if (!hasLuke) {
    console.warn(
      "[WARN] luke_foods appears empty. AI mapping will likely return no candidates. Load LUKE first: npx ts-node src/loadLukeFoods.ts"
    );
  }

  // 4) AI annotate components
  await runCmd("npx", ["--yes", "ts-node", "src/aiAnnotateDishComponents.ts", "--restaurant-id", restaurantId, "--limit", String(limitAnnotate)], {
    title: "aiAnnotateDishComponents",
  });

  // 5) AI mapping (save)
  const mapArgs = [
    "--yes",
    "ts-node",
    "src/aiSuggestMappingIngredients.ts",
    "--restaurant-id",
    restaurantId,
    "--source",
    mappingSource,
    "--limit",
    String(limitMap),
    "--save",
  ];

  if (hasFlag("--save-low")) mapArgs.push("--save-low");
  if (hasFlag("--include-mapped")) mapArgs.push("--include-mapped");
  if (hasFlag("--verbose")) mapArgs.push("--verbose");

  await runCmd("npx", mapArgs, { title: "aiSuggestMappingIngredients (two-pass) + save" });

  console.log("\n[DONE] Ingest complete.");
  console.log(`restaurant_id=${restaurantId}`);
  console.log(`mapping_source_system=${mappingSource}`);

  if (!keepFile) {
    try {
      fs.unlinkSync(filePath);
      console.log(`[CLEANUP] deleted temp file ${filePath}`);
    } catch {
      // ignore
    }
  } else {
    console.log(`[KEEP] temp file kept at ${filePath}`);
  }
}

main().catch((e: any) => {
  console.error("[FAIL]", e?.message || e);
  process.exit(1);
});

