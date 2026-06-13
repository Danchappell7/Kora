# Deploying Kora

Everything code-side for production is in place (CI, tests, monitoring hooks,
error handling, real-time sync, auth flows, responsive + a11y). The steps below
are the ones that need **your accounts** — they can't be done from the codebase.

## 1. Deploy to Vercel (frontend)

The app is a static Vite SPA — any static host works; these are Vercel steps.

1. Push this repo to GitHub.
2. In Vercel: **New Project → import the repo**. Framework preset = **Vite**
   (the included `vercel.json` already sets build command, output dir, and SPA
   rewrites).
3. Add **Environment Variables** (Project → Settings → Environment Variables):
   | Name | Value |
   |---|---|
   | `VITE_SUPABASE_URL` | `https://htnchiljplrnjkwimgla.supabase.co` |
   | `VITE_SUPABASE_ANON_KEY` | your anon key |
   | `VITE_SENTRY_DSN` | (optional) your Sentry DSN |
   | `VITE_APP_ENV` | `production` |
   Set these for **Production** (and a separate set for **Preview** if you want a
   staging Supabase project — that's the env separation).
4. Deploy. Add a custom domain under Project → Domains.

**Important:** after you have the deployed URL, set it in Supabase →
**Authentication → URL Configuration → Site URL** (and add it to Redirect URLs),
so email-confirm / password-reset / Google links return to the live app.

## 2. Supabase dashboard (auth polish)

- **Email templates** (Authentication → Email Templates): brand the confirm /
  reset / magic-link emails. Right now they use Supabase's defaults.
- **SMTP** (Authentication → Emails → SMTP): connect Resend/Postmark/SES so mail
  comes from your domain and isn't rate-limited. *(Required before real traffic.)*
- **Google provider** (Authentication → Providers → Google): add your OAuth
  client ID/secret + redirect URL to light up the "Continue with Google" button.
- The password-reset flow is already built in the app — it just needs the Site
  URL (above) set so the reset link lands back here.

## 3. Sentry (error monitoring) — optional but recommended

1. Create a Sentry project (React).
2. Put its DSN in `VITE_SENTRY_DSN` (Vercel env).
   The app already initializes Sentry, reports caught errors, attaches the user,
   and has a top-level error boundary. With no DSN it's a silent no-op.

## 4. CI

`.github/workflows/ci.yml` runs typecheck + tests + build on every push/PR to
`main`. No setup needed beyond pushing to GitHub. For auto-deploy, connecting the
repo to Vercel (step 1) gives you preview deploys per PR automatically.

## Edge Functions (AI + email reminders) — optional

These add real LLM prioritization and daily reminder emails. The app works
without them (AI falls back to a local heuristic; reminders simply don't send).
Requires the Supabase CLI (`brew install supabase/tap/supabase`).

**Real AI (`ai-assist`)** — Claude-backed task prioritization:
```bash
supabase functions deploy ai-assist
supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
```
Once deployed, "Auto-prioritize my day" and the ⌘K palette use Claude; otherwise
they use the built-in heuristic automatically.

**Daily reminders (`daily-reminders`)** — emails each user their due/overdue tasks:
```bash
supabase functions deploy daily-reminders --no-verify-jwt
supabase secrets set RESEND_API_KEY=re_...           # resend.com
supabase secrets set REMINDER_FROM="Kora <no-reply@yourdomain.com>"
supabase secrets set APP_URL=https://your-app.vercel.app
```
Then schedule it daily (Supabase Dashboard → Database → Cron, or pg_cron) — the
exact SQL is in the header comment of `supabase/functions/daily-reminders/index.ts`.

## Billing (Stripe) — 7-day trial then Personal/Team plans

The trial works with no setup (every account gets 7 days). To actually charge,
connect Stripe:

1. **Stripe products** — in the Stripe Dashboard create two recurring prices:
   a **Personal** monthly price and a **Team** monthly price (set as *per-seat* /
   "per unit"). Copy both **price IDs** (`price_...`).
2. **Deploy the functions:**
   ```bash
   supabase functions deploy create-checkout
   supabase functions deploy customer-portal
   supabase functions deploy stripe-webhook --no-verify-jwt
   ```
3. **Set secrets:**
   ```bash
   supabase secrets set STRIPE_SECRET_KEY=sk_live_...
   supabase secrets set STRIPE_PRICE_PERSONAL=price_...
   supabase secrets set STRIPE_PRICE_TEAM=price_...
   supabase secrets set STRIPE_WEBHOOK_SECRET=whsec_...
   ```
4. **Webhook** — in Stripe → Developers → Webhooks, add the `stripe-webhook`
   function URL and subscribe to `checkout.session.completed`,
   `customer.subscription.updated`, `customer.subscription.deleted`. Put the
   signing secret in `STRIPE_WEBHOOK_SECRET` (step 3).
5. Run migration `0009_billing.sql`.

Until Stripe is connected, "Choose plan" shows a friendly "checkout isn't
connected yet" message and the trial still counts down. Team plans bill for the
number of active workspace members (seats) automatically.

## Database migrations

Apply `supabase/migrations/*.sql` in order in the Supabase SQL editor (or
`supabase db push`). `0001`–`0005` are already applied on your project; re-running
them is safe (they use `if not exists` / `add table`).

## Local development

```bash
npm install
cp .env.example .env   # fill in Supabase values (or leave blank for demo mode)
npm run dev
```

Scripts: `npm test` (watch), `npm run test:run`, `npm run build`, `npm run ci`.
