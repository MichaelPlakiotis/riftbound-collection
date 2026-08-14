/*
 * Supabase connection details. Fill these in from your project's
 * Settings → API page, then commit the file.
 *
 * The anon key is *designed* to be public — it identifies the project, not a
 * person, and grants nothing on its own. What actually protects a collection is
 * Row Level Security on the table (see supabase-schema.sql): Postgres itself
 * refuses to return a row whose user_id isn't the signed-in user. Never put the
 * `service_role` key here — that one bypasses RLS and must stay secret.
 *
 * Leave the placeholders alone and the site simply runs local-only, exactly as
 * it did before accounts existed.
 */
window.RIFTBOUND_SUPABASE = {
  url: 'YOUR_PROJECT_URL',
  anonKey: 'YOUR_ANON_KEY',
};
