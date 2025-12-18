# Setup Guide - CO₂ from Surplus Food

## Prerequisites

### 1. **Node.js & npm**
- Node.js v18+ (check: `node --version`)
- npm v9+ (check: `npm --version`)

### 2. **Database** (Choose one)

#### Option A: PostgreSQL (Local/Remote)
- PostgreSQL 12+ installed
- Database created
- Connection string ready

#### Option B: Supabase (Recommended - Free tier available)
- Supabase account: https://supabase.com
- Project created
- API URL and anon key

### 3. **OpenAI API Key** (Optional - for AI matching)
- Get from: https://platform.openai.com/api-keys
- Required only if using AI ingredient matching

### 4. **Data Files** (Already present)
- ✅ `FoodGWP_dataset_1.09_fixed.csv` - CO₂ reference data
- ✅ `json_sodexo.txt` - Restaurant menu data

---

## Installation Steps

### Step 1: Install Dependencies
```bash
npm install
```

### Step 2: Install Database Client

**For Supabase:**
```bash
npm install @supabase/supabase-js
```

**For PostgreSQL (using pg):**
```bash
npm install pg @types/pg
```

**For Knex.js (SQL query builder):**
```bash
npm install knex
npm install pg @types/pg  # or mysql2, sqlite3, etc.
```

### Step 3: Set Up Database

#### Using Supabase:
1. Go to your Supabase project → SQL Editor
2. Copy contents of `schema.sql`
3. Run the SQL to create tables

#### Using PostgreSQL:
```bash
# Connect to your database
psql -U your_user -d your_database

# Run schema
\i schema.sql
```

### Step 4: Load Luke Foods Data

Create a script to import CSV into `luke_foods` table:

```typescript
// src/importLukeFoods.ts
import { loadLukeFoodsFromCSV } from './loadLukeFoods';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_KEY!
);

const foods = loadLukeFoodsFromCSV('./FoodGWP_dataset_1.09_fixed.csv');

for (const food of foods) {
  await supabase.from('luke_foods').upsert(food);
}
```

### Step 5: Configure Environment Variables

Create `.env` file:
```env
# Database (Supabase example)
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_KEY=your-anon-key

# Or PostgreSQL
DATABASE_URL=postgresql://user:password@localhost:5432/dbname

# OpenAI (optional)
OPENAI_API_KEY=sk-your-key-here
```

### Step 6: Update Database Client

Edit `src/autoMatchRunner.ts` and replace `createMockDbClient()`:

```typescript
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_KEY!
);

const db: DbClient = {
  from: (table) => supabase.from(table)
};
```

Do the same in:
- `srcsodexoImporter.ts`
- `srccarbonCalculator.ts`
- Any other files using `DbClient`

---

## Running the Project

### 1. **Match Demo** (No database needed)
```bash
npm run match-demo
```
Tests ingredient matching with fuzzy logic.

### 2. **Import Sodexo Menu** (Requires database)
```bash
# Create import script that calls importSodexoMenu()
npm run import-menu
```

### 3. **Auto-Match Ingredients** (Requires database + OpenAI)
```bash
# Review mode
npm run auto-match

# Auto-approve high confidence matches
npm run auto-match:approve
```

### 4. **Calculate CO₂ for Donation** (Requires database)
```bash
# Create script that calls computeDonationCarbon()
npm run calculate-co2
```

---

## Project Structure

```
Zip_Test/
├── src/
│   ├── aiMatcher.ts          # AI/fuzzy ingredient matching
│   ├── autoMatcher.ts        # Auto-match with DB caching
│   ├── autoMatchRunner.ts    # CLI for batch matching
│   ├── loadLukeFoods.ts     # CSV parser
│   ├── matchDemo.ts          # Demo script
│   └── integrateAutoMatch.ts # Integration examples
├── srccarbonCalculator.ts    # CO₂ calculation engine
├── srcsodexoImporter.ts      # Menu import logic
├── srctypes.ts               # TypeScript types
├── schema.sql                # Database schema
├── FoodGWP_dataset_1.09_fixed.csv  # CO₂ reference data
└── json_sodexo.txt           # Restaurant menu data
```

---

## Quick Start Checklist

- [ ] Node.js installed
- [ ] `npm install` completed
- [ ] Database client library installed (`@supabase/supabase-js` or `pg`)
- [ ] Database created and schema.sql run
- [ ] `.env` file created with credentials
- [ ] Database client configured in code
- [ ] Luke foods CSV imported to database
- [ ] OpenAI API key set (optional, for AI matching)

---

## Testing Without Database

You can test matching logic without database:
```bash
npm run match-demo
```

This uses fuzzy matching only (no AI, no DB).

---

## Troubleshooting

### "Cannot find module '@supabase/supabase-js'"
→ Run: `npm install @supabase/supabase-js`

### "OPENAI_API_KEY not set"
→ Set environment variable or add to `.env` file

### "Database connection failed"
→ Check your database credentials in `.env`
→ Verify database is running
→ Check network/firewall settings

### "Table does not exist"
→ Run `schema.sql` in your database

---

## Next Steps

1. **Import menu data**: Use `srcsodexoImporter.ts` to import `json_sodexo.txt`
2. **Match ingredients**: Run `npm run auto-match` to match unmapped ingredients
3. **Create donations**: Insert test donations into `donations` table
4. **Calculate CO₂**: Use `srccarbonCalculator.ts` to compute emissions

