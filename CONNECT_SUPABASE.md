# Connect to Supabase - Quick Guide

## What is Supabase?
Supabase is a **real, existing service** (like Firebase but for PostgreSQL). It's free to start and provides:
- PostgreSQL database
- REST API
- Real-time subscriptions
- Authentication

## Step 1: Create Supabase Account (if you don't have one)

1. Go to https://supabase.com
2. Click "Start your project" → Sign up (free)
3. Create a new project
4. Wait 2-3 minutes for database to initialize

## Step 2: Get Your Credentials

1. In your Supabase project dashboard
2. Go to **Settings** → **API**
3. Copy:
   - **Project URL** (looks like: `https://xxxxx.supabase.co`)
   - **anon/public key** (long string starting with `eyJ...`)

## Step 3: Create .env File

Create a file named `.env` in your project root:

```env
SUPABASE_URL=https://your-project-id.supabase.co
SUPABASE_ANON_KEY=your-anon-key-here
OPENAI_API_KEY=sk-your-key-here
```

**Important:** Replace with YOUR actual values from Step 2!

## Step 4: Set Up Database Tables

1. In Supabase dashboard → **SQL Editor**
2. Click **New Query**
3. Copy entire contents of `schema.sql` file
4. Paste and click **Run**
5. You should see "Success. No rows returned"

## Step 5: Test Connection

```bash
npm run auto-match
```

If connection works, you'll see:
```
✅ Database connection successful!
```

If it fails, check:
- `.env` file exists and has correct values
- Tables are created (Step 4)
- No typos in URLs/keys

## Step 6: Load Luke Foods Data

Create `src/importLukeFoods.ts`:

```typescript
import { loadLukeFoodsFromCSV } from './loadLukeFoods';
import { initSupabase } from './dbClient';
import * as path from 'path';

const supabase = initSupabase();
const foods = loadLukeFoodsFromCSV(path.resolve(__dirname, '../FoodGWP_dataset_1.09_fixed.csv'));

console.log(`Importing ${foods.length} foods...`);

for (let i = 0; i < foods.length; i += 100) {
  const batch = foods.slice(i, i + 100);
  const { error } = await supabase.from('luke_foods').upsert(batch);
  if (error) {
    console.error(`Error importing batch ${i}:`, error);
  } else {
    console.log(`Imported ${i + batch.length}/${foods.length}`);
  }
}
```

Run it:
```bash
ts-node src/importLukeFoods.ts
```

## That's It! 🎉

Your project is now connected to Supabase. The code will automatically:
- Check database for existing ingredient mappings
- Use AI only for new ingredients
- Save matches to database for future use

## Need Help?

- Supabase docs: https://supabase.com/docs
- Check `.env` file exists and has correct values
- Verify tables exist: Go to Supabase → Table Editor

