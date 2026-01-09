// src/createDonationWithMetrics.ts
import "dotenv/config";
import { db } from "./dbClient";
import { computeDonationCarbon, DonationCarbonResult } from "./carbonCalculator";

/**
 * Create a donation row and compute metrics in one go.
 *
 * Usage:
 *  npx ts-node src/createDonationWithMetrics.ts --restaurant-id <UUID> --dish-id 18 --weight-kg 15
 *  npx ts-node src/createDonationWithMetrics.ts --restaurant-id <UUID> --dish-id 18 --component-id 123 --weight-kg 2.5
 *
 * Notes:
 * - donations.kitchen_id is used to store the restaurant UUID string (by design in this v2 schema).
 * - dish_id is required by schema (NOT NULL).
 */

function getArg(name: string): string | null {
  const i = process.argv.indexOf(name);
  if (i === -1) return null;
  return process.argv[i + 1] ?? null;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function toNum(x: string | null): number | null {
  if (!x) return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

async function main() {
  const restaurantId = getArg("--restaurant-id");
  const dishId = toNum(getArg("--dish-id"));
  const componentId = toNum(getArg("--component-id"));
  const weightKg = toNum(getArg("--weight-kg"));
  const donatedAt = getArg("--donated-at"); // optional ISO string
  const dryRun = hasFlag("--dry-run");

  if (!restaurantId) {
    throw new Error("Missing --restaurant-id <UUID>");
  }
  if (!dishId || dishId <= 0) {
    throw new Error("Missing/invalid --dish-id <number>");
  }
  if (!weightKg || weightKg <= 0) {
    throw new Error("Missing/invalid --weight-kg <number>");
  }
  if (componentId !== null && (!Number.isFinite(componentId) || componentId <= 0)) {
    throw new Error("Invalid --component-id <number>");
  }

  // Optional: validate dish belongs to restaurant (recommended)
  // dishes.restaurant_id is uuid; donations.kitchen_id is text (restaurant uuid string)
  const { data: dishRow, error: dishErr } = await db
    .from("dishes")
    .select("id, restaurant_id")
    .eq("id", dishId)
    .single();

  if (dishErr || !dishRow) {
    throw new Error(`Dish ${dishId} not found (or cannot be read): ${dishErr?.message ?? "no row"}`);
  }
  if (String(dishRow.restaurant_id) !== String(restaurantId)) {
    throw new Error(
      `Dish ${dishId} belongs to restaurant_id=${dishRow.restaurant_id}, not the provided --restaurant-id=${restaurantId}`
    );
  }

  // Insert donation
  if (dryRun) {
    console.log("[DRY-RUN] Would insert donation:", {
      kitchen_id: restaurantId,
      dish_id: dishId,
      component_id: componentId,
      donated_weight_kg: weightKg,
      donated_at: donatedAt ?? "(default now())",
    });
    return;
  }

  const donationInsert: any = {
    kitchen_id: restaurantId,
    dish_id: dishId,
    component_id: componentId,
    donated_weight_kg: weightKg,
  };

  if (donatedAt) donationInsert.donated_at = donatedAt;

  const { data: donationCreated, error: insErr } = await db
    .from("donations")
    .insert(donationInsert)
    .select("id, dish_id, component_id, donated_weight_kg, donated_at")
    .single();

  if (insErr || !donationCreated) {
    throw new Error(`Failed to create donation: ${insErr?.message ?? "no row returned"}`);
  }

  const donationId = Number(donationCreated.id);

  // Compute + upsert donation_metrics (computeDonationCarbon does the upsert)
  const result: DonationCarbonResult = await computeDonationCarbon(donationId);

  console.log("[OK] Donation created + metrics computed");
  console.log(result);

  // If you also want a compact summary:
  // (kept here for convenience; remove if you don't want extra logs)
  console.log("[SUMMARY]", {
    donation_id: result.donation_id,
    dish_id: result.dish_id,
    component_id: result.component_id,
    donated_weight_kg: result.donated_weight_kg,
    total_co2e_kg: result.total_co2e_kg,
    co2_per_kg: result.co2_per_kg,
    mapped_mass_kg: result.mapped_mass_kg,
    ignored_mass_kg: result.ignored_mass_kg,
    unmapped_mass_kg: result.unmapped_mass_kg,
  });
}

main().catch((e) => {
  console.error("[FAIL]", e?.message || e);
  process.exit(1);
});
