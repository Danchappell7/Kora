-- ============================================================
-- KANBO — sign_in_hints(): the sign-in page's Google hint
-- ALSO PART OF MIGRATION 0047 (section 14, the same statements): a database
-- that ran 0047 already has it. This stand-alone copy is for putting just this
-- function back. Owner notes and the check query:
-- docs/integrations/google-sign-in.md. Safe to run more than once, and
-- harmless where 0047 already made it. Needs approved_domains (0041).
--
-- "Continue with Google" passes Google's `hd` hint (that company's accounts
-- first in the account chooser) when exactly ONE company domain is
-- auto-approved. Signed-out visitors can't read approved_domains (admins
-- only), so this answers just that: { "google_hd": "acme.co.uk" } with one
-- approved domain, { "google_hd": null } with none or several. A hint only:
-- it never decides who gets in.
--
-- Public on purpose: anon may call it, so anyone can learn the ONE
-- auto-approved domain (never a list, and nothing when there are several).
-- It's the domain the sign-in page itself shows ("Shows your @acme.co.uk
-- Google accounts first"). Without the function the app just shows no hint.
-- ============================================================
create or replace function public.sign_in_hints()
returns jsonb language sql security definer stable set search_path = public as $$
  select jsonb_build_object('google_hd',
    (select case when count(*) = 1 then min(d.domain) end from public.approved_domains d));
$$;
revoke execute on function public.sign_in_hints() from public;
grant execute on function public.sign_in_hints() to anon, authenticated, service_role;
