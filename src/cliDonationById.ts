/**
 * Print an existing donation result (by donation id) in a readable format.
 *
 * Run:
 *   npm run donation:show -- --donation-id 26
 *
 * Env (.env):
 *   SUPABASE_URL=...
 *   SUPABASE_SERVICE_ROLE_KEY=...
 */
import "dotenv/config";
import { computeDonationBreakdown } from "./donationBreakdown";

function getArg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : (process.argv[i + 1] ?? null);
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function toInt(x: string | null): number | null {
  if (!x) return null;
  const n = Number.parseInt(x, 10);
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

async function main() {
  const donationId = toInt(getArg("--donation-id"));
  const asJson = hasFlag("--json");

  if (!donationId || donationId <= 0) {
    throw new Error("Usage: npm run donation:show -- --donation-id <number> [--json]");
  }

  const breakdown = await computeDonationBreakdown(donationId);

  if (asJson) {
    console.log(JSON.stringify(breakdown, null, 2));
    return;
  }

  const restLabel = breakdown.restaurant?.label ?? breakdown.donation.kitchen_id ?? "(unknown restaurant)";
  const dishTitle = (breakdown.dish?.title_fi || breakdown.dish?.title_en || "").trim() || "(unknown dish)";
  const dishMeta = [
    breakdown.dish?.menu_date ? `date=${breakdown.dish.menu_date}` : null,
    breakdown.dish?.category ? `category=${breakdown.dish.category}` : null,
  ]
    .filter(Boolean)
    .join("  ");

  console.log("\n=== Donation result ===");
  console.log(`Restaurant: ${restLabel}`);
  console.log(`Dish:       ${dishTitle}${breakdown.dish?.id ? ` (id=${breakdown.dish.id})` : ""}${dishMeta ? `  ${dishMeta}` : ""}`);
  console.log(
    `Donation:   id=${breakdown.donation.id}  weight=${fmtKg(breakdown.donation.donated_weight_kg)}  at=${breakdown.donation.donated_at || "(unknown)"}`
  );

  printSection("Totals");
  console.log(`Total CO2e: ${fmtCo2(breakdown.totals.total_co2e_kg)}  (${fmtCo2(breakdown.totals.co2_per_kg, 4)}/kg)`);
  console.log(`Mapped:     ${fmtKg(breakdown.totals.mapped_mass_kg)}`);
  console.log(`Unmapped:   ${fmtKg(breakdown.totals.unmapped_mass_kg)}`);
  console.log(`Ignored:    ${fmtKg(breakdown.totals.ignored_mass_kg)}`);
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
        } ${lukeStr ? `(${lukeStr})` : ""}  reason=${it.reason}`
      );
    }
    if (mappedItems.length > MAX_ITEMS) console.log(`... and ${mappedItems.length - MAX_ITEMS} more`);
  }

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
      console.log(
        `- ${it.base_name} [${it.ingredient_core}]  mass=${fmtKg(it.cooked_mass_kg)}${shareStr ? `  share=${shareStr}` : ""}  reason=${it.reason}`
      );
    }
    if (ignoredItems.length > MAX_ITEMS) console.log(`... and ${ignoredItems.length - MAX_ITEMS} more`);
  }
}

main().catch((e: any) => {
  console.error("[FAIL]", e?.message || e);
  process.exit(1);
});

