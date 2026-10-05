# Push notifications and the installable app

Kanbo can notify someone's phone or computer when something needs them, even
when Kanbo is closed: a task assigned to them, an @mention, a comment on a task
they own or follow, and the morning due-date reminder. It's standard web push,
so it works in Chrome, Edge, Firefox and Safari (macOS 13+), and on iPhone and
iPad (iOS/iPadOS 16.4+) once Kanbo has been added to the Home Screen.

Each person switches it on per device in **Settings › Notifications › Push
notifications**, and picks which kinds they want (these choices follow them to
every device). Email notifications are unchanged and separate.

Until the steps below are done, nothing changes for anyone: the Push section
stays hidden, and `notify` / `daily-reminders` send email exactly as today.
The Push section also stays hidden until the app runs the sign-out guard
(`watchPushSession()`, see "Wiring into the app"), so push can never be
switched on in a build that wouldn't switch it off again at sign-out.

## What you need first

- Database update **0043** run (`database-0043.md`): it creates
  `push_subscriptions` and `save_push_subscription()`.
- Database update **0044** run straight after it (`database-0044.md`): device
  rows can then only be saved through `save_push_subscription()`, and nobody
  keeps more than 20.
- The Supabase CLI logged in, and the Vercel CLI (or the Vercel dashboard).

## Owner steps

### 1. Make a VAPID key pair (once)

VAPID keys identify Kanbo to the browsers' push services. The private key is a
secret: it lives only in Supabase's function secrets. This one-liner writes a
fresh pair to `~/.kanbo-vapid.env` in your home folder (readable only by you),
without printing either key. Run it from any folder, and replace the email with
the inbox push services should contact about problems:

```sh
node -e 'const c=require("crypto"),fs=require("fs"),f=require("path").join(require("os").homedir(),".kanbo-vapid.env");const j=c.generateKeyPairSync("ec",{namedCurve:"prime256v1"}).privateKey.export({format:"jwk"});const pub=Buffer.concat([Buffer.from([4]),Buffer.from(j.x,"base64url"),Buffer.from(j.y,"base64url")]).toString("base64url");fs.writeFileSync(f,"VAPID_PUBLIC_KEY="+pub+"\nVAPID_PRIVATE_KEY="+j.d+"\nVAPID_SUBJECT=mailto:hello@kanbo.co.uk\n",{mode:0o600,flag:"wx"});console.log("Wrote "+f)'
```

It refuses to overwrite an existing `~/.kanbo-vapid.env`, so you can't replace
a live pair by accident.

**Never put this file in the `kora-app` folder.** `vercel deploy` uploads the
folder as it is on disk: it doesn't read `.gitignore`, and its built-in skip
list only covers `.env.local` and `.env.*.local`. A key file there would end up
in the deployment's source, readable by anyone with access to the Vercel
project.

(`npx web-push generate-vapid-keys --json` makes the same kind of pair if you
prefer; it prints them, so clear your terminal afterwards.)

### 2. Give the keys to the edge functions

```sh
supabase secrets set --env-file "$HOME/.kanbo-vapid.env" --project-ref htnchiljplrnjkwimgla
```

`VAPID_SUBJECT` must be `mailto:…` or an `https://` address. If it's ever
missing, the functions use `APP_URL` (already set).

### 3. Give the public key to the web app (Vercel)

The app needs the **public** key at build time (Vite bakes it in). It is safe
to ship to browsers; never use the private key here.

```sh
grep '^VAPID_PUBLIC_KEY=' "$HOME/.kanbo-vapid.env" | cut -d= -f2- | tr -d '\n' | vercel env add VITE_VAPID_PUBLIC_KEY production
grep '^VAPID_PUBLIC_KEY=' "$HOME/.kanbo-vapid.env" | cut -d= -f2- | tr -d '\n' | vercel env add VITE_VAPID_PUBLIC_KEY preview
```

(Or Vercel › Project › Settings › Environment Variables › add
`VITE_VAPID_PUBLIC_KEY` with the value after `VAPID_PUBLIC_KEY=`.)

### 4. Keep the private key, then delete the file

Put the contents of `~/.kanbo-vapid.env` in your password manager (you only
need it again to move projects), then:

```sh
rm "$HOME/.kanbo-vapid.env"
```

### 5. Redeploy

```sh
supabase functions deploy notify --project-ref htnchiljplrnjkwimgla
supabase functions deploy daily-reminders --no-verify-jwt --project-ref htnchiljplrnjkwimgla
vercel deploy --prod          # or push to main; the new build picks up VITE_VAPID_PUBLIC_KEY
```

`notify` keeps **Verify JWT: ON**; `daily-reminders` stays off (its cron job
and `CRON_SECRET` are unchanged; see DEPLOYMENT.md "Schedule the daily
reminder email").

**Don't rotate the keys casually.** Every device subscribed with the old public
key stops receiving pushes; people have to switch push on again in Settings
(Kanbo notices the new key and offers the switch as off). If you do rotate,
repeat steps 1–5 (step 1 needs the old file gone) and then clear the old
subscriptions in the SQL editor: `delete from public.push_subscriptions;`

## Check it works

1. Open <https://www.kanbo.co.uk>, sign in, **Settings › Notifications**. A
   **Push notifications** section appears under the In-app / Email table.
2. Switch **On this device** on and allow notifications when the browser asks.
3. Press **Send test**. A "Notifications are on" notification arrives within a
   few seconds; clicking it opens Kanbo on Today.
4. In the SQL editor:
   ```sql
   select count(*) as devices, max(last_ok_at) as last_delivered from public.push_subscriptions;
   ```
5. Assign a task to a teammate who has push on: they get "<you> assigned you a
   task"; clicking it opens that task.
6. Sign out, then check the browser's own site settings: Kanbo no longer has a
   push subscription on that device (Chrome: `chrome://serviceworker-internals`
   shows no push for www.kanbo.co.uk once the page has reloaded).

On iPhone/iPad: open Kanbo in Safari, Share › Add to Home Screen, open Kanbo
from the Home Screen, then switch push on there.

## What gets sent

| Event | Sent by | Pref (in `profiles.notify_prefs`, unset = on) | Notification |
|---|---|---|---|
| Assigned | `notify` | `assigned_push` | "Ana assigned you a task" · task title → the task (see below) |
| Mention | `notify` | `mention_push` | "Ana mentioned you" · task title → the task |
| Comment | `notify` | `comment_push` | "Ana commented" · task title → the task |
| Due today / overdue | `daily-reminders` (cron) | `due_push` | "3 due today, 1 overdue" · first titles → Today; once per person per day |
| Test | `notify` `{ kind: "test" }` | – | "Notifications are on" → Today; the caller's own device, 5 per 10 minutes |

Payloads are encrypted end to end (RFC 8291 aes128gcm) and never include
comment text. Notifications for the same task replace each other (tag
`task-<id>`). Suspended or unapproved accounts get nothing.

Push lands on a lock screen, so `notify` is stricter about it than about email:

- **Assigned** goes only to the task's assignee as the database has it (never
  to people the request names), and only when the database shows the caller
  has just made that assignment: a `task_events` row from the last 10 minutes
  (written by the database's own trigger), or the caller has just created the
  task already assigned. Guests (read-only) can't send assignment
  notifications at all, by email or push.
- **Mention / comment** push about the caller's most recent comment only.
- Each person gets **one push per event** (calling `notify` again for the same
  assignment or comment alerts nobody), and at most one a minute per task and
  kind. These use `rate_limits` (0042).

Kanbo only contacts the real push services (`fcm.googleapis.com`,
`updates.push.services.mozilla.com`, `*.push.apple.com`,
`*.notify.windows.com`, https only, no redirects); a subscription pointing
anywhere else is deleted without being contacted. Subscriptions the browser has
dropped (404/410) are deleted on the next send. Each person keeps at most 20
devices (the newest; with 0044 the database enforces it). The morning reminder
reads each person's devices on their own, so one person's rows can never
crowd anyone else out.

## Signing out and shared computers

Once the app is wired as below (the Push section doesn't appear until it is):

- **Signing out** deletes this device's subscription row while still signed
  in and drops the browser's subscription (`disablePush()`). If the network
  is down, the browser side still goes; the row is deleted the next time
  `notify` tries it (the push service answers 410).
- **Nobody signed in** (a sign-out from any button or tab, an expired or
  revoked session, or a page that opens signed out): the sign-out guard
  (`watchPushSession()`) drops the browser's subscription, so the next person
  at a shared computer never sees the last person's notifications. Opening
  Kanbo offline with an expired session isn't a sign-out (Supabase keeps the
  session and refreshes it when it can), so push stays on through that.
- **Someone else signs in** on a browser where another account left push on:
  the guard drops that subscription. Push is never inherited; each person
  switches it on for themselves.
- **Sign out of all devices** deletes every device's row for the account first
  (`disablePushEverywhere()`), so a laptop that's closed right now stops
  getting notifications at once rather than when it next opens Kanbo.
- When the browser replaces a subscription (Firefox rotates them), the app
  saves the new one when it next starts or straight away if Kanbo is open.

## Wiring into the app (integrator)

This package can't edit `AuthProvider`, `App`, `Sidebar` or `SettingsModal`,
so these calls are the integrator's. Until the `watchPushSession()` one is in,
the Push section stays hidden (`pushAvailability()` says "unconfigured");
everything else is safe to leave out but works worse without it. Components
come from `src/components/integrations` (its `index.ts`), functions from
`src/lib/push` and `src/lib/install`.

| Where | Call | Why |
|---|---|---|
| `SettingsModal` › `notificationsSection`, straight after the In-app / Email `kset-card` | `<PushSettingsPanel notifyPrefs={notifyPrefs} onSaveNotifyPrefs={onSaveNotifyPrefs} />` | The Push section (device switch, test, per-kind `<kind>_push` toggles). Renders nothing until push is configured; in demo mode it's a local stand-in. It brings its own top gap. |
| `SettingsModal` › `notificationsSection`, after the panel | `<div className="kpush-app"><SetGroup title="Kanbo app"><InstallPrompt variant="settings" /></SetGroup></div>` | Install (or the iOS Home Screen hint, or "Installed"). On iPhone, push needs the Home Screen app, so it sits next to Push. `kpush-app` gives it the group gap. |
| `SettingsModal` › `NOTIF_ROWS`, the `due` row's hint | "Your morning summary of what's due." (instead of "Sent by email only.") when `pushAvailability() !== "unconfigured"` | Once push is configured, due-date reminders can push too (the In-app column stays "–"). |
| `Sidebar` › `.ksb-foot`, first child (above `<FocusPill>`) | `<InstallPrompt variant="nudge" />` | The one-time "Install Kanbo" card. Renders nothing unless the browser offers an install and it hasn't been dismissed on this device. |
| `src/auth/AuthProvider.tsx`, once at mount (next to its `onAuthStateChange`) | `useEffect(() => watchPushSession(), [])` | **Required.** The sign-out guard (above). Also re-saves a rotated subscription after sign-in. Push stays hidden without it. |
| `AuthProvider` › `finishSignOut`, before the `supabase.auth.signOut(…)` race | `await disablePush()` | Deletes this device's row while the session can still do it. Never throws; gives up after about 6 s at worst (usually milliseconds). Every sign-out button goes through here. |
| `SettingsModal` › `signOutEverywhere`, before `supabase.auth.signOut({ scope: "global" })` | `await disablePushEverywhere()` | Deletes every device's row for the account. |
| `App`, once | `listenForPushMessages(openPushLink)` in an effect (below) | A notification clicked while Kanbo is open routes in place. Without it the worker waits 800 ms and then loads the address in that tab (it leaves the tab alone if it's already there). |
| `App`, once tasks have loaded (like the `?task=` deep link: a ref so it runs once) | `if (takeNewTaskShortcut()) openCapture()` | The installed app's **New task** shortcut opens `/today?new=1`. This opens quick capture (`openCapture` keeps guests out, as the keyboard shortcut does) and takes `new` off the address. Without it the shortcut just opens Today. |

`openPushLink(path)` gets a same-origin path: `/?task=<id>` (assigned, mention,
comment) or `/today` (due, test). For `?task=`, do what the boot deep link
does (App.tsx, "deep link: open ?task=<id>"); for anything else, route:

```tsx
useEffect(() => listenForPushMessages((path) => {
  const u = new URL(path, window.location.origin);
  const tid = u.searchParams.get("task");
  if (!tid) { setRoute(routeOf(u.pathname, u.search) ?? { view: "plan" }); return; }
  const t = (tasksRef.current ?? []).find((x) => x.id === tid);
  if (t) { setWorkspace(t.workspaceId ?? null); setDetailId(tid); }
  else toastInfo("That task doesn't exist any more, or you don't have access to it.");
}), [setRoute, toastInfo]);
```

## Troubleshooting

| You see | Why / fix |
|---|---|
| No Push section in Settings | `VITE_VAPID_PUBLIC_KEY` isn't in the build (add it in Vercel and redeploy), or it isn't a public key (a 65-byte base64url value starting `B`), or the build doesn't run `watchPushSession()` yet (see "Wiring into the app"). |
| "Push notifications aren't switched on for Kanbo yet." when switching on | 0043 hasn't been run. |
| "Kanbo's server can't send push notifications yet." on Send test | `notify` wasn't redeployed, or the VAPID secrets aren't set (step 2). |
| Test says sent but nothing arrives | Function logs (`notify`) show `[webpush] … answered 403`: the Vercel public key and the Supabase private key aren't a pair. Set both from one pair (steps 2, 3 and 5; if the file is gone, use the copy in your password manager). Also check the OS isn't in Do Not Disturb / Focus. |
| Assigned someone, no push | They have `assigned_push` off, or no device switched on; or the change wasn't saved as an assignment by you in the last 10 minutes (see "What gets sent"). Email is unaffected. |
| "Notifications are blocked for Kanbo" | The person blocked notifications for the site; they allow it in the browser's site settings (iPhone: Settings › Notifications › Kanbo). |
| Logs: `VAPID_PRIVATE_KEY doesn't match VAPID_PUBLIC_KEY` | Secrets from two different pairs. Set both from one pair. |

## The installable app

Kanbo is a Progressive Web App: Chrome and Edge offer **Install Kanbo** (address
bar or menu), Safari on Mac has **File › Add to Dock**, and iPhone/iPad have
**Share › Add to Home Screen**. Settings shows the right one for the browser,
and the sidebar shows a one-time, dismissible "Install Kanbo" card when the
browser offers an install.

- `public/manifest.webmanifest`: name and short name "Kanbo", opens at
  `/today`, standalone window, Canvas Navy (`#0B1020`) theme and splash, and
  shortcuts (long-press the icon / right-click in the dock): **New task**
  (`/today?new=1`; opens quick capture once the app calls
  `takeNewTaskShortcut()`, see "Wiring into the app"), **Today**, **Inbox**.
  `id` stays `/` so existing installs keep working.
- Icons, rendered from the brand app icon (navy ground, gradient mark):
  `icon-192.png`, `icon-512.png`, `icon.svg` (any), `icon-maskable-512.png`
  (Android shapes), `apple-touch-icon.png` (180, iOS), `favicon-32.png`
  (browsers without SVG favicons), `badge-96.png` (Android's monochrome
  notification badge) and `shortcut-*.png`.
- No CSP change is needed: the service worker is same-origin (`worker-src
  'self'`) and browsers talk to push services themselves.
