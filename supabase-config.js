/*
 * Supabase connection details. Fill these in from your project's
 * Settings → API page, then commit the file.
 *
 * `anonKey` takes either of the two key formats Supabase issues for browsers:
 * the classic `anon` key (a JWT, starts `eyJ`) or the newer publishable key
 * (starts `sb_publishable_`). They carry identical privileges — the same RLS
 * policies apply — so whichever your project shows is the right one.
 *
 * That key is *designed* to be public — it identifies the project, not a
 * person, and grants nothing on its own. What actually protects a collection is
 * Row Level Security on the table (see supabase-schema.sql): Postgres itself
 * refuses to return a row whose user_id isn't the signed-in user. Never put a
 * `service_role` or `sb_secret_` key here — those bypass RLS entirely.
 *
 * Leave the placeholders alone and the site simply runs local-only, exactly as
 * it did before accounts existed.
 */
window.RIFTBOUND_SUPABASE = {
  url: 'YOUR_PROJECT_URL',
  anonKey: 'YOUR_ANON_KEY',
};
