/**
 * Interactive CLI: pick restaurant -> pick dish -> enter donation kg
 * Creates a donation row and prints carbon/mapping metrics.
 *
 * Run:
 *   npm run cli:donate
 *
 * Env (.env):
 *   SUPABASE_URL=...
 *   SUPABASE_SERVICE_ROLE_KEY=...
 *   (optional) MAPPING_SOURCE_SYSTEM=...   // defaults to carbonCalculator.ts default
 */
import "dotenv/config";
import prompts from "prompts";
import { db } from "./dbClient";
import { computeDonationBreakdown } from "./donationBreakdown";

type RestaurantChoice = {
  id: string;
  label: string;
};

type DishChoice = {
  id: number;
  label: string;
  menu_date?: string | null;
  title_fi?: string | null;
};

function numOrNull(x: unknown): number | null {
  const n = typeof x === "number" ? x : Number(x);
  return Number.isFinite(n) ? n : null;
}

function isMissingColumnError(e: any) {
  const msg = String(e?.message || "");
  return /column .* does not exist/i.test(msg);
}

function fmtKg(n: number, digits = 3) {
  if (!Number.isFinite(n)) return "0";
  return `${n.toFixed(digits)} kg`;
}

function fmtCo2(n: number, digits = 4) {
  if (!Number.isFinite(n)) return "0";
  return `${n.toFixed(digits)} kgCO2e`;
}

function fmtPct(n: number | null, digits = 1) {
  if (n == null || !Number.isFinite(n)) return "";
  return `${n.toFixed(digits)}%`;
}

function printSection(title: string) {
  console.log(`\n${title}`);
  console.log("-".repeat(Math.min(80, title.length)));
}

function topByMass<T extends { cooked_mass_kg: number }>(rows: T[], limit: number) {
  const sorted = [...rows].sort((a, b) => (b.cooked_mass_kg || 0) - (a.cooked_mass_kg || 0));
  return sorted.slice(0, limit);
}

function groupCount(items: Array<{ ingredient_core: string; base_name: string; reason: string }>) {
  const map = new Map<string, { ingredient_core: string; base_name: string; reason: string; count: number }>();
  for (const it of items) {
    const key = `${it.ingredient_core}|||${it.reason}`;
    const cur = map.get(key);
    if (!cur) {
      map.set(key, { ingredient_core: it.ingredient_core, base_name: it.base_name, reason: it.reason, count: 1 });
    } else {
      cur.count += 1;
    }
  }
  return Array.from(map.values()).sort((a, b) => b.count - a.count);
}

async function loadRestaurants(): Promise<RestaurantChoice[]> {
  // Try “newer” schema first (branch_name/city). If columns don't exist, fall back to simple schema (name).
  const try1 = await db
    .from("restaurants")
    .select("id, branch_name, city, source_system")
    .order("id", { ascending: true })
    .limit(5000);

  if (!try1.error && Array.isArray(try1.data)) {
    return (try1.data as any[]).map((r) => {
      const id = String(r.id);
      const branch = r.branch_name ? String(r.branch_name) : "";
      const city = r.city ? String(r.city) : "";
      const source = r.source_system ? String(r.source_system) : "";

      const primary = branch || id;
      const suffix = [city || null, source || null].filter(Boolean).join(" • ");
      return { id, label: suffix ? `${primary} (${suffix})` : primary };
    });
  }

  // Fallback to minimal selection
  const try2 = await db.from("restaurants").select("id, name").order("id", { ascending: true }).limit(5000);

  if (try2.error) throw new Error(`Failed to load restaurants: ${try2.error.message}`);
  return (try2.data || []).map((r: any) => ({
    id: String(r.id),
    label: String(r.name || r.id),
  }));
}

async function loadDishesForRestaurant(restaurantId: string): Promise<DishChoice[]> {
  const { data, error } = await db
    .from("dishes")
    .select("id, menu_date, title_fi, title_en, category, restaurant_id")
    .eq("restaurant_id", restaurantId)
    .order("menu_date", { ascending: false })
    .order("id", { ascending: false })
    .limit(2000);

  if (error) throw new Error(`Failed to load dishes: ${error.message}`);

  return (data || []).map((d: any) => {
    const id = Number(d.id);
    const date = d.menu_date ? String(d.menu_date) : "";
    const titleFi = d.title_fi ? String(d.title_fi) : "";
    const titleEn = d.title_en ? String(d.title_en) : "";
    const cat = d.category ? String(d.category) : "";

    const title = titleFi || titleEn || `dish#${id}`;
    const parts = [date || null, cat || null].filter(Boolean).join(" • ");
    const label = parts ? `${title} — ${parts} (id=${id})` : `${title} (id=${id})`;

    return { id, label, menu_date: d.menu_date ?? null, title_fi: d.title_fi ?? null };
  });
}

async function assertDishBelongsToRestaurant(dishId: number, restaurantId: string) {
  const { data, error } = await db.from("dishes").select("id, restaurant_id").eq("id", dishId).single();
  if (error || !data) throw new Error(`Dish ${dishId} not found: ${error?.message ?? "no row"}`);

  if (String((data as any).restaurant_id) !== String(restaurantId)) {
    throw new Error(
      `Dish ${dishId} belongs to restaurant_id=${(data as any).restaurant_id}, not selected restaurant_id=${restaurantId}`
    );
  }
}

async function createDonation(args: { restaurantId: string; dishId: number; weightKg: number }) {
  const { data, error } = await db
    .from("donations")
    .insert({
      kitchen_id: args.restaurantId,
      dish_id: args.dishId,
      donated_weight_kg: args.weightKg,
    })
    .select("id, donated_at")
    .single();

  if (error || !data) throw new Error(`Failed to create donation: ${error?.message ?? "no row"}`);
  const id = Number((data as any).id);
  if (!Number.isFinite(id) || id <= 0) throw new Error("Donation insert returned invalid id");
  return { id, donated_at: (data as any).donated_at ?? null };
}

async function main() {
  prompts.override({
    // allow non-interactive runs by setting env vars if desired later
  });

  const restaurants = await loadRestaurants();
  if (!restaurants.length) throw new Error("No restaurants found in DB.");

  const { restaurantId } = await prompts(
    {
      type: "autocomplete",
      name: "restaurantId",
      message: "Pick a restaurant",
      choices: restaurants.map((r) => ({ title: r.label, value: r.id })),
      limit: 20,
    },
    {
      onCancel: () => {
        process.exit(0);
      },
    }
  );

  if (!restaurantId) process.exit(0);

  const dishes = await loadDishesForRestaurant(String(restaurantId));
  if (!dishes.length) throw new Error(`No dishes found for restaurant_id=${restaurantId}`);

  const { dishId } = await prompts(
    {
      type: "autocomplete",
      name: "dishId",
      message: "Pick a dish",
      choices: dishes.map((d) => ({ title: d.label, value: d.id })),
      limit: 20,
    },
    {
      onCancel: () => {
        process.exit(0);
      },
    }
  );

  const dishIdNum = numOrNull(dishId);
  if (!dishIdNum) process.exit(0);

  // safety: ensure the user didn't pick a dish from another restaurant due to stale data
  await assertDishBelongsToRestaurant(dishIdNum, String(restaurantId));

  const { weightKg } = await prompts(
    {
      type: "number",
      name: "weightKg",
      message: "Donation weight (kg)",
      min: 0,
      validate: (v: number) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? true : "Enter a positive number"),
    },
    {
      onCancel: () => {
        process.exit(0);
      },
    }
  );

  const weight = numOrNull(weightKg);
  if (!weight || weight <= 0) process.exit(0);

  const donationCreated = await createDonation({ restaurantId: String(restaurantId), dishId: dishIdNum, weightKg: weight });
  const donationId = donationCreated.id;

  const breakdown = await computeDonationBreakdown(donationId);

  const restLabel = breakdown.restaurant?.label ?? String(restaurantId);
  const dishTitle =
    (breakdown.dish?.title_fi || breakdown.dish?.title_en || "").trim() || `dish#${dishIdNum}`;
  const dishMeta = [
    breakdown.dish?.menu_date ? `date=${breakdown.dish.menu_date}` : null,
    breakdown.dish?.category ? `category=${breakdown.dish.category}` : null,
  ]
    .filter(Boolean)
    .join("  ");

  console.log("\n=== Donation result ===");
  console.log(`Restaurant: ${restLabel}`);
  console.log(`Dish:       ${dishTitle} (id=${dishIdNum})${dishMeta ? `  ${dishMeta}` : ""}`);
  console.log(
    `Donation:   id=${donationId}  weight=${fmtKg(breakdown.donation.donated_weight_kg)}  at=${
      breakdown.donation.donated_at || donationCreated.donated_at || "(default now())"
    }`
  );

  printSection("Totals");
  console.log(`Total CO2e: ${fmtCo2(breakdown.totals.total_co2e_kg)}  (${fmtCo2(breakdown.totals.co2_per_kg, 4)}/kg)`);
  console.log(`Mapped:     ${fmtKg(breakdown.totals.mapped_mass_kg)}`);
  console.log(`Unmapped:   ${fmtKg(breakdown.totals.unmapped_mass_kg)}  (missing shares + missing mapping/factor)`);
  console.log(`Ignored:    ${fmtKg(breakdown.totals.ignored_mass_kg)}  (water/salt/<10% + mapping ignore)`);
  console.log(`Source:     ingredient_mappings.source_system=${breakdown.mapping_source_system}`);

  const mappedItems = breakdown.items.filter((x) => x.status === "mapped" && x.cooked_mass_kg > 0);
  const unmappedItems = breakdown.items.filter((x) => x.status === "unmapped" && x.cooked_mass_kg > 0);
  const unmappedZeroMass = breakdown.items.filter((x) => x.status === "unmapped" && x.cooked_mass_kg <= 0);
  const ignoredItems = breakdown.items.filter((x) => x.status === "ignored" && x.cooked_mass_kg > 0);

  const MAX_ITEMS = 12;

  printSection(`Mapped items (top ${Math.min(MAX_ITEMS, mappedItems.length)} by mass)`);
  if (!mappedItems.length) {
    console.log("(none)");
  } else {
    for (const it of topByMass(mappedItems, MAX_ITEMS)) {
      const factorStr = it.factor_kgco2_per_kg == null ? "" : `${it.factor_kgco2_per_kg.toFixed(4)} kgCO2e/kg`;
      const lukeStr =
        it.luke_foodid != null
          ? `foodid=${it.luke_foodid}${it.luke_name_en || it.luke_name_fi ? ` "${it.luke_name_en || it.luke_name_fi}"` : ""}`
          : "";
      console.log(
        `- ${it.base_name} [${it.ingredient_core}]  mass=${fmtKg(it.cooked_mass_kg)}  co2=${fmtCo2(it.co2e_kg)}  ${
          factorStr ? `factor=${factorStr}` : ""
        } ${lukeStr ? `(${lukeStr})` : ""}`
      );
    }
    if (mappedItems.length > MAX_ITEMS) console.log(`... and ${mappedItems.length - MAX_ITEMS} more`);
  }

  // Optional: show “unmapped with mass” items (missing mapping/factor), but hide the synthetic UNALLOCATED_REMAINDER
  // since we already show the total unmapped weight and list the missing-share ingredients separately.
  const unmappedMassItems = unmappedItems.filter((x) => x.ingredient_core !== "UNALLOCATED_REMAINDER");
  if (unmappedMassItems.length) {
    printSection(`Unmapped items (top ${Math.min(MAX_ITEMS, unmappedMassItems.length)} by mass)`);
    for (const it of topByMass(unmappedMassItems, MAX_ITEMS)) {
      const shareStr = fmtPct(it.share_pct);
      console.log(
        `- ${it.base_name} [${it.ingredient_core}]  mass=${fmtKg(it.cooked_mass_kg)}${shareStr ? `  share=${shareStr}` : ""}  reason=${it.reason}`
      );
    }
    if (unmappedMassItems.length > MAX_ITEMS) console.log(`... and ${unmappedMassItems.length - MAX_ITEMS} more`);
  }

  // Important: rows with share_of_component=NULL are represented as unmapped items with 0 mass
  // (their mass is accounted via UNALLOCATED_REMAINDER). Still show them so the user sees what is missing.
  printSection(`Unmapped items with missing share (count=${unmappedZeroMass.length})`);
  if (!unmappedZeroMass.length) {
    console.log("(none)");
  } else {
    const grouped = groupCount(
      unmappedZeroMass.map((x) => ({
        ingredient_core: x.ingredient_core,
        base_name: x.base_name,
        reason: x.reason,
      }))
    );
    for (const g of grouped.slice(0, MAX_ITEMS)) {
      console.log(`- ${g.base_name} [${g.ingredient_core}]  count=${g.count}  reason=${g.reason}`);
    }
    if (grouped.length > MAX_ITEMS) console.log(`... and ${grouped.length - MAX_ITEMS} more`);
  }

  printSection(`Ignored items (top ${Math.min(MAX_ITEMS, ignoredItems.length)} by mass)`);
  if (!ignoredItems.length) {
    console.log("(none)");
  } else {
    for (const it of topByMass(ignoredItems, MAX_ITEMS)) {
      const shareStr = fmtPct(it.share_pct);
      console.log(`- ${it.base_name} [${it.ingredient_core}]  mass=${fmtKg(it.cooked_mass_kg)}${shareStr ? `  share=${shareStr}` : ""}  reason=${it.reason}`);
    }
    if (ignoredItems.length > MAX_ITEMS) console.log(`... and ${ignoredItems.length - MAX_ITEMS} more`);
  }

  console.log("\nTip: if you want the full debug JSON/table output, run:");
  console.log(`  npx ts-node src/inspectDonationBreakdown.ts --donation-id ${donationId} --json`);
}

main().catch((e: any) => {
  const msg = e?.message || e;
  console.error("[FAIL]", msg);

  // Extra hint for common schema drift
  if (isMissingColumnError(e)) {
    console.error(
      "Looks like your Supabase schema doesn't match what this script expected (missing column). Tell me your actual restaurants/dishes table columns and I’ll adjust."
    );
  }

  process.exit(1);
});

