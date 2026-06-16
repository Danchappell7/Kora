# Kanbo

A futuristic, time-native task management OS — **Apple "white-glass" super-premium** aesthetic
(frosted translucent surfaces, SF Pro typography, azure accent), light default with a dark toggle.

This is the production implementation of the `Kanbo.html` design handoff, rebuilt as a
**Vite + React + TypeScript** app. Every screen from the prototype is implemented:

- **Plan my day** (default landing) — a day canvas where your meetings and time-blocked tasks live
  on one timeline, with a live "now" line, natural-language capture, drag-to-schedule, and a
  one-press **AI Auto-plan** that arranges the day around meetings (deep work up front, admin after
  lunch) and explains its reasoning.
- **Home** — AI daily brief, stat tiles, AI-ordered focus queue, week-productivity sparkline, project cards.
- **My tasks** — a working view switcher: **List** (the showpiece: grouping, expandable subtasks,
  dependency locks, inline AI priority scores, AI smart-sort), **Board** (Kanban), **Timeline**
  (Gantt with a glowing today line), **Calendar**.
- **Task detail** slide-over — status picker, metadata, dependencies (blocks / blocked-by),
  subtasks, activity, AI "schedule a focus block" suggestion.
- **Deep Work focus mode** — full-screen timer takeover with AI-suggested tasks and 25/50/90-min goals.
- **Inbox**, **Team** (with workload), **Analytics**, workspace switching, a **⌘K AI command palette**,
  and a **light/dark theme toggle**.

## Getting started

Requires **Node 18+**.

```bash
npm install
npm run dev      # start the dev server (Vite prints the local URL)
```

Other scripts:

```bash
npm run build      # typecheck (tsc --noEmit) + production build to dist/
npm run preview    # preview the production build
npm run typecheck  # typecheck only
```

## Backend (Supabase auth + persistence)

The app runs in two modes, chosen automatically by whether the Supabase env
vars are present — **no code change** to switch:

- **Demo mode** (default, no env): in-memory seeded data, auto-signed-in as a
  demo user. Great for design review and local hacking.
- **Supabase mode**: real Postgres persistence + auth. Tasks are stored per user
  and gated behind a login screen.

To connect a real backend:

1. **Create a Supabase project** (supabase.com). From *Project Settings → API*,
   copy the **Project URL** and the **anon public key**.
2. **Run the schema:** apply the files in `supabase/migrations/` in order
   (paste into the dashboard SQL editor, or `supabase db push`).
   - `0001_init.sql` — `tasks` / `subtasks` / `task_dependencies` tables + RLS
   - `0002_remove_demo_seed.sql` — new accounts start as a clean slate
   - `0003_projects.sql` — user-created `projects` table + RLS
   - `0004_tags.sql` — user-created `tags` table + RLS
3. **Enable auth providers:** in *Authentication → Providers*, email is on by
   default; enable **Google** if you want the "Continue with Google" button (add
   your OAuth client + redirect URL).
4. **Set env vars:** `cp .env.example .env` and fill in:
   ```
   VITE_SUPABASE_URL=https://<project>.supabase.co
   VITE_SUPABASE_ANON_KEY=<anon key>
   ```
5. `npm run dev` — you'll now get the login screen, and tasks persist.

**What's persisted:** task create / edit (title, status, priority, due date, tags) /
delete, subtask add + toggle, project creation, and the Auto-plan / drag-to-schedule
`scheduled` edits — all per user. Workspaces and teammates are still front-end
reference data (real accounts get one Personal workspace); the Inbox/notifications
and comment threads are UI-only until a notifications backend is added.

## Architecture

```
src/
  main.tsx                 # entry — wraps <App> in <AuthProvider>, imports the design-system CSS
  App.tsx                  # shell: auth gate, store-backed state, routing, ⌘K, theme, tasks page
  app-types.ts             # Route / view union types
  lib/supabase.ts          # Supabase client (null in demo mode)
  auth/
    AuthProvider.tsx       # session context — synthetic user in demo mode, real session in Supabase mode
    LoginScreen.tsx        # email + Google sign-in (Supabase mode only)
  styles/kanbo.css          # the design system (tokens, glass, animations) — copied 1:1 from the prototype
  data/
    types.ts               # domain types (Task, Project, Member, CalEvent, …)
    data.ts                # reference data + helpers + the "Plan my day" engine (planDay, parseCapture)
    store.ts               # data access — one interface, mock + Supabase adapters behind the Task type
  hooks/useFocusTimer.ts   # deep-work timer
  components/
    primitives/            # Icon, Avatar, StatusDot, Check, Tag, PriorityFlag, AiScore, Segmented, tooltips
    charts/                # Ring, Sparkline, Bars, Heatmap (lightweight SVG)
    Sidebar.tsx Topbar.tsx CommandPalette.tsx TaskDetail.tsx
    tasks/                 # ListView (showpiece) + Board/Timeline/Calendar
    views/                 # PlanView (hero), HomeView, AnalyticsView, InboxTeam, FocusMode
supabase/
  migrations/0001_init.sql # schema + RLS + per-user demo seed
```

### Notes

- **Design system is token-driven.** `styles/kanbo.css` defines every color/spacing/shadow as a CSS
  custom property under `:root` / `[data-theme="dark"]`, so the whole app re-themes from one place.
  Inline styles in components were preserved verbatim from the prototype to keep it pixel-perfect.
- **Store abstraction.** All data access goes through `data/store.ts`, which exposes one interface
  with two adapters (mock + Supabase) selected at runtime. Components depend only on the `Task`
  type, never on the data source — so the same UI works against in-memory demo data or Postgres.
- **Auth.** `auth/AuthProvider.tsx` provides a synthetic always-on user in demo mode and tracks the
  real Supabase session otherwise; `App.tsx` gates the app behind `LoginScreen` when configured.
- Still stubbed for a later increment: persisting the Auto-plan `scheduled` edits, drag-reordering
  on the boards, and moving projects/workspaces/teammates into Postgres.
