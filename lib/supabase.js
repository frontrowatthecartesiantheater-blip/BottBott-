// Supabase client factory. Server-side only: uses the service-role key,
// which bypasses RLS. Never ship this key to the browser.

import { createClient } from '@supabase/supabase-js';

export function getSupabaseClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');
  }
  return createClient(url, key, { auth: { persistSession: false } });
}
