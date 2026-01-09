-- ============================================================
-- Zipli / Sodexo v2 Schema (Postgres / Supabase)
-- Focus:
--   - Multi-restaurant ingestion
--   - Dishes (menu occurrences) -> dish_components -> component_ingredients
--   - LUKE foods lookup + ingredient_mappings (canonical mapping layer)
--   - Donations + donation_metrics
--
-- Notes:
--   - No source_payloads table (per request)
--   - Dishes excludes allergens_raw, dietcode_images, price_raw (per request)
--   - Bracket descriptions [...] are stored on component_ingredients.description
-- ============================================================

-- Recommended extensions (usually available on Supabase)
create extension if not exists pgcrypto;

-- ============================================================
-- 1) restaurants
-- ============================================================
create table if not exists public.restaurants (
  -- Use Sodexo Mashie ID as the primary identifier (e.g., FI119179K)
  id text primary key,
  source_system text not null default 'SODEXO',
  name text null,
  ref_url text null,
  created_at timestamptz not null default now()
);

create index if not exists idx_restaurants_source_system
  on public.restaurants (source_system);

-- ============================================================
-- 2) luke_foods (lookup table)
-- ============================================================
create table if not exists public.luke_foods (
  foodid integer primary key,

  name_fi text null,
  name_en text null,
  name_sv text null,

  fuclass text null,
  igclass text null,
  fuclass_substitute text null,

  -- Carbon factors (store both if you have them)
  kg_co2e_per_kg numeric(10,4) null,
  g_co2e_per_100g numeric(10,4) null,

  data_quality text null,
  average_source text null
);

create index if not exists idx_luke_foods_name_fi
  on public.luke_foods (name_fi);

create index if not exists idx_luke_foods_name_en
  on public.luke_foods (name_en);

-- ============================================================
-- 3) ingredient_mappings (canonical mapping layer)
-- ============================================================
create table if not exists public.ingredient_mappings (
  id bigserial primary key,
  ingredient_core text not null,
  luke_foodid integer null,

  match_type text not null default 'manual',
  weight_state text not null default 'ignore',

  yield_cooked_per_raw numeric(6,3) null,
  co2_override_per_kg numeric(10,4) null,

  is_active boolean not null default true,
  source_system text not null default 'SODEXO_LADONLUKKO',
  ai_confidence numeric(3,2) null,

  constraint ingredient_mappings_source_core_unique unique (source_system, ingredient_core),

  constraint ingredient_mappings_luke_foodid_fkey
    foreign key (luke_foodid) references public.luke_foods (foodid),

  constraint match_type_valid check (
    match_type = any (array['unknown','ai_auto','ai_manual','manual'])
  )
);

create unique index if not exists uniq_active_mapping_per_source_core
  on public.ingredient_mappings (source_system, ingredient_core)
  where (is_active = true);

create index if not exists idx_ingredient_mappings_source_core
  on public.ingredient_mappings (source_system, ingredient_core);

create index if not exists idx_ingredient_mappings_source_core_active
  on public.ingredient_mappings (source_system, ingredient_core)
  where (is_active = true);

-- ============================================================
-- 4) dishes (menu occurrences)
-- ============================================================
create table if not exists public.dishes (
  id bigserial primary key,

  -- Reference restaurants.id (Sodexo mashie id)
  restaurant_id text not null references public.restaurants (id) on delete restrict,

  -- Sodexo course id/key (e.g. "1","2","3"... from JSON courses object)
  sodexo_course_id text not null,

  menu_date date not null,

  title_fi text not null,
  title_en text null,
  title_sv text null,

  category text null,
  dietcodes text null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint dishes_restaurant_date_course_unique
    unique (restaurant_id, menu_date, sodexo_course_id)
);

create index if not exists idx_dishes_restaurant_date
  on public.dishes (restaurant_id, menu_date);

create index if not exists idx_dishes_menu_date
  on public.dishes (menu_date);

-- ============================================================
-- 5) dish_components (recipes/parts under a dish)
-- ============================================================
create table if not exists public.dish_components (
  id bigserial primary key,

  dish_id bigint not null references public.dishes (id) on delete cascade,

  -- Sodexo recipe key (e.g. "0","1"... from JSON recipes object)
  sodexo_recipe_key text not null,

  name_raw text not null,

  -- Keep raw fields for audit/debug (optional but useful)
  ingredients_raw text null,
  nutrients_raw text null,

  is_main_component boolean not null default false,

  -- Plate share is how much of the dish/plate this component represents (0..1)
  plate_share numeric(6,4) null,
  plate_share_source text not null default 'unset'
    check (plate_share_source in ('unset','heuristic','ai','manual')),
  plate_share_confidence numeric(3,2) null,

  created_at timestamptz not null default now(),

  constraint dish_components_dish_recipe_unique
    unique (dish_id, sodexo_recipe_key)
);

create index if not exists idx_dish_components_dish_id
  on public.dish_components (dish_id);

-- ============================================================
-- 6) component_ingredients (parsed top-level ingredient tokens)
--    Bracket [...] stored in description; percentages only from trailing (xx%)
-- ============================================================
create table if not exists public.component_ingredients (
  id bigserial primary key,

  component_id bigint not null references public.dish_components (id) on delete cascade,

  -- Stable order within the component's top-level list
  seq_no integer not null,

  -- Raw token from the ingredient list (top-level token)
  ingredient_raw text not null,

  -- Derived fields:
  --   base_name = text before '['
  --   description = content inside '[...]' (unmodified)
  base_name text not null,
  description text null,

  -- Share of component as a percentage (0..100), typically from trailing "(xx%)"
  share_of_component numeric(6,2) null,
  share_source text not null default 'unknown'
    check (share_source in ('declared_top','remainder_bucket','assumed_later','unknown')),

  -- Normalized key used for mapping table
  ingredient_core text not null,

  -- Heuristics for filtering low-impact items (optional)
  is_water boolean not null default false,
  is_salt boolean not null default false,

  -- Optional extracted facts from description (e.g., internal percents like "liha 52%")
  description_facts jsonb null,

  created_at timestamptz not null default now(),

  constraint component_ingredients_component_seq_unique
    unique (component_id, seq_no)
);

create index if not exists idx_component_ingredients_component_id
  on public.component_ingredients (component_id);

create index if not exists idx_component_ingredients_core
  on public.component_ingredients (ingredient_core);

-- ============================================================
-- 7) donations (event data)
-- ============================================================
create table if not exists public.donations (
  id bigserial primary key,

  -- Your kitchen/restaurant identifier in your app domain (not necessarily Sodexo mashie id)
  kitchen_id text not null,

  dish_id bigint not null references public.dishes (id) on delete restrict,

  -- Optional: donation can be tied to a component (if component-level weights tracked)
  component_id bigint null references public.dish_components (id) on delete set null,

  donated_weight_kg numeric(10,4) not null,

  donated_at timestamptz not null default now()
);

create index if not exists idx_donations_kitchen_id
  on public.donations (kitchen_id);

create index if not exists idx_donations_donated_at
  on public.donations (donated_at);

create index if not exists idx_donations_dish_id
  on public.donations (dish_id);

-- ============================================================
-- 8) donation_metrics (computed results)
--    One row per donation
-- ============================================================
create table if not exists public.donation_metrics (
  donation_id bigint primary key references public.donations (id) on delete cascade,

  total_co2e_kg numeric(12,4) not null default 0,
  total_food_mass_kg numeric(12,4) not null default 0,
  unmapped_mass_kg numeric(12,4) not null default 0,

  created_at timestamptz not null default now()
);

-- ============================================================
-- 9) updated_at triggers (for dishes)
-- ============================================================
create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_dishes_updated_at on public.dishes;
create trigger trg_dishes_updated_at
before update on public.dishes
for each row execute function public.set_updated_at();
