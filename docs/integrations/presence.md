# Live presence and co-editing (0048, package u5)

Who else has a task, a doc or a project open ("Sana is viewing"), "Theo is
typing…" under a task's comments, and live co-editing of project docs. It all
rides **Supabase Realtime** — presence and broadcast on one **private**
channel per object — with no tables. Nothing beyond a user id, a name and an
avatar colour goes on the wire (plus, on a doc's channel, the doc's own
blocks, to people who can read the doc anyway).

Code: `src/components/presence/core.ts` (the hub: one channel per object per
tab, shared by every hook; the light hooks — safe for the shell),
`src/lib/presence.ts` (the contract, the block-op engine and `useDocCollab` —
the docs chunk), `src/components/presence/*` (`PresenceAvatars`,
`TypingIndicator`, `RemoteCarets`, the demo's scripted teammates).

## Channels

| Channel | Presence (`track`) | Broadcast events |
|---|---|---|
| `kanbo:task:<uuid>` | everyone with the task panel open (`state` viewing) | `typing` `{userId, name, color, clientId, on}` — at most one per 1.5 s; a typer drops off after 4 s of silence |
| `kanbo:doc:<uuid>` | everyone with the doc open (`state` viewing / editing, `caret`, `clk`) | `ops` (a `DocOpBatch` + `color`, `title`, the sender's `caret`, and `prev`: a hash of what each updated or deleted block held before), `caret`, `saved` `{version, key}`, `order` `{ids}`, `stale` `{to, version}` |
| `kanbo:project:<uuid>` | the project page, and every task panel / doc of the project (`taskId` / `docId` they have open) | none |

Each tab tracks one object per channel —
`{ userId, name, color, clientId, state, taskId?, docId?, caret?, clk?, at }` —
re-sent every 15 s while the tab is visible; a peer whose beat stops fades
after 45 s (measured on the receiving clock, never the sender's). Everything
that arrives is validated (ids, a clean name, a known state; a colour string
never reaches CSS — only its hue; a doc block goes through the same parser as
a stored body, so links stay http(s)/mailto).

## Co-editing, briefly

* Local edits become block operations (`insert` / `update` / `delete` /
  `move`) by diffing the editor against the shared copy, sent at most every
  150 ms with one other tab in the doc, 300 ms with two, 500 ms with three or
  more. While you type, your caret rides in the batch; it goes on its own
  (at most every 250 ms) only when it moves without an edit. With no other
  tab on the channel nothing is sent at all (a background tab counts: it
  still receives). A batch over 200 kB (a huge paste) isn't sent: the others
  get it from the save.
* Every write is stamped `[n, clientId]` (`n` a hybrid logical clock, ahead of
  every stamp seen and published in presence). Content and position are
  separate last-writer-wins registers per block, so different blocks never
  touch and the same block ends the same everywhere. Inserts follow the RGA
  rule; deleted blocks stay in the sequence, hidden, so a late op still lands
  in place and an edit newer than the delete brings a block back. A block
  deleted while you're typing in it stays (your words win).
* The same block edited at once: the later stamp wins, the block flashes the
  other person's name ("edited by Sana", `aria-description` for screen
  readers) and the person who lost the race hears "Sana changed the line you
  were writing at the same moment. Their version is in."
* Quiet editors compare block order now and then (`order`); the highest client
  id's order stands. (The one race RGA can't order the same everywhere: a move
  against an insert after the moved block.)
* Saving is unchanged: each editor autosaves its own work with the version
  check. When someone else's save lands (the realtime ping, a conflict answer,
  or a `saved` notice whose hash doesn't match the screen), the editor merges
  it three ways (`mergeDocVersions`: the last saved copy, yours, theirs). The
  conflict banner shows only for a block both sides changed **without seeing
  each other's words** (one of you offline, say). A `saved` notice whose hash
  matches the screen just moves the base (no fetch, nothing to save).
* Cut off and back. Realtime doesn't replay broadcasts, so a tab whose
  channel dropped (wifi, a sleeping laptop) — or one that has just joined —
  has missed what was sent meanwhile. Nothing it typed goes out live until
  it has caught up with the server's copy (fetch, then the three-way merge:
  the banner if its words clash with saved ones it never saw). Edits the
  server already holds (saved while it was cut off) then count as shared and
  are never sent again over newer words; only what's left goes out. Nothing
  goes out while the conflict banner is up; Reload sends the saved copy only
  where the others show your words, Keep mine sends yours on top of theirs.
  For a few seconds after catching up a tab takes the others' block order
  rather than imposing its own (a move made while it was away arrives with
  its maker's save).
* Belt and braces: a batch made on an older save than yours never overwrites
  words saved since that its sender hadn't seen. Each batch names, per
  block, a hash of the content its edit was made on (`prev`); if that's
  older here than the saved content, the edit (or delete) is refused, the
  rest of the batch applies, and the sender is told (`stale`) to catch up —
  where the banner shows if they clash.
* Undo only takes back your own edits: others' changes are carried into every
  undo step, and typing on in a line they didn't touch stays one undo step.
* Version history: 0048 keeps one version per 10 minutes of a doc's editing
  whoever saves (it names who saved it last), so people writing together —
  who autosave in turn — don't push the older history out of the last 50.
  A restore or Keep mine is still a version of its own.
* Alone (demo without its script, offline, a refused channel) the editor is
  exactly what it was, with the three-way merge on top.

Convergence is tested with a seeded fuzz (`src/lib/presence.fuzz.test.ts`):
2–5 people, random inserts / deletes / moves / edits / titles, every delivery
interleaving Realtime allows; every copy ends identical. Another fuzz cuts
one editor off while the others write and save, then brings it back (and, in
a race variant, lets its stale batch out before it catches up): everyone
converges, a saved block it didn't touch ends as saved, and every saved block
it did touch was a conflict it answered (Reload or Keep mine) — never a silent
overwrite.

## Message budget

What goes over Realtime for one doc (presence heartbeats aside: one per tab
per channel every 15 s):

| Who's in the doc | Sent per second | Delivered per second |
|---|---|---|
| One person typing, alone | 0 | 0 |
| Two, both typing | ≈ 13 (6.7 each) | ≈ 13 |
| Three, all typing | ≈ 10 (3.3 each) | ≈ 20 |
| Five, all typing | ≈ 10 (2 each) | ≈ 40 |
| Anyone moving the caret without typing | ≤ 4 each | × the others |

(Before this, every typist sent ≈ 17 a second — ops every 150 ms plus a caret
every 100 ms — whatever the company: three typists were ≈ 50 sent and 100
delivered a second.) These are worst cases — people type in bursts — and
task-comment typing adds at most one message per typist every 1.5 s.

Supabase limits Realtime messages per second per project, by plan, and
counts a broadcast both when it's sent and for each client it reaches (at
the time of writing: 100 a second on Free, 500 on Pro, 2,500 on Team —
check the current figures for this project's plan on the dashboard). On
Pro, that's room for a dozen docs with three people all typing flat out at
once, alongside everything else the app streams (task and comment changes).
If usage nears the limit, the first lever is `docOpThrottleMs` in
`src/lib/presence.ts`.

## Database: Realtime Authorization (0048, section 15)

The app joins these channels as **private** channels, so Realtime asks the
policies on `realtime.messages` when someone joins (and when their token
refreshes). They're in `supabase/migrations/0048_ux_wave.sql`, section 15:
`public.kanbo_realtime_allowed(topic, extension, write)` (security definer;
anon can't call it) and the policies "kanbo presence: read" (select) and
"kanbo presence: write" (insert). Without them every join is refused and
presence quietly stays off (one console note) — 0048's VERIFY has a
`live_presence` column for exactly this. Read = see who's there and
receive; write = `presence` (say you're there) or `broadcast` (typing on a
task; edits, carets, "saved", "stale" and the order check on a doc; nothing
on a project). Guests read docs live and show as there, but never send
edits; an archived doc sends nothing; suspended or unapproved people get
nothing. Where Realtime has no Authorization (no `realtime.messages`) the
section skips the policies.

Section 16 changes `save_project_doc()`'s version rule (above); VERIFY's
`doc_versions` column checks it.

Tested in PGlite (`scratchpad/pgtest-u5/run.mjs`, 12 cases, with Realtime's
`realtime.messages` and `realtime.topic()` stubbed and joins checked the way
Realtime checks them): members, guests, the suspended, the unapproved,
outsiders, the signed-out, a personal task, an archived doc, a doc that
doesn't exist, a removed member, a member demoted to guest, odd topics and
extensions; applied twice, before Realtime exists, and after a re-run of 0048.
Versions (`scratchpad/pgtest-u5/versions.mjs`, 7 cases): two people saving in
turn keep last week's history, a checkpoint is its own version, a new one
after 10 minutes, the last 50, who saved it, guests and outsiders still
refused, and a re-run of 0047 (VERIFY turns false) then 0048. The 0048 suite
passes with both sections in, on the file and on its comment-free paste copy
(its VERIFY now has 16 columns).

Realtime settings: nothing to change — private channels work alongside the
public ones the app already uses (database changes, the old task-panel
presence).
