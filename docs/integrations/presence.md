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
| `kanbo:doc:<uuid>` | everyone with the doc open (`state` viewing / editing, `caret`, `clk`) | `ops` (a `DocOpBatch` + `color`, `title`), `caret`, `saved` `{version, key}`, `order` `{ids}` |
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
  150 ms (carets every 100 ms). A batch over 200 kB (a huge paste) isn't sent:
  the others get it from the save.
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
* Undo only takes back your own edits: others' changes are carried into every
  undo step.
* Alone (demo without its script, offline, a refused channel) the editor is
  exactly what it was, with the three-way merge on top.

Convergence is tested with a seeded fuzz (`src/lib/presence.fuzz.test.ts`):
2–5 people, random inserts / deletes / moves / edits / titles, every delivery
interleaving Realtime allows; every copy ends identical.

## Database: Realtime Authorization (append to 0048)

The app joins these channels as **private** channels, so Realtime asks the
policies below on `realtime.messages` when someone joins (and when their token
refreshes). Without them every join is refused and presence quietly stays off
(one console note). Read = see who's there and receive; write = `presence`
(say you're there) or `broadcast` (typing on a task; edits, carets, "saved"
and the order check on a doc; nothing on a project). Guests read docs live
and show as there, but never send edits; an archived doc sends nothing;
suspended or unapproved people get nothing. Append it to
`0048_ux_wave.sql` just before `-- ---------- done: record it ----------`, and
regenerate the paste copy.

```sql
-- ---------- 15. live presence: who may use the kanbo:* Realtime channels (u5) ----------
-- Presence rides Supabase Realtime on PRIVATE channels, one per object: "kanbo:task:<id>",
-- "kanbo:doc:<id>", "kanbo:project:<id>" (lib/presence). Realtime Authorization asks these policies on
-- realtime.messages when someone joins (and again when their token refreshes). Nothing is stored.
--   read  (see who's there; receive typing, doc edits, carets): anyone who can see the object.
--   write, extension 'presence' (say you're there): the same people.
--   write, extension 'broadcast': on a task, anyone who can see it (guests comment, so they may type);
--     on a doc, people who can edit its project (never guests) while it isn't archived — edits, carets,
--     "saved" notices and the order check; on a project, nobody (it's presence only).
-- Suspended or unapproved people: nothing (can_act). Signed out: nothing. Only uuids after the prefix.
-- A Realtime without Authorization (no realtime.messages) skips the policies: presence then stays off,
-- because the app only ever joins these channels as private ones.
create or replace function public.kanbo_realtime_allowed(p_topic text, p_extension text, p_write boolean)
returns boolean language plpgsql stable security definer set search_path = public as $$
declare
  v_kind text;
  v_id uuid;
  v_project uuid;
  v_archived timestamptz;
begin
  if auth.uid() is null or p_topic is null or not public.can_act() then return false; end if;
  if p_topic !~ '^kanbo:(task|doc|project):[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
    return false;
  end if;
  if p_write and p_extension is distinct from 'presence' and p_extension is distinct from 'broadcast' then return false; end if;
  v_kind := split_part(p_topic, ':', 2);
  v_id := split_part(p_topic, ':', 3)::uuid;
  if v_kind = 'task' then
    return public.can_see_task(v_id);
  elsif v_kind = 'project' then
    if p_write and p_extension <> 'presence' then return false; end if;
    return public.can_see_project(v_id);
  end if;
  select d.project_id, d.archived_at into v_project, v_archived from public.project_docs d where d.id = v_id;
  if v_project is null then return false; end if;
  if p_write and p_extension = 'broadcast' then
    return v_archived is null and public.can_edit_project(v_project);
  end if;
  return public.can_see_project(v_project);
end; $$;
revoke all on function public.kanbo_realtime_allowed(text, text, boolean) from public, anon;
grant execute on function public.kanbo_realtime_allowed(text, text, boolean) to authenticated;

do $live$
begin
  if to_regclass('realtime.messages') is null or to_regprocedure('realtime.topic()') is null then return; end if;
  execute 'drop policy if exists "kanbo presence: read" on realtime.messages';
  execute 'drop policy if exists "kanbo presence: write" on realtime.messages';
  execute $p$create policy "kanbo presence: read" on realtime.messages for select to authenticated
    using (public.kanbo_realtime_allowed(realtime.topic(), extension, false))$p$;
  execute $p$create policy "kanbo presence: write" on realtime.messages for insert to authenticated
    with check (public.kanbo_realtime_allowed(realtime.topic(), extension, true))$p$;
end $live$;
```

A line for the 0048 VERIFY (and the same in `database-0048.md`):

```sql
--   (select count(*) from pg_policies where schemaname = 'realtime' and tablename = 'messages'
--     and policyname in ('kanbo presence: read', 'kanbo presence: write')) = 2                    as live_presence,
```

Tested in PGlite (`scratchpad/pgtest-u5/run.mjs`, 12 cases, with Realtime's
`realtime.messages` and `realtime.topic()` stubbed and joins checked the way
Realtime checks them): members, guests, the suspended, the unapproved,
outsiders, the signed-out, a personal task, an archived doc, a doc that
doesn't exist, a removed member, a member demoted to guest, odd topics and
extensions; applied twice, before Realtime exists, and after a re-run of 0048.
The architect's 0048 suite still passes with the section appended (all but
"the paste copy matches the repo file", until the paste is regenerated).

Realtime settings: nothing to change — private channels work alongside the
public ones the app already uses (database changes, the old task-panel
presence).
