require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");

async function main() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    console.log("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env");
    process.exit(1);
  }

  const supabase = createClient(url, key, {
    auth: { persistSession: false },
  });

  // Storage is always available and does not require any tables to exist.
  const { data, error } = await supabase.storage.listBuckets();

  if (error) {
    console.log("ERROR:", error);
    process.exit(1);
  }

  console.log("Connected OK. Buckets:", Array.isArray(data) ? data.length : 0);
  if (Array.isArray(data) && data.length) {
    console.log("Bucket names:", data.map((b) => b.name));
  }
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
