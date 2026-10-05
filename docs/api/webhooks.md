# Kanbo webhooks

Kanbo can tell your own tools the moment something changes: a task is added,
updated, finished or deleted, someone comments, a project changes, or a
teammate joins. Each change is sent as an HTTPS `POST` with a JSON body to an
address you choose (an **endpoint**), signed so you can check it came from
Kanbo.

- Set them up in **Settings › Developers › Webhooks**, or with the API
  ([Managing webhooks with the API](#managing-webhooks-with-the-api)).
- A **team** endpoint hears about everything in one workspace. Owners, admins
  and members can add them; guests can't.
- A **personal** endpoint hears about your personal tasks and projects.
- The `data` in every event is exactly what the REST API returns for that
  resource (`GET /v1/tasks/:id` and so on), so one parser covers both.

Contents: [What a delivery looks like](#what-a-delivery-looks-like) ·
[Verifying signatures](#verifying-signatures) ·
[Answering a delivery](#answering-a-delivery) ·
[Retries and switching off](#retries-and-switching-off) ·
[Event catalogue](#event-catalogue) ·
[Managing webhooks with the API](#managing-webhooks-with-the-api) ·
[Security](#security) · [Limits](#limits) ·
[Running it (owner steps)](#running-it-owner-steps)

---

## What a delivery looks like

```http
POST /kanbo?team=w HTTP/1.1
Host: hooks.example.com
Content-Type: application/json
User-Agent: Kanbo-Webhooks/1.0
Kanbo-Event: task.updated
Kanbo-Delivery: 1aefcd04-d7e3-4f30-96e8-2a7008b6045c
Kanbo-Attempt: 1
Kanbo-Signature: t=1791200470,v1=5257a869e7ecebeda32affa62cdca3fa51cad7e77a0e56ff536d0ce8e108d8bd
Content-Length: 1187

{"id":"evt_4811","type":"task.updated","createdAt":"2026-10-05T09:41:10.532Z", …}
```

| Header | What it is |
|---|---|
| `Kanbo-Event` | The event type, e.g. `task.updated` (`ping` for a test). |
| `Kanbo-Delivery` | This event's delivery to this endpoint. The same on every retry. |
| `Kanbo-Attempt` | 1 for the first try, 2 for the first retry, and so on. |
| `Kanbo-Signature` | `t=<unix seconds>,v1=<hex HMAC-SHA256>`: see [Verifying signatures](#verifying-signatures). |

The body is an **envelope**:

| Field | Type | |
|---|---|---|
| `id` | string | `evt_…`. The same on every retry, and the same for every endpoint that hears this event. Use it to ignore repeats. |
| `type` | string | The event (as in `Kanbo-Event`). |
| `createdAt` | string | When it happened (ISO 8601, UTC). |
| `workspaceId` | string \| null | The team workspace, or `null` for a personal task or project. |
| `data` | object | The resource as the API shows it (`object: "task"`, `"comment"`, `"project"`, `"member"`). |
| `changes` | string[] | `task.updated` and `project.updated` only: the fields that changed (API names, sorted). |
| `deletion` | string | `task.deleted` only: `archived` (can be restored), `deleted` (gone for good) or `moved` (to another workspace). |
| `truncated` | `true` | Only when the event was over 256 KB: the longest text (a description or comment) was shortened. Fetch the full resource from the API. |

Dates are `YYYY-MM-DD`, times ISO 8601 in UTC, and every field is present
(`null` rather than missing).

A task's custom tags carry their `label` and `color` when the tag belongs to
the event's workspace (for a personal endpoint: your own personal tags). A tag
from anywhere else (another workspace, or someone's personal tag that ended up
on a team task) is sent as `{"id": …, "label": null, "color": null}`, so an
endpoint never learns the name of a tag its owner couldn't see.

Events can arrive out of order, and very rarely more than once. Use `id` to
ignore repeats and `createdAt` / `data.updatedAt` to keep the newest.

## Verifying signatures

Each endpoint has its own **signing secret** (`whsec_…`). Kanbo shows it once,
when you add the endpoint (or rotate it). Keep it with your receiver.

To check a delivery:

1. Read the **raw** request body exactly as it arrived (before any JSON
   parsing).
2. Split `Kanbo-Signature` on commas: `t` is a Unix timestamp; `v1` is a
   signature (there can be more than one `v1`).
3. Compute `HMAC-SHA256(secret, t + "." + rawBody)` as lowercase hex.
4. It's genuine if it equals **any** `v1` (compare in constant time) **and**
   `t` is within 5 minutes of now (this stops someone replaying an old
   delivery).

### Node.js (Express)

```js
import crypto from "node:crypto";
import express from "express";

const SECRET = process.env.KANBO_WEBHOOK_SECRET; // whsec_…
const app = express();

function isFromKanbo(rawBody, header, secret, toleranceSec = 300) {
  if (!header) return false;
  let t = null;
  const sigs = [];
  for (const part of header.split(",")) {
    const [k, v] = part.trim().split("=");
    if (k === "t") t = Number(v);
    if (k === "v1") sigs.push(v);
  }
  if (!Number.isFinite(t) || Math.abs(Date.now() / 1000 - t) > toleranceSec) return false;
  const expected = crypto.createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
  return sigs.some((s) => s.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
}

// express.raw keeps the exact bytes Kanbo signed
app.post("/kanbo", express.raw({ type: "application/json" }), (req, res) => {
  const raw = req.body.toString("utf8");
  if (!isFromKanbo(raw, req.get("Kanbo-Signature"), SECRET)) return res.sendStatus(400);
  const event = JSON.parse(raw);
  res.sendStatus(204);                 // answer first…
  queueForProcessing(event);           // …then do the slow work
});
```

### Python (Flask)

```python
import hashlib, hmac, os, time
from flask import Flask, request, abort

SECRET = os.environ["KANBO_WEBHOOK_SECRET"]  # whsec_…
app = Flask(__name__)

def is_from_kanbo(raw_body, header, secret, tolerance=300):
    """True when the delivery is genuine and recent (raw_body: the exact text received)."""
    if not header:
        return False
    t, sigs = None, []
    for part in header.split(","):
        k, _, v = part.strip().partition("=")
        if k == "t" and v.isdigit():
            t = int(v)
        elif k == "v1":
            sigs.append(v)
    if t is None or abs(time.time() - t) > tolerance:
        return False
    expected = hmac.new(secret.encode(), f"{t}.{raw_body}".encode(), hashlib.sha256).hexdigest()
    return any(hmac.compare_digest(expected, s) for s in sigs)

@app.post("/kanbo")
def kanbo():
    raw = request.get_data(as_text=True)
    if not is_from_kanbo(raw, request.headers.get("Kanbo-Signature"), SECRET):
        abort(400)
    event = request.get_json()
    enqueue(event)  # do the slow work elsewhere
    return "", 204
```

Rotating a secret (**Rotate secret** in Settings, or
`POST /v1/webhooks/:id/rotate-secret`) replaces it at once: the old one stops
working immediately, so update your receiver straight away.

## Answering a delivery

- Answer with any **2xx** within **10 seconds**. Do slow work afterwards.
- Anything else counts as a failure: another status, no answer in time, a TLS
  or connection error.
- **Redirects aren't followed.** A 3xx is a failure; use the final address.
- Kanbo only reads your status line; the response body is ignored.

## Retries and switching off

A failed delivery is tried again after **1 minute, 5 minutes, 30 minutes,
2 hours and 6 hours** (six tries in all, about 8½ hours). After the sixth it
is marked **failed**. Every try sends the same body, `id` and
`Kanbo-Delivery`; `Kanbo-Attempt` and the signature's `t` change.

An endpoint that fails **20 times in a row** is **switched off**: everything
still waiting for it is given up, and the person who added it gets a note in
their Kanbo Inbox. Fix the endpoint, then switch it back on in Settings (or
`PATCH /v1/webhooks/:id` with `{"active": true}`); its failure count starts
again from zero. Any successful delivery also resets the count.

While an endpoint is switched off, nothing new is queued for it.

**Test events** (`ping`, from **Send test** or `POST /v1/webhooks/:id/test`) go
only to that endpoint, even while it's switched off; they're never retried and
don't count towards switching it off. At most 5 a minute per endpoint.

**Send again**: any failed (or waiting) event can be sent again now from the
endpoint's recent deliveries, or with
`POST /v1/webhooks/:id/deliveries/:deliveryId/redeliver`. It gets a fresh set
of retries, and if it fails again it counts towards switching the endpoint
off like any other delivery. At most **10 a minute per endpoint** (Settings
and the API share the count). A test event can't be sent again: send a new
test instead.

Kanbo keeps 14 days of delivery history.

## Event catalogue

| Event | When | Notes |
|---|---|---|
| `task.created` | A task is added, or moved into this workspace. | |
| `task.updated` | A task's title, description, status, priority, project, section, assignee, dates, tags, estimate, logged time, parent, milestone flag or repeat changes. | `changes` lists the fields. Kanbo-only things (ranking, plans, followers, reactions) don't count. |
| `task.completed` | A task is marked done. | Sent **as well as** `task.updated`. |
| `task.deleted` | A task is archived, deleted, or moved to another workspace. | `deletion`: `archived`, `deleted` or `moved`. Archiving sends only this (not `task.updated`). |
| `comment.created` | Someone comments on a task. | `data` is the comment plus `task` (id, title, project, link). |
| `project.created` | A project is added. | |
| `project.updated` | A project's name, emoji, colour, description, status, owner, people, archive state or workspace changes. | `changes` lists the fields. |
| `member.joined` | Someone joins the workspace (accepts an invite, or is added). | Team endpoints only. |
| `ping` | You sent a test. | Never subscribed to; never retried. |

A task moved from one workspace to another is `task.deleted`
(`deletion: "moved"`) for the old workspace's endpoints and `task.created`
for the new one's.

### `task.created`

```json
{
  "id": "evt_4810",
  "type": "task.created",
  "createdAt": "2026-10-05T08:12:44.120Z",
  "workspaceId": "3f2b8c1e-5a7d-4e90-b6c4-2d8e1f0a9b77",
  "data": {
    "object": "task",
    "id": "0b6f4e2a-91c3-4d7e-8a5b-3c2d1e0f9a8b",
    "title": "Draft the launch email",
    "description": "First pass for Thursday's send. Keep it under 150 words.",
    "status": "todo",
    "priority": "high",
    "workspaceId": "3f2b8c1e-5a7d-4e90-b6c4-2d8e1f0a9b77",
    "projectId": "7d3e9a10-2b4c-4f6e-8a1d-5c7b9e0f2a3d",
    "sectionId": null,
    "parentId": null,
    "assigneeId": "a4c8e2f6-1b3d-4a5c-9e7f-2d4b6a8c0e1f",
    "createdBy": "e1d2c3b4-a5f6-4e7d-8c9b-0a1f2e3d4c5b",
    "dueDate": "2026-10-08",
    "dueTime": "14:00",
    "startDate": "2026-10-05",
    "completedAt": null,
    "tags": [
      {
        "id": "design",
        "label": "Design",
        "color": "oklch(0.74 0.16 305)"
      },
      {
        "id": "8c1d2e3f-4a5b-4c6d-9e7f-0a1b2c3d4e5f",
        "label": "Launch",
        "color": "oklch(0.7 0.12 30)"
      }
    ],
    "effortHours": 3,
    "loggedHours": null,
    "isMilestone": false,
    "recurrence": "none",
    "archived": false,
    "archivedAt": null,
    "createdAt": "2026-10-05T08:12:44.120Z",
    "updatedAt": "2026-10-05T08:12:44.120Z",
    "url": "https://www.kanbo.co.uk/?task=0b6f4e2a-91c3-4d7e-8a5b-3c2d1e0f9a8b"
  }
}
```

### `task.updated`

`changes` uses the API's field names. Here the task was started and handed to
someone:

```json
{
  "id": "evt_4811",
  "type": "task.updated",
  "createdAt": "2026-10-05T09:41:10.532Z",
  "workspaceId": "3f2b8c1e-5a7d-4e90-b6c4-2d8e1f0a9b77",
  "data": {
    "object": "task",
    "id": "0b6f4e2a-91c3-4d7e-8a5b-3c2d1e0f9a8b",
    "title": "Draft the launch email",
    "description": "First pass for Thursday's send. Keep it under 150 words.",
    "status": "progress",
    "priority": "high",
    "workspaceId": "3f2b8c1e-5a7d-4e90-b6c4-2d8e1f0a9b77",
    "projectId": "7d3e9a10-2b4c-4f6e-8a1d-5c7b9e0f2a3d",
    "sectionId": null,
    "parentId": null,
    "assigneeId": "a4c8e2f6-1b3d-4a5c-9e7f-2d4b6a8c0e1f",
    "createdBy": "e1d2c3b4-a5f6-4e7d-8c9b-0a1f2e3d4c5b",
    "dueDate": "2026-10-08",
    "dueTime": "14:00",
    "startDate": "2026-10-05",
    "completedAt": null,
    "tags": [
      {
        "id": "design",
        "label": "Design",
        "color": "oklch(0.74 0.16 305)"
      },
      {
        "id": "8c1d2e3f-4a5b-4c6d-9e7f-0a1b2c3d4e5f",
        "label": "Launch",
        "color": "oklch(0.7 0.12 30)"
      }
    ],
    "effortHours": 3,
    "loggedHours": 1.5,
    "isMilestone": false,
    "recurrence": "none",
    "archived": false,
    "archivedAt": null,
    "createdAt": "2026-10-05T08:12:44.120Z",
    "updatedAt": "2026-10-05T09:41:10.532Z",
    "url": "https://www.kanbo.co.uk/?task=0b6f4e2a-91c3-4d7e-8a5b-3c2d1e0f9a8b"
  },
  "changes": [
    "assigneeId",
    "status"
  ]
}
```

### `task.completed`

```json
{
  "id": "evt_4813",
  "type": "task.completed",
  "createdAt": "2026-10-05T15:02:31.004Z",
  "workspaceId": "3f2b8c1e-5a7d-4e90-b6c4-2d8e1f0a9b77",
  "data": {
    "object": "task",
    "id": "0b6f4e2a-91c3-4d7e-8a5b-3c2d1e0f9a8b",
    "title": "Draft the launch email",
    "description": "First pass for Thursday's send. Keep it under 150 words.",
    "status": "done",
    "priority": "high",
    "workspaceId": "3f2b8c1e-5a7d-4e90-b6c4-2d8e1f0a9b77",
    "projectId": "7d3e9a10-2b4c-4f6e-8a1d-5c7b9e0f2a3d",
    "sectionId": null,
    "parentId": null,
    "assigneeId": "a4c8e2f6-1b3d-4a5c-9e7f-2d4b6a8c0e1f",
    "createdBy": "e1d2c3b4-a5f6-4e7d-8c9b-0a1f2e3d4c5b",
    "dueDate": "2026-10-08",
    "dueTime": "14:00",
    "startDate": "2026-10-05",
    "completedAt": "2026-10-05",
    "tags": [
      {
        "id": "design",
        "label": "Design",
        "color": "oklch(0.74 0.16 305)"
      },
      {
        "id": "8c1d2e3f-4a5b-4c6d-9e7f-0a1b2c3d4e5f",
        "label": "Launch",
        "color": "oklch(0.7 0.12 30)"
      }
    ],
    "effortHours": 3,
    "loggedHours": 1.5,
    "isMilestone": false,
    "recurrence": "none",
    "archived": false,
    "archivedAt": null,
    "createdAt": "2026-10-05T08:12:44.120Z",
    "updatedAt": "2026-10-05T15:02:31.004Z",
    "url": "https://www.kanbo.co.uk/?task=0b6f4e2a-91c3-4d7e-8a5b-3c2d1e0f9a8b"
  }
}
```

### `task.deleted`

```json
{
  "id": "evt_4820",
  "type": "task.deleted",
  "createdAt": "2026-10-06T10:00:00.000Z",
  "workspaceId": "3f2b8c1e-5a7d-4e90-b6c4-2d8e1f0a9b77",
  "data": {
    "object": "task",
    "id": "0b6f4e2a-91c3-4d7e-8a5b-3c2d1e0f9a8b",
    "title": "Draft the launch email",
    "description": "First pass for Thursday's send. Keep it under 150 words.",
    "status": "done",
    "priority": "high",
    "workspaceId": "3f2b8c1e-5a7d-4e90-b6c4-2d8e1f0a9b77",
    "projectId": "7d3e9a10-2b4c-4f6e-8a1d-5c7b9e0f2a3d",
    "sectionId": null,
    "parentId": null,
    "assigneeId": "a4c8e2f6-1b3d-4a5c-9e7f-2d4b6a8c0e1f",
    "createdBy": "e1d2c3b4-a5f6-4e7d-8c9b-0a1f2e3d4c5b",
    "dueDate": "2026-10-08",
    "dueTime": "14:00",
    "startDate": "2026-10-05",
    "completedAt": "2026-10-05",
    "tags": [
      {
        "id": "design",
        "label": "Design",
        "color": "oklch(0.74 0.16 305)"
      },
      {
        "id": "8c1d2e3f-4a5b-4c6d-9e7f-0a1b2c3d4e5f",
        "label": "Launch",
        "color": "oklch(0.7 0.12 30)"
      }
    ],
    "effortHours": 3,
    "loggedHours": 1.5,
    "isMilestone": false,
    "recurrence": "none",
    "archived": true,
    "archivedAt": "2026-10-06T10:00:00.000Z",
    "createdAt": "2026-10-05T08:12:44.120Z",
    "updatedAt": "2026-10-05T15:02:31.004Z",
    "url": "https://www.kanbo.co.uk/?task=0b6f4e2a-91c3-4d7e-8a5b-3c2d1e0f9a8b"
  },
  "deletion": "archived"
}
```

### `comment.created`

```json
{
  "id": "evt_4814",
  "type": "comment.created",
  "createdAt": "2026-10-05T09:55:02.310Z",
  "workspaceId": "3f2b8c1e-5a7d-4e90-b6c4-2d8e1f0a9b77",
  "data": {
    "object": "comment",
    "id": "5e4d3c2b-1a09-4f8e-9d7c-6b5a4f3e2d1c",
    "taskId": "0b6f4e2a-91c3-4d7e-8a5b-3c2d1e0f9a8b",
    "parentId": null,
    "authorId": "a4c8e2f6-1b3d-4a5c-9e7f-2d4b6a8c0e1f",
    "authorName": "Priya Shah",
    "body": "Draft's in the doc — @Sam can you check the subject line?",
    "mentions": [
      "e1d2c3b4-a5f6-4e7d-8c9b-0a1f2e3d4c5b"
    ],
    "createdAt": "2026-10-05T09:55:02.310Z",
    "task": {
      "id": "0b6f4e2a-91c3-4d7e-8a5b-3c2d1e0f9a8b",
      "title": "Draft the launch email",
      "projectId": "7d3e9a10-2b4c-4f6e-8a1d-5c7b9e0f2a3d",
      "url": "https://www.kanbo.co.uk/?task=0b6f4e2a-91c3-4d7e-8a5b-3c2d1e0f9a8b"
    }
  }
}
```

### `project.created`

```json
{
  "id": "evt_4700",
  "type": "project.created",
  "createdAt": "2026-09-22T10:03:00.000Z",
  "workspaceId": "3f2b8c1e-5a7d-4e90-b6c4-2d8e1f0a9b77",
  "data": {
    "object": "project",
    "id": "7d3e9a10-2b4c-4f6e-8a1d-5c7b9e0f2a3d",
    "workspaceId": "3f2b8c1e-5a7d-4e90-b6c4-2d8e1f0a9b77",
    "name": "Autumn launch",
    "emoji": "🚀",
    "color": "oklch(0.7 0.12 30)",
    "description": "Everything for the 14 October launch.",
    "status": "on_track",
    "ownerId": "e1d2c3b4-a5f6-4e7d-8c9b-0a1f2e3d4c5b",
    "contributorIds": [
      "a4c8e2f6-1b3d-4a5c-9e7f-2d4b6a8c0e1f"
    ],
    "createdBy": "e1d2c3b4-a5f6-4e7d-8c9b-0a1f2e3d4c5b",
    "archived": false,
    "archivedAt": null,
    "createdAt": "2026-09-22T10:03:00.000Z",
    "url": "https://www.kanbo.co.uk/p/7d3e9a10-2b4c-4f6e-8a1d-5c7b9e0f2a3d"
  }
}
```

### `project.updated`

```json
{
  "id": "evt_4815",
  "type": "project.updated",
  "createdAt": "2026-10-05T11:20:00.000Z",
  "workspaceId": "3f2b8c1e-5a7d-4e90-b6c4-2d8e1f0a9b77",
  "data": {
    "object": "project",
    "id": "7d3e9a10-2b4c-4f6e-8a1d-5c7b9e0f2a3d",
    "workspaceId": "3f2b8c1e-5a7d-4e90-b6c4-2d8e1f0a9b77",
    "name": "Autumn launch",
    "emoji": "🚀",
    "color": "oklch(0.7 0.12 30)",
    "description": "Everything for the 14 October launch.",
    "status": "at_risk",
    "ownerId": "e1d2c3b4-a5f6-4e7d-8c9b-0a1f2e3d4c5b",
    "contributorIds": [
      "a4c8e2f6-1b3d-4a5c-9e7f-2d4b6a8c0e1f"
    ],
    "createdBy": "e1d2c3b4-a5f6-4e7d-8c9b-0a1f2e3d4c5b",
    "archived": false,
    "archivedAt": null,
    "createdAt": "2026-09-22T10:03:00.000Z",
    "url": "https://www.kanbo.co.uk/p/7d3e9a10-2b4c-4f6e-8a1d-5c7b9e0f2a3d"
  },
  "changes": [
    "status"
  ]
}
```

### `member.joined`

```json
{
  "id": "evt_4816",
  "type": "member.joined",
  "createdAt": "2026-10-05T12:00:00.000Z",
  "workspaceId": "3f2b8c1e-5a7d-4e90-b6c4-2d8e1f0a9b77",
  "data": {
    "object": "member",
    "id": "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d",
    "workspaceId": "3f2b8c1e-5a7d-4e90-b6c4-2d8e1f0a9b77",
    "userId": "b7c6d5e4-f3a2-4b1c-9d0e-8f7a6b5c4d3e",
    "name": "Tom Reyes",
    "email": "tom@foundrise.co.uk",
    "role": "member",
    "status": "active",
    "title": "Designer",
    "createdAt": "2026-10-01T09:00:00.000Z"
  }
}
```

### `ping`

```json
{
  "id": "evt_4817",
  "type": "ping",
  "createdAt": "2026-10-05T12:05:00.000Z",
  "workspaceId": "3f2b8c1e-5a7d-4e90-b6c4-2d8e1f0a9b77",
  "data": {
    "webhookId": "c924fcff-0938-4900-a8e7-9cbbb564a762",
    "url": "https://hooks.example.com/kanbo",
    "events": [
      "task.completed",
      "task.created"
    ],
    "message": "This is a test event from Kanbo. If you can read this, your endpoint works."
  }
}
```

## Managing webhooks with the API

The same things Settings does, with an API key
(`Authorization: Bearer kanbo_sk_…`). Reading needs any key; changes need a
**read & write** key (`kanbo_sk_…`). A **workspace key** only reaches its own
workspace's endpoints (never personal ones); a **personal key** reaches your
personal endpoints and every workspace where you can edit.

Base address: `https://htnchiljplrnjkwimgla.supabase.co/functions/v1/api/v1`

| Method and path | Does | Key |
|---|---|---|
| `GET /webhooks?workspace=<id\|personal>` | List endpoints (never their secrets). Without `workspace`: everything the key can reach. | read |
| `POST /webhooks` | Add one: `{url, events, description?, workspaceId?}`. Returns it **with its secret, once** (201). | write |
| `GET /webhooks/:id` | One endpoint. | read |
| `PATCH /webhooks/:id` | Change `url`, `events`, `description` (`null` clears) or `active`. | write |
| `DELETE /webhooks/:id` | Delete it and its history (204). | write |
| `POST /webhooks/:id/rotate-secret` | New secret, shown once; the old one stops at once. | write |
| `POST /webhooks/:id/test` | Queue a `ping` (202). 5 a minute. | write |
| `GET /webhooks/:id/deliveries?limit=1–100` | Recent deliveries, newest first. | read |
| `POST /webhooks/:id/deliveries/:deliveryId/redeliver` | Send one again now (one of the last 100, not a `ping`) (202). 10 a minute per endpoint. | write |

Only the person who added an endpoint, or a workspace owner or admin, can
change, test, rotate or delete it (`canManage` says whether you can). Everyone
else who can see a team endpoint gets its `url` **masked**: the host and the
path's last four characters, e.g. `https://hooks.zapier.com/…x2kd`. Catch-hook
addresses (Zapier, Make and the like) often work as a password, so the full
address is only for the people who manage it.

```bash
# add a team endpoint; copy "secret" from the answer, it's shown only now
curl -s https://htnchiljplrnjkwimgla.supabase.co/functions/v1/api/v1/webhooks \
  -H "Authorization: Bearer $KANBO_KEY" -H "Content-Type: application/json" \
  -d '{"url":"https://hooks.example.com/kanbo","events":["task.created","task.completed"],"workspaceId":"3f2b8c1e-5a7d-4e90-b6c4-2d8e1f0a9b77"}'

# send it a test, then see how it went
curl -s -X POST -H "Authorization: Bearer $KANBO_KEY" \
  https://htnchiljplrnjkwimgla.supabase.co/functions/v1/api/v1/webhooks/<id>/test
curl -s -H "Authorization: Bearer $KANBO_KEY" \
  "https://htnchiljplrnjkwimgla.supabase.co/functions/v1/api/v1/webhooks/<id>/deliveries?limit=5"
```

An endpoint:

```json
{
  "object": "webhook",
  "id": "c924fcff-0938-4900-a8e7-9cbbb564a762",
  "workspaceId": "3f2b8c1e-5a7d-4e90-b6c4-2d8e1f0a9b77",
  "url": "https://hooks.example.com/kanbo",
  "description": "New tasks into the ops sheet",
  "events": ["task.completed", "task.created"],
  "active": true,
  "createdBy": "e1d2c3b4-a5f6-4e7d-8c9b-0a1f2e3d4c5b",
  "createdByName": "Sam Patel",
  "failureCount": 0,
  "lastStatus": 204,
  "lastError": null,
  "lastDeliveryAt": "2026-10-05T09:41:11.020Z",
  "disabledAt": null,
  "disabledReason": null,
  "createdAt": "2026-09-28T14:02:51.000Z",
  "updatedAt": "2026-10-05T09:41:11.020Z",
  "canManage": true
}
```

A delivery (`statusCode` 0 means there was no answer: a timeout, a refused
connection, a DNS problem, or an address Kanbo won't call):

```json
{
  "object": "webhook_delivery",
  "id": "1aefcd04-d7e3-4f30-96e8-2a7008b6045c",
  "webhookId": "c924fcff-0938-4900-a8e7-9cbbb564a762",
  "eventId": "evt_4811",
  "event": "task.updated",
  "state": "pending",
  "attempt": 2,
  "statusCode": 503,
  "error": "HTTP 503 Service Unavailable",
  "durationMs": 412,
  "nextAttemptAt": "2026-10-05T09:47:12.000Z",
  "deliveredAt": null,
  "createdAt": "2026-10-05T09:41:10.600Z",
  "updatedAt": "2026-10-05T09:42:12.000Z"
}
```

Errors use the API's usual shape, e.g.
`{"error":{"code":"validation_failed","message":"…","status":422,"details":{"fields":{"url":"…"}}}}`.
`403 forbidden` for a read-only key, a workspace key outside its workspace, or
a guest; `404` for an endpoint the key can't reach; `409 conflict` at the
limit, for a delivery that already arrived, or for sending a test event again;
`429` for too many tests or too many sent again (with `Retry-After`).

## Security

- **HTTPS only**, to a real hostname: no IP addresses, no `user:password@`,
  no internal names (`localhost`, `.local`, `.internal`, `.lan`, …).
- Before every delivery Kanbo looks the host up and sends **only if every
  address is public**: never private (10/8, 172.16/12, 192.168/16), loopback,
  link-local (including cloud metadata at 169.254.169.254), carrier-grade NAT,
  unique-local IPv6, multicast, reserved or documentation ranges, or IPv6
  forms that wrap them. It then connects to one of exactly those addresses
  (checking the TLS certificate against your hostname), so a second DNS answer
  can't point it somewhere else. Redirects aren't followed. It never calls
  Kanbo's own servers.
- **Secrets** are kept on Kanbo's server only and shown once. Kanbo's logs
  carry the event, host, status and timing — never secrets, signatures, paths
  or bodies.
- **Addresses** are shown in full only to the people who can manage the
  endpoint; teammates who can see it get it masked
  (`https://hooks.zapier.com/…x2kd`), in Settings and in the API alike.
- **Fair shares.** Deliveries are handed out so that no one can crowd anyone
  else out: at most 2 are being sent at once to any one endpoint, 4 for any
  one person's endpoints and 4 for any one workspace's, and whoever has least
  in flight goes first. A slow or very busy endpoint only slows itself down.
- **No hammering.** Test events are limited to 5 a minute and "send again" to
  10 a minute per endpoint; test events can't be sent again, and every other
  failure counts towards switching the endpoint off.
- An endpoint only ever hears what the person who added it can see (custom
  tag names included: only the event's own workspace's, or for a personal
  endpoint their own). If they
  leave the workspace, become a guest, or their account is suspended, their
  endpoints are **switched off** ("the person who added it no longer has
  access") and nothing more is sent. A workspace owner or admin can delete it
  and add a new one.
- Endpoints, secrets and deliveries are in server-only tables; people manage
  them through checked database functions, never directly.

## Limits

| | |
|---|---|
| Endpoints | 20 a workspace, 10 personal |
| Events per endpoint | 1 to 8 |
| URL | https, up to 2000 characters |
| Description | up to 200 characters |
| Body | up to 256 KB (long text is shortened, `truncated: true`) |
| Timeout | 10 seconds; redirects not followed |
| Retries | 1 m, 5 m, 30 m, 2 h, 6 h |
| Switch-off | 20 failures in a row |
| Test events | 5 a minute per endpoint |
| Send again | 10 a minute per endpoint (Settings and the API together); not for test events |
| Sent at once | 2 per endpoint, 4 per person's endpoints, 4 per workspace |
| History | 14 days |

---

## Running it (owner steps)

Webhooks need database update 0046 (`docs/integrations/database-0046.md`).
Then:

### 1. Deploy the dispatcher

```bash
supabase functions deploy webhook-dispatch --no-verify-jwt
```

It uses secrets that are already set: `CRON_SECRET` and `APP_URL`
(`SUPABASE_DB_URL`, `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are
provided by Supabase). **Verify JWT** stays off (`supabase/config.toml`): only
the scheduler and the database call it, with the `x-cron-secret` header;
anyone else gets `401`.

### 2. Run it every minute

In the SQL editor
(<https://supabase.com/dashboard/project/htnchiljplrnjkwimgla/sql/new>), paste
and press **Run** (the first line says "0 rows" the first time; that's fine):

```sql
select cron.unschedule(jobid) from cron.job where jobname = 'kanbo-webhook-dispatch';

select cron.schedule(
  'kanbo-webhook-dispatch',
  '* * * * *',
  $$
  select net.http_post(
    url := 'https://htnchiljplrnjkwimgla.supabase.co/functions/v1/webhook-dispatch',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'kanbo_cron_secret')
    ),
    body := '{"source":"cron"}'::jsonb,
    timeout_milliseconds := 5000
  );
  $$
);
```

The function answers straight away (`202`) and carries on delivering in the
background for up to about 40 seconds, so the 5-second timeout is plenty.

### 3. Optional: deliver within seconds

Without this, deliveries go out within a minute. With it, the database wakes
the dispatcher right after each change (at most once every 3 seconds):

```sql
select vault.create_secret('https://htnchiljplrnjkwimgla.supabase.co/functions/v1', 'kanbo_functions_url');
```

### 4. Daily tidy-up

Already in `docs/integrations/database-0046.md` (`kanbo-api-housekeeping`):
it clears delivery history older than 14 days.

### Checking it

```sql
-- the job runs (latest status should be "succeeded")
select start_time, status, return_message from cron.job_run_details
 where jobid = (select jobid from cron.job where jobname = 'kanbo-webhook-dispatch')
 order by start_time desc limit 5;

-- nothing stuck: events waiting to be fanned out, deliveries due now
select (select count(*) from public.webhook_outbox where processed_at is null) as events_waiting,
       (select count(*) from public.webhook_deliveries where state = 'pending' and next_attempt_at < now() - interval '2 minutes') as overdue;

-- overdue, per endpoint: one busy or slow endpoint backs up only itself
-- (fair shares: 2 at once per endpoint, 4 per person, 4 per workspace)
select substring(w.url from '^https://([^/:?#]+)') as host, w.workspace_id, count(*) as overdue
  from public.webhook_deliveries d join public.webhooks w on w.id = d.webhook_id
 where d.state = 'pending' and d.next_attempt_at < now() - interval '2 minutes'
 group by 1, 2 order by 3 desc limit 10;

-- the last hour, per endpoint host
select substring(w.url from '^https://([^/:?#]+)') as host, d.state, count(*), round(avg(d.duration_ms)) as avg_ms
  from public.webhook_deliveries d join public.webhooks w on w.id = d.webhook_id
 where d.updated_at > now() - interval '1 hour' group by 1, 2 order by 1, 2;
```

To run it by hand and see the counts (`{"wait": true}` waits for the run):

```bash
curl -s -X POST https://htnchiljplrnjkwimgla.supabase.co/functions/v1/webhook-dispatch \
  -H "x-cron-secret: $CRON_SECRET" -H "Content-Type: application/json" -d '{"wait":true}'
# → {"ok":true,"queued":2,"attempted":2,"delivered":2,"retrying":0,"failed":0,"disabled":0,"skipped":0,"rounds":2,"ms":640}
# (rounds = claims made: each free sender claims more as soon as it's free)
```

Logs: <https://supabase.com/dashboard/project/htnchiljplrnjkwimgla/functions/webhook-dispatch/logs>.
A `401` means the Vault secret and `CRON_SECRET` don't match.
