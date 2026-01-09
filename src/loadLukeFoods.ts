import "dotenv/config";
import fs from "node:fs";
import readline from "node:readline";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

type LukeRow = {
  foodid: number;
  name_fi: string | null;
  name_en: string | null;
  name_sv: string | null;
  fuclass: string | null;
  igclass: string | null;
  fuclass_substitute: string | null;
  kg_co2e_per_kg: number | null;
  g_co2e_per_100g: number | null;
  data_quality: string | null;
  average_source: string | null;
};

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// Quote-aware CSV parsing for comma delimiter and "" escaping
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];

    if (ch === '"') {
      const next = line[i + 1];
      if (inQuotes && next === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (ch === "," && !inQuotes) {
      out.push(cur);
      cur = "";
      continue;
    }

    cur += ch;
  }

  out.push(cur);
  return out.map((s) => s.trim());
}

function n(v: string | undefined): number | null {
  if (!v) return null;
  const s = v.trim().replace(/\s+/g, "").replace(",", ".");
  if (!s) return null;
  const num = Number(s);
  return Number.isFinite(num) ? num : null;
}

function i(v: string | undefined): number | null {
  if (!v) return null;
  const num = Number.parseInt(v.trim(), 10);
  return Number.isFinite(num) ? num : null;
}

function key(h: string): string {
  return h.trim().toLowerCase().replace(/\s+/g, "_");
}

async function main() {
  const fileArgIdx = process.argv.indexOf("--file");
  const fileName =
    fileArgIdx >= 0 && process.argv[fileArgIdx + 1]
      ? process.argv[fileArgIdx + 1]
      : "FoodGWP_dataset_1.09_fixed.csv";

  const filePath = path.isAbsolute(fileName) ? fileName : path.join(process.cwd(), fileName);
  if (!fs.existsSync(filePath)) throw new Error(`CSV not found: ${filePath}`);

  console.log(`Loading LUKE foods from: ${filePath}`);

  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  let headerMap: Record<string, number> | null = null;

  const BATCH_SIZE = 1000;
  let batch: LukeRow[] = [];
  let total = 0;

  for await (const rawLine of rl) {
    const line = rawLine.trimEnd();
    if (!line) continue;

    if (!headerMap) {
      const headers = parseCsvLine(line);
      headerMap = {};
      headers.forEach((h, idx) => (headerMap![key(h)] = idx));

      const required = ["foodid", "foodname_fi"];
      for (const r of required) {
        if (!(r in headerMap)) throw new Error(`Missing required column in CSV header: ${r}`);
      }
      continue;
    }

    const cols = parseCsvLine(line);

    const idx = (name: string) => headerMap![name] ?? -1;
    const get = (name: string) => {
      const j = idx(name);
      return j >= 0 ? cols[j] : undefined;
    };

    const foodid = i(get("foodid"));
    if (!foodid) continue;

    const row: LukeRow = {
      foodid,
      name_fi: get("foodname_fi") ?? null,
      name_en: get("foodname_en") ?? null,
      name_sv: get("foodname_sv") ?? null,
      fuclass: get("fuclass") ?? null,
      igclass: get("igclass") ?? null,
      // NOTE: header has typo: FUCLASS_subsitute
      fuclass_substitute: get("fuclass_subsitute") ?? null,
      // NOTE: these headers include symbols; after key() they become:
      // "kgco2-eq/kg" -> "kgco2-eq/kg" (spaces -> underscores only)
      kg_co2e_per_kg: n(get("kgco2-eq/kg")),
      g_co2e_per_100g: n(get("gco2-eq/100g")),
      data_quality: get("data_quality") ?? get("data_quality".replace("_", " ")) ?? get("data_quality") ?? null,
      // your header is "Data quality" -> key => "data_quality"
      average_source: get("average_source") ?? null,
    };

    batch.push(row);

    if (batch.length >= BATCH_SIZE) {
      const { error } = await supabase.from("luke_foods").upsert(batch, { onConflict: "foodid" });
      if (error) throw new Error(error.message);

      total += batch.length;
      console.log(`Upserted ${total} rows...`);
      batch = [];
    }
  }

  if (batch.length) {
    const { error } = await supabase.from("luke_foods").upsert(batch, { onConflict: "foodid" });
    if (error) throw new Error(error.message);
    total += batch.length;
  }

  console.log(`Done. Upserted ${total} rows into public.luke_foods.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
