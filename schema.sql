-- schema.sql
-- Core tables for surplus food carbon accounting

-- 1. Luke / Fineli climate reference data
CREATE TABLE IF NOT EXISTS luke_foods (
  foodid              INTEGER PRIMARY KEY,
  name_fi             TEXT NOT NULL,
  name_en             TEXT NOT NULL,
  name_sv             TEXT NOT NULL,
  fuclass             TEXT NOT NULL,
  igclass             TEXT NOT NULL,
  fuclass_substitute  TEXT,
  kg_co2e_per_kg      NUMERIC(10,4) NOT NULL,
  g_co2e_per_100g     NUMERIC(10,2) NOT NULL,
  data_quality        TEXT NOT NULL,
  average_source      TEXT NOT NULL
);

-- 2. Dishes (e.g. "Chicken curry with rice" on a given date)
CREATE TABLE IF NOT EXISTS dishes (
  id                BIGSERIAL PRIMARY KEY,
  restaurant_id     TEXT,
  sodexo_course_id  TEXT,
  menu_date         DATE,
  title_fi          TEXT,
  title_en          TEXT,
  title_sv          TEXT,
  category          TEXT,
  dietcodes         TEXT
);

CREATE INDEX IF NOT EXISTS idx_dishes_restaurant_date
  ON dishes (restaurant_id, menu_date);

-- 3. Components of a dish (e.g. "Chicken curry", "Boiled rice")
CREATE TABLE IF NOT EXISTS dish_components (
  id                 BIGSERIAL PRIMARY KEY,
  dish_id            BIGINT NOT NULL REFERENCES dishes(id) ON DELETE CASCADE,
  sodexo_recipe_key  TEXT,
  name_raw           TEXT NOT NULL,
  is_main_component  BOOLEAN DEFAULT FALSE,
  plate_share        NUMERIC(5,4)
);

CREATE INDEX IF NOT EXISTS idx_dish_components_dish_id
  ON dish_components (dish_id);

-- 4. Ingredients per component, with mass fractions
CREATE TABLE IF NOT EXISTS component_ingredients (
  id                   BIGSERIAL PRIMARY KEY,
  component_id         BIGINT NOT NULL REFERENCES dish_components(id) ON DELETE CASCADE,
  ingredient_raw       TEXT NOT NULL,
  ingredient_core      TEXT NOT NULL,
  share_of_component   NUMERIC(5,4),
  is_water             BOOLEAN DEFAULT FALSE,
  is_salt              BOOLEAN DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_component_ingredients_component_id
  ON component_ingredients (component_id);

-- 5. Mapping Sodexo ingredient tokens -> Luke foods + yield info
CREATE TABLE IF NOT EXISTS ingredient_mappings (
  id                    BIGSERIAL PRIMARY KEY,
  ingredient_core       TEXT NOT NULL UNIQUE,
  luke_foodid           INTEGER REFERENCES luke_foods(foodid),
  match_type            TEXT NOT NULL DEFAULT 'unknown',   -- 'exact' | 'similar' | 'category' | 'unknown'
  weight_state          TEXT NOT NULL DEFAULT 'ignore',    -- 'raw' | 'cooked' | 'ignore'
  yield_cooked_per_raw  NUMERIC(6,3),                      -- y = cooked_kg / raw_kg
  co2_override_per_kg   NUMERIC(10,4),                     -- optional override
  is_active             BOOLEAN NOT NULL DEFAULT TRUE
);

-- 6. Surplus donations (operational events)
CREATE TABLE IF NOT EXISTS donations (
  id                   BIGSERIAL PRIMARY KEY,
  kitchen_id           TEXT,
  dish_id              BIGINT REFERENCES dishes(id),
  component_id         BIGINT REFERENCES dish_components(id),
  donated_weight_kg    NUMERIC(10,3) NOT NULL,
  donated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_donations_kitchen_time
  ON donations (kitchen_id, donated_at);

-- 7. Precomputed metrics for donations
CREATE TABLE IF NOT EXISTS donation_metrics (
  donation_id           BIGINT PRIMARY KEY REFERENCES donations(id) ON DELETE CASCADE,
  total_co2e_kg         NUMERIC(12,4) NOT NULL,
  total_food_mass_kg    NUMERIC(12,4) NOT NULL,
  unmapped_mass_kg      NUMERIC(12,4) NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
