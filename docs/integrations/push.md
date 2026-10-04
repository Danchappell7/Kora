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

## What you need first

- Database update **0043** run (`database-0043.md`): it creates
  `push_subscriptions` and `save_push_subscription()`.
- The Supabase CLI logged in, and the Vercel CLI (or the Vercel dashboard).

## Owner steps

### 1. Make a VAPID key pair (once)

VAPID keys identify Kanbo to the browsers' push services. The private key is a
secret: it lives only in Supabase's function secrets. This one-liner writes a
fresh pair into `.env.vapid` (readable only by you; `.env.*` is git-ignored)
without printing either key. Run it in the `kora-app` folder, and replace the
email with the inbox push services should contact about problems:

```sh
node -e 'const c=require("crypto"),fs=require("fs");const j=c.generateKeyPairSync("ec",{namedCurve:"prime256v1"}).privateKey.export({format:"jwk"});const pub=Buffer.concat([Buffer.from([4]),Buffer.from(j.x,"base64url"),Buffer.from(j.y,"base64url")]).toString("base64url");fs.writeFileSync(".env.vapid","VAPID_PUBLIC_KEY="+pub+"\nVAPID_PRIVATE_KEY="+j.d+"\nVAPID_SUBJECT=mailto:hello@kanbo.co.uk\n",{mode:0o600});console.log("Wrote .env.vapid")'
```

(`npx web-push generate-vapid-keys --json` makes the same kind of pair if you
prefer; it prints them, so clear your terminal afterwards.)

### 2. Give the keys to the edge functions

```sh
supabase secrets set --env-file .env.vapid --project-ref htnchiljplrnjkwimgla
```

`VAPID_SUBJECT` must be `mailto:…` or an `https://` address. If it's ever
missing, the functions use `APP_URL` (already set).

### 3. Give the public key to the web app (Vercel)

The app needs the **public** key at build time (Vite bakes it in). It is safe
to ship to browsers; never use the private key here.

```sh
grep '^VAPID_PUBLIC_KEY=' .env.vapid | cut -d= -f2- | tr -d '\n' | vercel env add VITE_VAPID_PUBLIC_KEY production
grep '^VAPID_PUBLIC_KEY=' .env.vapid | cut -d= -f2- | tr -d '\n' | vercel env add VITE_VAPID_PUBLIC_KEY preview
```

(Or Vercel › Project › Settings › Environment Variables › add
`VITE_VAPID_PUBLIC_KEY` with the value after `VAPID_PUBLIC_KEY=`.)

### 4. Redeploy

```sh
supabase functions deploy notify --project-ref htnchiljplrnjkwimgla
supabase functions deploy daily-reminders --no-verify-jwt --project-ref htnchiljplrnjkwimgla
vercel deploy --prod          # or push to main; the new build picks up VITE_VAPID_PUBLIC_KEY
```

`notify` keeps **Verify JWT: ON**; `daily-reminders` stays off (its cron job
and `CRON_SECRET` are unchanged; see DEPLOYMENT.md "Schedule the daily
reminder email").

### 5. Keep the private key, then delete the file

Put the contents of `.env.vapid` in your password manager (you only need it
again to move projects), then `rm .env.vapid`.

**Don't rotate the keys casually.** Every device subscribed with the old public
key stops receiving pushes; people have to switch push on again in Settings
(Kanbo notices the new key and offers the switch as off). If you do rotate,
repeat steps 1–4 and then clear the old subscriptions in the SQL editor:
`delete from public.push_subscriptions;`

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

On iPhone/iPad: open Kanbo in Safari, Share › Add to Home Screen, open Kanbo
from the Home Screen, then switch push on there.

## What gets sent

| Event | Sent by | Pref (in `profiles.notify_prefs`, unset = on) | Notification |
|---|---|---|---|
| Assigned | `notify` | `assigned_push` | "Ana assigned you a task" · task title → the task |
| Mention | `notify` | `mention_push` | "Ana mentioned you" · task title → the task |
| Comment | `notify` | `comment_push` | "Ana commented" · task title → the task |
| Due today / overdue | `daily-reminders` (cron) | `due_push` | "3 due today, 1 overdue" · first titles → Today; once per person per day |
| Test | `notify` `{ kind: "test" }` | – | "Notifications are on" → Today; the caller's own device, 5 per 10 minutes |

Payloads are encrypted end to end (RFC 8291 aes128gcm) and never include
comment text. Notifications for the same task replace each other (tag
`task-<id>`). Suspended or unapproved accounts get nothing.

Kanbo only contacts the real push services (`fcm.googleapis.com`,
`updates.push.services.mozilla.com`, `*.push.apple.com`,
`*.notify.windows.com`, https only, no redirects); a subscription pointing
anywhere else is deleted without being contacted. Subscriptions the browser has
dropped (404/410) are deleted on the next send. Each person keeps at most 20
devices (the newest).

When someone signs out, the app switches push off for that device first, so a
shared computer never shows the previous person's notifications.

## Troubleshooting

| You see | Why / fix |
|---|---|
| No Push section in Settings | `VITE_VAPID_PUBLIC_KEY` isn't in the build (add it in Vercel and redeploy), or it isn't a public key (a 65-byte base64url value starting `B`). |
| "Push notifications aren't switched on for Kanbo yet." when switching on | 0043 hasn't been run. |
| "Kanbo's server can't send push notifications yet." on Send test | `notify` wasn't redeployed, or the VAPID secrets aren't set (step 2). |
| Test says sent but nothing arrives | Function logs (`notify`) show `[webpush] … answered 403`: the Vercel public key and the Supabase private key aren't a pair. Redo steps 2–4 from the same `.env.vapid`. Also check the OS isn't in Do Not Disturb / Focus. |
| "Notifications are blocked for Kanbo" | The person blocked notifications for the site; they allow it in the browser's site settings (iPhone: Settings › Notifications › Kanbo). |
| Logs: `VAPID_PRIVATE_KEY doesn't match VAPID_PUBLIC_KEY` | Secrets from two different pairs. Set both from one `.env.vapid`. |

## The installable app

Kanbo is a Progressive Web App: Chrome and Edge offer **Install Kanbo** (address
bar or menu), Safari on Mac has **File › Add to Dock**, and iPhone/iPad have
**Share › Add to Home Screen**. Settings shows the right one for the browser,
and the sidebar shows a one-time, dismissible "Install Kanbo" card when the
browser offers an install.

- `public/manifest.webmanifest`: name and short name "Kanbo", opens at
  `/today`, standalone window, Canvas Navy (`#0B1020`) theme and splash, and
  shortcuts (long-press the icon / right-click in the dock): **New task**
  (`/today?new=1`), **Today**, **Inbox**. `id` stays `/` so existing installs
  keep working.
- Icons, rendered from the brand app icon (navy ground, gradient mark):
  `icon-192.png`, `icon-512.png`, `icon.svg` (any), `icon-maskable-512.png`
  (Android shapes), `apple-touch-icon.png` (180, iOS), `favicon-32.png`
  (browsers without SVG favicons), `badge-96.png` (Android's monochrome
  notification badge) and `shortcut-*.png`.
- No CSP change is needed: the service worker is same-origin (`worker-src
  'self'`) and browsers talk to push services themselves.
