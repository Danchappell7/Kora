# Kanbo API v1

Read and change your Kanbo tasks, projects, sections and comments from your
own tools and scripts. JSON over HTTPS, one API key per tool.

```
https://htnchiljplrnjkwimgla.supabase.co/functions/v1/api/v1
```

The full reference, with every field and an example for every endpoint, is in
the app (**Settings › Developers › API reference**) and as an OpenAPI 3.1
document at [`/v1/openapi.json`](https://htnchiljplrnjkwimgla.supabase.co/functions/v1/api/v1/openapi.json)
(no key needed). Import that into Postman, Insomnia or a code generator.

## Quick start

1. In Kanbo, open **Settings › Developers** and choose **Create key**.
   Give it a name ("Zapier", "Reporting script"), choose where it works and
   whether it may change things, and press **Create key**.
2. Copy the key straight away. Kanbo keeps only a fingerprint of it, so it
   can't be shown again (if you lose it, revoke it and make another).
3. Try it:

```sh
export KANBO_API_KEY="kanbo_sk_…"            # your key
BASE=https://htnchiljplrnjkwimgla.supabase.co/functions/v1/api/v1

# who am I?
curl -H "Authorization: Bearer $KANBO_API_KEY" "$BASE/me"

# my open tasks, due this month
curl -H "Authorization: Bearer $KANBO_API_KEY" \
  "$BASE/tasks?assignee=me&status=todo,progress&due_before=2026-10-31"

# add a task to a project (the Idempotency-Key makes a retry safe)
curl -X POST "$BASE/tasks" \
  -H "Authorization: Bearer $KANBO_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{"title": "Write the launch blog post", "projectId": "2b7e9c1d-…", "dueDate": "2026-10-16", "assigneeId": "me"}'

# move it on, then finish it
curl -X PATCH "$BASE/tasks/5e6f7a8b-…" -H "Authorization: Bearer $KANBO_API_KEY" \
  -H "Content-Type: application/json" -d '{"status": "review"}'
curl -X POST "$BASE/tasks/5e6f7a8b-…/complete" -H "Authorization: Bearer $KANBO_API_KEY"

# leave a comment
curl -X POST "$BASE/tasks/5e6f7a8b-…/comments" -H "Authorization: Bearer $KANBO_API_KEY" \
  -H "Content-Type: application/json" -d '{"body": "Draft is in the doc."}'
```

## Keys

| | `kanbo_sk_…` read & write | `kanbo_pk_…` read-only |
|---|---|---|
| GET requests | yes | yes |
| POST, PATCH, DELETE | yes | no (403) |

- **Personal key**: acts as you everywhere you can work: your Personal list
  and every workspace you're in.
- **Team key** (workspace owners and admins only): acts as you, but only
  inside that one workspace. Anything else answers 403 / 404. It stops
  working if you stop being an owner or admin there.
- Optional expiry (7 days to a year). Revoke a key at any time in
  Settings › Developers; it stops working at once. Owners and admins can see
  and revoke every team key in their workspace.
- A suspended or not-yet-approved account's keys stop working at once.
- Up to 25 live keys per person and 50 team keys per workspace.
- Both kinds are secrets. Use them from servers and scripts only. The API
  doesn't answer browsers' cross-origin (CORS) checks on purpose: a key in a
  web page can be read by anyone who opens it.

## Permissions

Every request runs **as the key's owner, with exactly their access** —
the same rules as the app, enforced by the database:

- You see what you can see in Kanbo; anything else is `404 not_found`.
- Guests can read and comment, but not create or edit (`403 forbidden`).
- Permanently deleting a task (`DELETE /tasks/{id}?hard=true`) is for
  workspace owners and admins (and you, for your own personal tasks). A plain
  `DELETE` archives instead, and `PATCH {"archived": false}` restores.
- A task always lives in its project's workspace; its assignee must be a
  member there (personal tasks: only you).

## Endpoints

| Method | Path | What |
|---|---|---|
| GET | `/me` | The key's owner and the key |
| GET | `/workspaces` | Workspaces you can reach, with your role |
| GET | `/members?workspace=` | A workspace's members (use `userId` as `assigneeId`) |
| GET | `/projects?workspace=&include_archived=` | Projects (`workspace=personal` for personal ones) |
| POST | `/projects` | Create a project |
| GET / PATCH | `/projects/{id}` | Read / update (name, emoji, colour, description, status, archived) |
| GET | `/sections?project=` | A project's sections, in board order |
| POST | `/sections` | Add a section |
| GET | `/tasks` | List and filter tasks (below) |
| POST | `/tasks` | Create a task (or a sub-task with `parentId`) |
| GET | `/tasks/{id}` | A task, with `subtaskIds` and `dependencyIds` |
| PATCH | `/tasks/{id}` | Update title, description, status, priority, dates, assignee, project, section, tags, estimate, archived |
| POST | `/tasks/{id}/complete` | Mark done (safe to repeat) |
| DELETE | `/tasks/{id}` | Archive (`?hard=true`: delete for good) |
| GET / POST | `/tasks/{id}/comments` | Read / add comments (`parentId` to reply) |
| GET | `/openapi.json` | The OpenAPI document (no key) |

Webhook management endpoints (`/webhooks…`) are described in
[webhooks.md](webhooks.md).

### Shapes

Field names are camelCase; dates are `YYYY-MM-DD`, times are ISO 8601 UTC
(`2026-10-05T09:30:00.000Z`); a missing value is `null`, never left out.
Every resource has an `object` field (`"task"`, `"project"`, …) and a `url`
that opens it in Kanbo. Tasks in someone's Personal list have
`workspaceId: null` and `projectId: "p-personal"`. A write to one task answers
with the task exactly as `GET /tasks/{id}` shows it (with `subtaskIds` and
`dependencyIds`) and its new `ETag`. Webhook payloads use the same shapes
(without `subtaskIds` / `dependencyIds`).

### Filtering tasks

| Parameter | Example | Meaning |
|---|---|---|
| `workspace` | `8f1c…` / `personal` | One workspace, or your Personal list |
| `project`, `section` | `2b7e…` | In this project / section |
| `assignee` | `me`, `none`, a user id | Assigned to |
| `parent` | a task id / `none` | Its sub-tasks / top-level only |
| `status` | `todo,progress` | One or more statuses |
| `due_before`, `due_after` | `2026-10-31` | Due on or before / on or after |
| `updated_since` | `2026-10-05T09:00:00Z` | Changed at or after (switches the order, see below) |
| `include_archived` | `true` | Include archived tasks |
| `q` | `launch` | Words in the title or description |
| `limit`, `cursor` | `100` | Paging |

Unknown parameters are refused (`400`), so a typo can't silently widen a query.

## Pagination

Lists look like `{ "object": "list", "data": [...], "nextCursor": "…", "hasMore": true }`.
Pass `nextCursor` back as `?cursor=` with the **same filters**; `limit` is
1–100 (default 50). Tasks come newest first; projects, members and comments
oldest first.

```js
let cursor = null, all = [];
do {
  const url = new URL(`${BASE}/tasks`);
  url.searchParams.set("workspace", workspaceId);
  url.searchParams.set("limit", "100");
  if (cursor) url.searchParams.set("cursor", cursor);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${process.env.KANBO_API_KEY}` } });
  const page = await res.json();
  all.push(...page.data);
  cursor = page.nextCursor;
} while (cursor);
```

### Keeping a copy in sync

`GET /tasks?updated_since=<time>` returns tasks changed at or after that time,
**oldest change first**, so you can page through and remember the last
`updatedAt` you saw. Ask again from a minute or so before it (changes made in
one transaction share a time) and skip ids you already have. Deleted tasks
don't appear in lists: use the `task.deleted` webhook to hear about them, or
`include_archived=true` to see archived ones.

When you write back, send the task's last `ETag` as `If-Match` (see
[Safe edits](#safe-edits-if-match)) so you never overwrite something someone
changed in Kanbo after you read it.

## Errors

```json
{ "error": { "code": "validation_failed", "message": "Some fields need attention.", "status": 422,
             "requestId": "req_4f9a1c2b7d3e8a60", "details": { "fields": { "dueDate": "Use a date like 2026-10-31, or null." } } } }
```

| Status | `code` | When |
|---|---|---|
| 400 | `bad_request` / `invalid_body` | A bad query parameter or cursor; the body isn't a JSON object |
| 401 | `unauthorized` | No key, or it's revoked, expired or its owner can't use Kanbo |
| 403 | `forbidden` | Read-only key writing; team key outside its workspace; not allowed (e.g. a guest editing) |
| 404 | `not_found` | Doesn't exist, or you can't see it |
| 405 | `method_not_allowed` | Wrong method (see the `Allow` header) |
| 409 | `idempotency_in_progress` / `conflict` | The first request with this Idempotency-Key is still running; or (`conflict`, `details.idempotency: "applied"`) it was carried out but its answer was lost |
| 412 | `precondition_failed` | `If-Match` didn't match: it changed since you read it |
| 413 | `payload_too_large` | Body over 64 KB |
| 415 | `unsupported_media_type` | Send `Content-Type: application/json` |
| 422 | `validation_failed` / `idempotency_mismatch` | A field isn't valid (`details.fields`); an Idempotency-Key reused for a different request |
| 429 | `rate_limited` | Over the rate limit; wait `Retry-After` seconds |
| 500 / 503 | `internal` | Kanbo's side; retry. Quote the `requestId` to support |

Messages are written for people, so you can show them as they are. Fields
you can't set (`id`, `updatedAt`, `createdBy`…) and unknown fields are refused
with a 422 that names them (and suggests `dueDate` if you sent `due_date`).

## Limits

| | |
|---|---|
| Requests | 120 a minute per key (`X-RateLimit-Limit`, `X-RateLimit-Remaining`; `Retry-After` on a 429) |
| Body | 64 KB |
| Title / description | 500 / 20 000 characters |
| Comment | 10 000 characters |
| Project name / section name | 120 characters |
| Tags per task | 20 (each up to 40 characters) |
| Page size | 100 |

## Idempotency (safe retries)

Send `Idempotency-Key: <any unique string, a UUID is ideal>` on a POST. If the
same key comes again within 24 hours (a retry after a timeout, say), Kanbo
returns the first answer again, with `Idempotent-Replayed: true`, instead of
creating a second task. The same key with a different body is a `422
idempotency_mismatch`; while the first is still running, `409
idempotency_in_progress` (wait for `Retry-After`). Keys are per API key.

The work and the "this key is done" mark are saved in one transaction, so a
request that went through is **never** run twice, whatever fails afterwards:

- A failure on Kanbo's side (5xx) where nothing was saved isn't remembered,
  so the retry runs.
- In the rare case the work was saved but Kanbo couldn't keep its answer, a
  retry gets `409 conflict` with `details.idempotency: "applied"`: look the
  result up (for example `GET /tasks?updated_since=…`) instead of sending it
  with a new key.
- A request that never finished (its server stopped) holds the key for 10
  minutes; after that the retry runs.

## Caching

GET answers carry a weak `ETag`. Send it back as `If-None-Match` and you get a
bodyless `304 Not Modified` if nothing changed.

## Safe edits (If-Match)

`PATCH /tasks/{id}`, `POST /tasks/{id}/complete`, `DELETE /tasks/{id}` and
`PATCH /projects/{id}` take an optional `If-Match` header: the `ETag` from
`GET`, or from your last write's answer (writes answer with the new one). The
write only goes ahead if the task or project hasn't changed since; otherwise
it's `412 precondition_failed` and nothing is written. GET it again, merge, and
retry with the new `ETag`. `If-Match: *` just means "it must exist".

```sh
ETAG=$(curl -sI -H "Authorization: Bearer $KANBO_API_KEY" "$BASE/tasks/5e6f7a8b-…" | grep -i '^etag:' | cut -d' ' -f2- | tr -d '\r')
curl -X PATCH "$BASE/tasks/5e6f7a8b-…" -H "Authorization: Bearer $KANBO_API_KEY" \
  -H "Content-Type: application/json" -H "If-Match: $ETAG" -d '{"tags": ["design", "Launch"]}'
```

Any change to what `GET` shows counts (a new sub-task or comment count, a
renamed tag), so a 412 now and then is normal for a busy task. Without
`If-Match` a write simply goes ahead, as before.

## Webhooks

To hear about changes as they happen instead of polling, add a webhook in
**Settings › Developers › Webhooks** (or with the `/webhooks` endpoints). Each
delivery is signed; see [webhooks.md](webhooks.md) for events, payloads,
signature checks and retries.

## Good to know

- A project's automations run for API changes exactly as in the app: "When a
  task is created" rules on `POST /tasks` (sub-tasks too), "status changed"
  rules whenever a `PATCH` changes the status, and "task completed" rules when
  it becomes done (also `POST /tasks/{id}/complete`). Rules win over values in
  the same request, as in the app. A value a rule names that the task can't
  take (someone outside the workspace, another project's section, a tag from
  elsewhere, an unknown tag name) is skipped, never guessed.
- Completing a recurring task through the API marks it done; the next
  occurrence is created when someone completes it in the Kanbo app.
- Moving a task to a project in another workspace takes its sub-tasks with
  it, clears the section and hands it to you if its assignee isn't in the new
  workspace, as the app does. Because the task, its sub-tasks and their
  comments leave the workspace, only the people who made all of them, or that
  workspace's owners and admins, may move it out (`403` otherwise). Moving
  between projects of the same workspace is open to every member.
- `tags` take tag ids, built-in tags (`design`, `eng`, `research`, `writing`,
  `ops`, `bug`) or labels; a new label is made in the task's workspace.
- A comment posted through the API reaches the task's people (its creator,
  assignee and followers) in their Inbox, as in the app; @mentions aren't
  parsed from the text, and no emails are sent for it.

---

## For the Kanbo owner: switching it on

Needs migration 0046 (`docs/integrations/database-0046.md`). No new secrets:
the function uses the built-in `SUPABASE_DB_URL` / `SUPABASE_URL` and the
existing `APP_URL`.

1. Deploy the function (its gateway JWT check is off in `supabase/config.toml`;
   it checks Kanbo keys itself):

   ```sh
   supabase functions deploy api --no-verify-jwt --project-ref htnchiljplrnjkwimgla
   ```

2. Check it answers (no key needed):

   ```sh
   curl https://htnchiljplrnjkwimgla.supabase.co/functions/v1/api/v1/openapi.json | head -c 200
   ```

3. In Kanbo, make a read-only key in Settings › Developers and run
   `curl -H "Authorization: Bearer <key>" …/api/v1/me`. Then revoke it.

How it's built: `supabase/functions/api/index.ts` wires the database into
`_shared/api/pipeline.ts` (authentication, rate limits, idempotency, ETags,
errors), `routes.ts` / `handlers.ts` (the endpoints), `validate.ts` (every
input) and `openapi.ts` (the document). Every read and write runs in a
transaction **as the key's owner** (`SET LOCAL ROLE authenticated` with their
id as `auth.uid()`), so row-level security decides exactly as it does in the
app; a team key's transaction is also pinned to its workspace. The service
role is used only to check keys, count requests and store idempotent answers.
Tested with vitest and a PGlite replay of every migration answering real
requests (198 attack and legit cases).
