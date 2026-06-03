-- ============================================================
-- KORA — stop auto-seeding demo data on signup.
-- New accounts now start as a clean slate (the app shows an
-- onboarding empty state instead).
--
-- The seed_demo_data(uid) function is kept on purpose, so you can
-- later wire an optional "Load sample data" button that calls it.
-- ============================================================

drop trigger if exists on_auth_user_created on auth.users;
