import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } from "../constants.js";

let client: SupabaseClient | null = null;

/**
 * Returns a singleton Supabase client authenticated with the service role key.
 * The service role key bypasses Row Level Security, so this client should
 * only ever be used from trusted server-side code (never shipped to a browser/agent).
 */
export function getSupabaseClient(): SupabaseClient {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error(
      "Supabase is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY environment variables."
    );
  }
  if (!client) {
    client = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });
  }
  return client;
}

/**
 * Formats a Supabase/Postgrest error into an actionable message for the calling agent.
 */
export function formatSupabaseError(error: { message: string; code?: string; details?: string | null }): string {
  const parts = [`Supabase error: ${error.message}`];
  if (error.code) parts.push(`(code: ${error.code})`);
  if (error.details) parts.push(`- ${error.details}`);
  return parts.join(" ");
}
