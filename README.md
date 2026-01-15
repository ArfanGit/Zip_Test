### Zip_Test_V2 (Sodexo → Supabase → CO2e)

This repo ingests Sodexo weekly menu JSON into Supabase (Postgres), optionally runs AI to:
- annotate dish component plate shares
- map ingredient/component cores to LUKE foods

Then you can create “donations” and calculate mapped/unmapped/ignored mass + CO2e.

---

### Prereqs

- **Node.js 20+** (some Supabase deps require Node >= 20)
- A **Supabase** project (Postgres)
- Optional for AI features: **OpenAI API key**

---

### One-time: install deps

```powershell
npm install
```

---

### One-time: create database schema

Run `schema.sql` in Supabase SQL editor (Dashboard → SQL → New query → paste → Run).

---

### Environment variables

Create a `.env` file in the repo root (it’s gitignored):

```bash
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...

# for AI scripts:
OPENAI_API_KEY=...

# optional:
OPENAI_MODEL=...
OPENAI_MAX_OUTPUT_TOKENS=2000
```

---

### Main workflow (recommended)

#### 1) Load LUKE foods (needed for meaningful mapping/CO2)

```powershell
npx ts-node src/loadLukeFoods.ts
```

#### 2) Ingest a restaurant menu from a direct JSON URL (does everything)

This downloads the JSON, imports it, runs AI component annotation, then runs AI mapping (saved to DB).

```powershell
npm run ingest:url -- --url "<DIRECT_SODEXO_WEEKLY_JSON_URL>" --city "<CITY>"
```

Example URL format (what you already used):
- `https://www.sodexo.fi/en/ruokalistat/output/weekly_json/<ID>`

#### 3) Create a donation interactively and see CO2e breakdown

```powershell
npm run cli:donate
```

---

### Useful standalone scripts

#### Import local JSON files (no AI)

```powershell
npx ts-node src/importSodexoMenus.ts --files sodexo_data_65.json --city Espoo
```

#### Rebuild ingredient rows from `dish_components.ingredients_raw`

Use this when a dish/component has `ingredients_raw` empty/`[]` and you still want `component_ingredients` rows
(it falls back to `${name_raw} (100%)`).

```powershell
npx ts-node src/rebuildComponentIngredients.ts --dish-id 68 --force
```

#### Run AI annotation only (plate shares + component types)

```powershell
npx ts-node src/aiAnnotateDishComponents.ts --restaurant-id <RESTAURANT_UUID> --limit 999999
```

#### Run AI mapping only (ingredient + component-name cores) and save

```powershell
npx ts-node src/aiSuggestMappingIngredients.ts --restaurant-id <RESTAURANT_UUID> --source SODEXO --limit 999999 --save --save-low
```

#### Debug a donation (full JSON breakdown)

```powershell
npx ts-node src/inspectDonationBreakdown.ts --donation-id <ID> --json
```

---

### Notes / data model (high level)

- `restaurants` → `dishes` → `dish_components` → `component_ingredients`
- `ingredient_mappings` maps **cores** to `luke_foods.foodid`
- CO2e calculator ignores:
  - water/salt
  - tiny shares (<10%)
- If ingredient breakdown is missing, CO2 can fall back to **component-name mapping**
  (e.g. mapping `BASMATIRIISI` directly).

