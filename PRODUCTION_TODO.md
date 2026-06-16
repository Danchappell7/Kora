# Kanbo — Production Readiness Checklist

Tracking the path from "runs on a laptop" to production. ✅ = done in code,
�doc = done but needs an account/dashboard step from you, ⏳ = not started.

## Deployment & ops
- ✅ Vercel config (`vercel.json`) — SPA rewrites, asset caching
- ✅ Node version pinned (`.nvmrc`, `engines`)
- ✅ Build pipeline / CI (GitHub Actions: typecheck + test + build)
- ✅ Automated tests (Vitest unit tests for the scheduling engine, NL capture, store mappers, date helpers)
- ✅ Environment separation via env vars (`VITE_*`, `.env.example`, `DEPLOYMENT.md`)
- �doc Actual deploy to Vercel + custom domain (needs your Vercel login)
- ✅ Error monitoring wired (Sentry, env-driven — no-op until DSN set)
- �doc Set `VITE_SENTRY_DSN` in prod env (needs your Sentry project)

## Auth & account flows
- ✅ Password reset flow (request + update-password screens)
- ✅ Session-expiry / signed-out handling (auth listener → back to login)
- �doc Branded auth emails + enable Google provider (Supabase dashboard)

## Robustness
- ✅ Toast system + error boundary (replaces `alert()` / bare console)
- ✅ Multi-tab / real-time sync (Supabase Postgres changes subscriptions)
- ✅ Responsive layout (collapsible sidebar + fluid panels on tablet/mobile)
- ✅ Accessibility pass (modal focus traps, ARIA labels, Esc handling, contrast)

## Feature completeness
- ✅ Real comment threads (`comments` table + threaded UI in task detail)
- ✅ Activity feed backend (`activity` table) — powers the Inbox + per-task history + badge
- ✅ Board drag-and-drop (drag cards between status columns, persists)
- ✅ Editable task descriptions (buffered, saves on blur — titles too)
- �doc Run `supabase/migrations/0006_comments_activity.sql` (needs your dashboard)

- ✅ **Team workspaces + invites** — create shared workspaces, invite by email
  (auto-claimed on sign-in), members + workload on the Team page, RLS redesigned
  so workspace members see/edit shared tasks/projects
- ✅ **Assignee picker** — assign tasks to teammates (new-task modal + detail)
- ✅ **Recurring tasks** — daily/weekly/monthly; completing one spawns the next
- �doc Run `supabase/migrations/0007_teams_recurrence.sql` (workspaces, members, RLS)

- ✅ **File attachments** — upload/download/delete on tasks via Supabase Storage
  (migration `0008`), private bucket + signed URLs, follows task visibility
- ✅ **Real LLM AI** — `ai-assist` Edge Function (Claude) prioritizes tasks with
  rationale; "Auto-prioritize" + ⌘K use it, with automatic heuristic fallback
- ✅ **Email reminders** — `daily-reminders` Edge Function (Resend) sends each user
  their due/overdue tasks; schedule via cron
- �doc Run migration `0008`; deploy the two Edge Functions + set their secrets (see DEPLOYMENT.md)

- ✅ **Billing / paywall (Stripe)** — 7-day free trial, then Personal ($8/mo) or
  Team (per-seat) plans. Trial banner, plan picker, full paywall on expiry,
  sidebar billing row + customer portal. `create-checkout` / `customer-portal` /
  `stripe-webhook` Edge Functions; `subscriptions` table (migration `0009`)
- �doc Run migration `0009`; create Stripe prices + deploy the 3 billing functions + set secrets (DEPLOYMENT.md)

### Next phases (larger / external-dependency work)
- ⏳ Calendar integration (Google/Outlook OAuth + Edge Functions) — needs your Google Cloud project + OAuth verification
- ⏳ Board manual ordering, custom fields, dependencies-as-blockers UI

See `DEPLOYMENT.md` for the steps that need your accounts.
