/**
 * Interactive CLI: pick restaurant -> choose date range -> list donations + CO2 totals.
 *
 * Run:
 *   npm run donations:range
 *
 * Env (.env):
 *   SUPABASE_URL=...
 *   SUPABASE_SERVICE_ROLE_KEY=...
 *
 * Notes:
 * - donation_metrics may be missing for old donations; this script can compute+upsert them using computeDonationCarbon.
 */
import "dotenv/config";
import prompts from "prompts";
import { db } from "./dbClient";
import { computeDonationCarbon } from "./carbonCalculator";

type RestaurantChoice = { id: string; label: string };

type DonationRow = {
  id: number;
  kitchen_id: string;
  dish_id: number;
  component_id: number | null;
  donated_weight_kg: number;
  donated_at: string;
};

function numOrNull(x: unknown): number | null {
  const n = typeof x === "number" ? x : Number(x);
  return Number.isFinite(n) ? n : null;
}

function fmtKg(n: number, digits = 3) {
  if (!Number.isFinite(n)) return "0";
  return `${n.toFixed(digits)} kg`;
}

function fmtCo2(n: number, digits = 4) {
  if (!Number.isFinite(n)) return "0";
  return `${n.toFixed(digits)} kgCO2e`;
}

function isIsoDate(s: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test((s || "").trim());
}

async function loadRestaurants(): Promise<RestaurantChoice[]> {
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

  const try2 = await db.from("restaurants").select("id, name").order("id", { ascending: true }).limit(5000);
  if (try2.error) throw new Error(`Failed to load restaurants: ${try2.error.message}`);
  return (try2.data || []).map((r: any) => ({ id: String(r.id), label: String(r.name || r.id) }));
}

async function loadDishTitles(dishIds: number[]): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  if (!dishIds.length) return map;

  const { data, error } = await db
    .from("dishes")
    .select("id, title_fi, title_en, menu_date")
    .in("id", dishIds);

  if (error) throw new Error(`Failed to load dishes: ${error.message}`);

  for (const d of (data || []) as any[]) {
    const id = Number(d.id);
    const title = String(d.title_fi || d.title_en || `dish#${id}`);
    const date = d.menu_date ? String(d.menu_date) : "";
    map.set(id, date ? `${title} (${date})` : title);
  }
  return map;
}

async function main() {
  const restaurants = await loadRestaurants();
  if (!restaurants.length) throw new Error("No restaurants found.");

  const { restaurantId } = await prompts(
    {
      type: "autocomplete",
      name: "restaurantId",
      message: "Pick a restaurant",
      choices: restaurants.map((r) => ({ title: r.label, value: r.id })),
      limit: 20,
    },
    { onCancel: () => process.exit(0) }
  );

  if (!restaurantId) process.exit(0);

  const { dateFrom } = await prompts(
    {
      type: "text",
      name: "dateFrom",
      message: "From date (YYYY-MM-DD, empty = no lower bound)",
      validate: (v: string) => (!v || isIsoDate(v) ? true : "Use YYYY-MM-DD"),
    },
    { onCancel: () => process.exit(0) }
  );

  const { dateTo } = await prompts(
    {
      type: "text",
      name: "dateTo",
      message: "To date (YYYY-MM-DD, empty = no upper bound)",
      validate: (v: string) => (!v || isIsoDate(v) ? true : "Use YYYY-MM-DD"),
    },
    { onCancel: () => process.exit(0) }
  );

  const from = (dateFrom || "").trim() || null;
  const to = (dateTo || "").trim() || null;

  const { computeMissing } = await prompts(
    {
      type: "toggle",
      name: "computeMissing",
      message: "Compute CO2 for donations missing donation_metrics?",
      initial: true,
      active: "yes",
      inactive: "no",
    },
    { onCancel: () => process.exit(0) }
  );

  const { computeBreakdown } = await prompts(
    {
      type: "toggle",
      name: "computeBreakdown",
      message: "Also compute mapped/unmapped/ignored mass per donation? (slower)",
      initial: true,
      active: "yes",
      inactive: "no",
    },
    { onCancel: () => process.exit(0) }
  );

  let q = db
    .from("donations")
    .select("id, kitchen_id, dish_id, component_id, donated_weight_kg, donated_at")
    .eq("kitchen_id", String(restaurantId))
    .order("donated_at", { ascending: false })
    .limit(5000);

  if (from) q = q.gte("donated_at", `${from}T00:00:00Z`);
  if (to) q = q.lte("donated_at", `${to}T23:59:59Z`);

  const { data: donationsData, error: donErr } = await q;
  if (donErr) throw new Error(`Failed to load donations: ${donErr.message}`);

  const donations: DonationRow[] = (donationsData || []).map((d: any) => ({
    id: Number(d.id),
    kitchen_id: String(d.kitchen_id),
    dish_id: Number(d.dish_id),
    component_id: d.component_id == null ? null : Number(d.component_id),
    donated_weight_kg: Number(d.donated_weight_kg),
    donated_at: String(d.donated_at),
  }));

  console.log("\n=== Donations report ===");
  console.log(`Restaurant: ${restaurants.find((r) => r.id === String(restaurantId))?.label ?? String(restaurantId)}`);
  console.log(`Range:      ${from ?? "(any)"} → ${to ?? "(any)"}`);
  console.log(`Count:      ${donations.length}`);

  if (!donations.length) return;

  const dishIds = Array.from(new Set(donations.map((d) => d.dish_id).filter((x) => Number.isFinite(x))));
  const dishTitleById = await loadDishTitles(dishIds);

  const donationIds = donations.map((d) => d.id);
  const { data: metricsData, error: metErr } = await db
    .from("donation_metrics")
    .select("donation_id, total_co2e_kg, total_food_mass_kg, unmapped_mass_kg")
    .in("donation_id", donationIds);

  if (metErr) throw new Error(`Failed to load donation_metrics: ${metErr.message}`);

  const metricsById = new Map<number, { total_co2e_kg: number; total_food_mass_kg: number; unmapped_mass_kg: number }>();
  for (const m of (metricsData || []) as any[]) {
    metricsById.set(Number(m.donation_id), {
      total_co2e_kg: Number(m.total_co2e_kg),
      total_food_mass_kg: Number(m.total_food_mass_kg),
      unmapped_mass_kg: Number(m.unmapped_mass_kg),
    });
  }

  // Fill missing metrics if requested (co2 + unmapped)
  if (computeMissing) {
    const missing = donationIds.filter((id) => !metricsById.has(id));
    if (missing.length) {
      console.log(`\n[INFO] Computing missing donation_metrics for ${missing.length} donations...`);
      for (const id of missing) {
        try {
          const r = await computeDonationCarbon(id);
          metricsById.set(id, {
            total_co2e_kg: r.total_co2e_kg,
            total_food_mass_kg: r.total_food_mass_kg,
            unmapped_mass_kg: r.unmapped_mass_kg,
          });
        } catch (e: any) {
          console.log(`[WARN] donation_id=${id} compute failed: ${e?.message || e}`);
        }
      }
    }
  }

  // Optionally compute per-donation mapped/unmapped/ignored (requires computeDonationCarbon)
  const massById = new Map<number, { mapped: number; unmapped: number; ignored: number }>();
  if (computeBreakdown) {
    console.log(`\n[INFO] Computing mapped/unmapped/ignored for ${donationIds.length} donations...`);
    for (const id of donationIds) {
      try {
        const r = await computeDonationCarbon(id);
        massById.set(id, { mapped: r.mapped_mass_kg, unmapped: r.unmapped_mass_kg, ignored: r.ignored_mass_kg });
        // metricsById may also be missing; ensure it exists for printing CO2
        if (!metricsById.has(id)) {
          metricsById.set(id, {
            total_co2e_kg: r.total_co2e_kg,
            total_food_mass_kg: r.total_food_mass_kg,
            unmapped_mass_kg: r.unmapped_mass_kg,
          });
        }
      } catch (e: any) {
        console.log(`[WARN] donation_id=${id} compute failed: ${e?.message || e}`);
      }
    }
  }

  let totalWeight = 0;
  let totalCo2 = 0;
  let totalMapped = 0;
  let totalUnmapped = 0;
  let totalIgnored = 0;

  console.log("\nDonations:");
  for (const d of donations) {
    const dishTitle = dishTitleById.get(d.dish_id) ?? `dish#${d.dish_id}`;
    const met = metricsById.get(d.id);
    const co2 = met ? met.total_co2e_kg : null;
    const mass = massById.get(d.id) || null;

    totalWeight += d.donated_weight_kg;
    if (co2 != null && Number.isFinite(co2)) totalCo2 += co2;
    if (mass) {
      totalMapped += mass.mapped;
      totalUnmapped += mass.unmapped;
      totalIgnored += mass.ignored;
    }

    const base = `- id=${d.id}  at=${d.donated_at}  dish="${dishTitle}"  weight=${fmtKg(d.donated_weight_kg)}  co2=${
      co2 == null ? "(missing)" : fmtCo2(co2)
    }`;

    if (!computeBreakdown) {
      console.log(base);
    } else {
      console.log(
        `${base}  mapped=${mass ? fmtKg(mass.mapped) : "(missing)"}  unmapped=${mass ? fmtKg(mass.unmapped) : "(missing)"}  ignored=${
          mass ? fmtKg(mass.ignored) : "(missing)"
        }`
      );
    }
  }

  console.log("\nTotals:");
  console.log(`- total_donated_weight: ${fmtKg(totalWeight)}`);
  console.log(`- total_co2e:           ${fmtCo2(totalCo2)}`);
  if (computeBreakdown) {
    console.log(`- total_mapped:         ${fmtKg(totalMapped)}`);
    console.log(`- total_unmapped:       ${fmtKg(totalUnmapped)}`);
    console.log(`- total_ignored:        ${fmtKg(totalIgnored)}`);
  }
}

main().catch((e: any) => {
  console.error("[FAIL]", e?.message || e);
  process.exit(1);
});

