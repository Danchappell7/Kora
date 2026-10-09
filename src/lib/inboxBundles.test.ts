/* lib/inboxTriage bundleInbox: related items fold into one row, mentions never do. */
import { describe, expect, it } from "vitest";
import { actorList, bundleFamily, bundleInbox, bundleSummary, triage } from "./inboxTriage";
import type { Activity, ActivityKind, Task } from "../data/types";

let n = 0;
const item = (kind: ActivityKind, taskId: string | null, detail: string, extra: Partial<Activity> = {}): Activity => ({
  id: `a${++n}`, taskId, taskTitle: taskId === "deck" ? "Launch deck" : "Q3 budget", kind, detail,
  createdAt: new Date(Date.UTC(2026, 9, 9, 10, 60 - n)).toISOString(), readAt: undefined, ...extra,
});
const task = (id: string, title: string): Task => ({
  id, title, description: "", status: "todo", priority: "medium", projectId: "p-launch", assigneeId: "me",
  tags: [], dependencies: [], subtasks: [], focusMin: 30, comments: 0, aiScore: 0,
});
const tasks = [task("deck", "Launch deck"), task("budget", "Q3 budget")];

describe("bundleInbox", () => {
  it("folds comments on the same task: '3 comments on Launch deck from Sana and Theo'", () => {
    const feed = [
      item("comment", "deck", "Sana Rao"),
      item("comment", "budget", "Maya Lin"),
      item("comment", "deck", "Theo Vance", { readAt: "2026-10-09T10:00:00Z" }),
      item("comment", "deck", "Sana Rao"),
    ];
    const b = bundleInbox(feed, { tasks, group: "fyi" });
    expect(b.map((x) => x.key)).toEqual(["fyi:deck:comment", feed[1].id]);
    expect(b[0].items.map((a) => a.id)).toEqual([feed[0].id, feed[2].id, feed[3].id]);
    expect(b[0].summary).toBe("3 comments on Launch deck from Sana and Theo");
    expect(b[0].actors).toEqual(["Sana Rao", "Theo Vance"]);
    expect([b[0].unread, b[0].latestAt, b[0].family]).toEqual([2, feed[0].createdAt, "comment"]);
    // a bundle of one is a plain row
    expect([b[1].items.length, b[1].family, b[1].summary]).toEqual([1, null, "Q3 budget"]);
  });

  it("never buries anything that asks something of you: mentions, assignments, approvals, requests, doc mentions", () => {
    const feed = [
      item("mention", "deck", "Sana Rao"), item("mention", "deck", "Theo Vance"),
      item("assigned", "deck", "Maya Lin"), item("assigned", "deck", "Sana Rao"),
      item("approval", "deck", "Sana Rao"), item("approval", "deck", "Sana Rao"),
      item("assigned", "deck", "Request via Launch requests"), item("assigned", "deck", "Request via Launch requests"),
      item("doc_mention", null, "Sana Rao"), item("doc_mention", null, "Sana Rao"),
      item("integration", null, ""),
    ];
    expect(bundleInbox(feed, { tasks }).every((b) => b.items.length === 1)).toBe(true);
  });

  it("each bundle sits at its newest item's place; other families stay apart", () => {
    const feed = [
      item("assigned", "deck", "Maya Lin"),
      item("comment", "deck", "Sana Rao"),
      item("kudos", "deck", "Theo Vance"),
      item("comment", "deck", "Theo Vance"),
      item("kudos", "deck", "Sana Rao"),
    ];
    const b = bundleInbox(feed, { tasks, group: "fyi" });
    expect(b.map((x) => x.family)).toEqual([null, "comment", "kudos"]);
    expect(b.map((x) => x.summary)).toEqual([
      "Launch deck",
      "2 comments on Launch deck from Sana and Theo",
      "2 kudos for Launch deck from Theo and Sana",
    ]);
  });

  it("your own updates fold together (no 'from')", () => {
    const feed = [item("status", "deck", ""), item("completed", "deck", ""), item("comment", "deck", "Looks great, ship it!")];
    const b = bundleInbox(feed, { tasks, actorOf: (a) => (a.kind === "comment" && !/[!,]/.test(a.detail) ? a.detail : null) });
    expect(b).toHaveLength(1);
    expect(b[0].summary).toBe("3 updates to Launch deck");
    expect(b[0].actors).toEqual([]);
  });

  it("bundle: false keeps every item on its own", () => {
    const feed = [item("comment", "deck", "Sana Rao"), item("comment", "deck", "Theo Vance")];
    expect(bundleInbox(feed, { tasks, bundle: false }).map((b) => b.items.length)).toEqual([1, 1]);
  });

  it("works per triage group (a mention and comments on one task stay in their groups)", () => {
    const feed = [item("mention", "deck", "Sana Rao"), item("comment", "deck", "Sana Rao"), item("comment", "deck", "Theo Vance")];
    const g = triage(feed, { me: "me", tasks });
    expect(bundleInbox(g.reply, { tasks, group: "reply" }).map((b) => b.items.length)).toEqual([1]);
    expect(bundleInbox(g.fyi, { tasks, group: "fyi" }).map((b) => b.summary)).toEqual(["2 comments on Launch deck from Sana and Theo"]);
  });
});

describe("bundle words", () => {
  it("names people by first name, unless two share one; four or more → 'and N others'", () => {
    expect(actorList(["Sana Rao"])).toBe("Sana");
    expect(actorList(["Sana Rao", "Theo Vance", "Maya Lin"])).toBe("Sana, Theo and Maya");
    expect(actorList(["Sam Hill", "Sam Ito"])).toBe("Sam Hill and Sam Ito");
    expect(actorList(["Sana Rao", "Theo Vance", "Maya Lin", "Ada Ng"])).toBe("Sana, Theo and 2 others");
    expect(actorList(["sam@partner.io", "Theo Vance"])).toBe("sam@partner.io and Theo");
  });
  it("families and summaries", () => {
    expect(bundleFamily(item("comment", "deck", "Sana Rao"), "Sana Rao")).toBe("comment");
    expect(bundleFamily(item("comment", "deck", "Nice!"), null)).toBe("history");
    expect(bundleFamily(item("created", "deck", ""), null)).toBeNull();
    expect(bundleFamily(item("comment", null, "Sana Rao"), "Sana Rao")).toBeNull();
    expect(bundleSummary("kudos", 1, "Launch deck", ["Theo Vance"])).toBe("1 kudos for Launch deck from Theo");
    expect(bundleSummary("comment", 2, "", [])).toBe("2 comments on a task");
  });
});
