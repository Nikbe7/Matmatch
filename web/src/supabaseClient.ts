import { createClient } from "@supabase/supabase-js";

// The only place a Supabase client is created. It exists to obtain and hold the
// auth session in the browser — the anon key is public by design and this project's
// Data API is disabled (ARCHITECTURE.md §2), so this client cannot reach the
// database, only auth.

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    "VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY must be set — see web/.env.example",
  );
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey);
