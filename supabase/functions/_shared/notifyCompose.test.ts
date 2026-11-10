// What a notification says: lone notices, bundles, the due list and the digest.
import { describe, expect, it } from "vitest";
import {
  composeBundle, digestEmail, digestThreads, dueEmail, eventEmail, filterDigestItems, kudosEmail, kudosPush, noticeLine, peopleList,
  postedLine, statusWord, updateAskEmail, updateAskPush, updateDueEmail, updateDuePush, updatePostedEmail, updatePostedPush, type ComposeRow, type DigestItem,
} from "./notifyCompose";

const T = "22222222-2222-4222-8222-222222222222";
const row = (kind: string, actor: string, at: string, title = "Launch deck"): ComposeRow => ({
  kind, actor_name: actor, title, task_id: T, created_at: `2026-10-09T09:0${at}:00Z`, payload: { v: 1, line: noticeLine(kind, actor), url: `/?task=${T}` },
});

describe("lone notices", () => {
  it("lines and the classic email, escaped", () => {
    expect([noticeLine("mention", "Sana Rao"), noticeLine("comment", ""), noticeLine("assigned", "Maya Lin"), noticeLine("kudos", "Theo")])
      .toEqual(["Sana Rao mentioned you", "Someone commented", "Maya Lin assigned you this task", "Theo sent you kudos"]);
    const m = eventEmail("comment", "<b>Eve</b>", "Fix \"quotes\" & <tags>", "https://www.kanbo.co.uk/?task=1");
    expect(m.subject).toBe("New comment: Fix \"quotes\" & <tags>");
    expect(m.html).toContain("&lt;b&gt;Eve&lt;/b&gt;");
    expect(m.html).toContain("Fix &quot;quotes&quot; &amp; &lt;tags&gt;");
    expect(m.html).not.toContain("<tags>");
  });
});

describe("bundles", () => {
  it("one kind: '3 comments on Launch deck from Sana and Theo', the push replacing the task's last one", () => {
    const c = composeBundle([row("comment", "Sana Rao", "1"), row("comment", "Theo Vance", "2"), row("comment", "Sana Rao", "3")], "https://www.kanbo.co.uk");
    expect(c.push).toEqual({ title: "3 comments on Launch deck", body: "From Sana and Theo", url: `/?task=${T}`, tag: `task-${T}`, kind: "comment" });
    expect(c.email?.subject).toBe("3 comments on Launch deck from Sana and Theo");
    expect(c.email?.html).toContain(`href="https://www.kanbo.co.uk/?task=${T}"`);
    expect(c.email?.text).toContain("Theo Vance commented");
  });

  it("mixed kinds: every mention named first", () => {
    const c = composeBundle([row("comment", "Theo Vance", "1"), row("mention", "Sana Rao", "2"), row("assigned", "Maya Lin", "3"), row("mention", "Theo Vance", "4")], "");
    expect(c.push?.title).toBe("4 updates on Launch deck");
    expect(c.push?.body).toBe("Sana and Theo mentioned you · Maya assigned it to you · From Theo, Maya and Sana");
    expect(c.push?.kind).toBe("mention");
    expect(c.email?.html).not.toContain("href=");   // no APP_URL, no link
  });

  it("escapes names and titles", () => {
    const c = composeBundle([row("comment", "<img src=x>", "1", "<script>"), row("comment", "Ann Lee", "2", "<script>")], "https://x.test");
    expect(c.email?.html).not.toMatch(/<script>|<img/);
  });

  it("people: first names unless two share one", () => {
    expect(peopleList(["Sam Hill", "Sam Ito", "Sam Hill"])).toBe("Sam Hill and Sam Ito");
    expect(peopleList(["A One", "B Two", "C Three", "D Four"])).toBe("A, B and 2 others");
    expect(peopleList([])).toBe("");
  });
});

describe("the morning due list", () => {
  it("oldest first, overdue marked, capped at 50", () => {
    const tasks = Array.from({ length: 52 }, (_, i) => ({ id: `t${i}`, title: `Task ${i}`, due_date: i === 0 ? "2026-10-01" : "2026-10-09" }));
    const m = dueEmail(tasks, "2026-10-09", "https://www.kanbo.co.uk");
    expect(m.subject).toBe("52 tasks due on Kanbo");
    expect(m.html.indexOf("Task 0")).toBeLessThan(m.html.indexOf("Task 1"));
    expect(m.html).toContain("Overdue");
    expect(m.html).toContain("…and 2 more.");
    expect(dueEmail([], "2026-10-09", "", 3).subject).toBe("3 tasks due on Kanbo");
  });
});

describe("the daily digest", () => {
  const item = (id: string, kind: string, task: string | null, detail: string, at: string, title = task === "deck" ? "Launch deck" : "Q3 budget"): DigestItem =>
    ({ id, kind, task_id: task, task_title: title, detail, created_at: `2026-10-09T0${at}:00:00Z` });

  it("threads: one per task, mentions first, your own history left out", () => {
    const threads = digestThreads([
      item("1", "comment", "budget", "Maya Lin", "1"),
      item("2", "comment", "deck", "Sana Rao", "2"),
      item("3", "comment", "deck", "Theo Vance", "3"),
      item("4", "mention", "budget", "Theo Vance", "4"),
      item("5", "status", "deck", "", "5"),
      item("6", "doc_mention", null, "Sana Rao", "6", "Launch brief"),
      item("7", "assigned", "deck", "Request via Launch requests", "7"),
    ]);
    expect(threads.map((t) => [t.title, t.lines])).toEqual([
      ["Launch brief", ["Sana mentioned you"]],
      ["Q3 budget", ["Theo mentioned you", "1 comment from Maya"]],
      ["Launch deck", ["New request via Launch requests", "2 comments from Theo and Sana"]],
    ]);
  });

  it("the email: updates then what's due; nothing to say → no email", () => {
    expect(digestEmail([], [], "2026-10-09", "https://www.kanbo.co.uk")).toBeNull();
    const threads = digestThreads([item("1", "mention", "deck", "Sana Rao", "1"), item("2", "comment", "deck", "Theo Vance", "2")]);
    const m = digestEmail(threads, [{ id: "t9", title: "Pay invoices", due_date: "2026-10-08" }], "2026-10-09", "https://www.kanbo.co.uk", { firstName: "Maya", digestTime: "08:00" })!;
    expect(m.subject).toBe("Your Kanbo digest: 2 updates, 1 task due");
    expect(m.html).toContain("Your Kanbo digest, Maya");
    expect(m.html).toContain("Sana mentioned you · 1 comment from Theo");
    expect(m.html).toContain("Overdue");
    expect(m.html).toContain("https://www.kanbo.co.uk/inbox");
    expect(m.text).toContain("one email a day at 08:00");
  });

  it("leaves out snoozed threads, tasks they can't see and kinds whose email is off", () => {
    const items = [
      item("1", "comment", "deck", "Sana Rao", "1"), item("2", "comment", "budget", "Theo Vance", "2"),
      item("3", "mention", "gone", "Theo Vance", "3"), item("4", "doc_mention", null, "Sana Rao", "4"), item("5", "kudos", "deck", "Maya Lin", "5"),
    ];
    const kept = filterDigestItems(items, new Set(["deck", "budget"]), new Set(["budget"]), (k) => k !== "kudos");
    expect(kept.map((x) => x.id)).toEqual(["1", "4"]);
  });
});

describe("kudos notices (0048: notify { kind: 'kudos' })", () => {
  it("push: who, the emoji, the task and the note, opening the task", () => {
    expect(kudosPush("Theo Vance", "👏", "Great work", "Launch deck", "t-1")).toEqual({
      title: "Theo Vance sent you 👏", body: "For Launch deck: “Great work”", url: "/?task=t-1", tag: "kudos-t-1", kind: "kudos",
    });
    expect(kudosPush("", "🙌", null, "", "t-2")).toMatchObject({ title: "Someone sent you 🙌", body: "For a task" });
  });
  it("an emoji outside the ten reads 🎉; titles and notes stay on one line", () => {
    const p = kudosPush("Sana", "<b>", "line one\nline two", "Deck\r\nv2", "t-3");
    expect(p.title).toBe("Sana sent you 🎉");
    expect(p.body).toBe("For Deck v2: “line one line two”");
  });
  it("email: escaped, with the note and a link", () => {
    const m = kudosEmail("Theo <script>", "🏆", "You <b>nailed</b> it", "Q3 & launch", "https://kanbo.test/?task=t-1");
    expect(m.subject).toBe("🏆 Kudos from Theo <script>: Q3 & launch");
    expect(m.html).toContain("Theo &lt;script&gt;");
    expect(m.html).toContain("“You &lt;b&gt;nailed&lt;/b&gt; it”");
    expect(m.html).toContain("Q3 &amp; launch");
    expect(m.html).toContain('href="https://kanbo.test/?task=t-1"');
    expect(kudosEmail("Sana", "🎉", "", "Deck", "").html).not.toContain("Open in Kanbo");
  });
});

describe("project updates (0053: the update-day reminder and Ask for an update)", () => {
  const P = "33333333-3333-4333-8333-333333333333";
  it("the reminder: one project says when it's due, several list themselves; it opens Today", () => {
    const one = updateDuePush([{ projectId: P, name: "Q3 launch", when: "today", followUp: 0 }]);
    expect(one).toMatchObject({ title: "Your Q3 launch update is due today", url: "/today", tag: "kanbo-updates", kind: "update" });
    expect(updateDuePush([{ projectId: P, name: "Q3 launch", when: "Fri 6 Nov", followUp: 1 }]).title).toBe("Your Q3 launch update was due Fri 6 Nov");
    const many = updateDuePush([{ projectId: P, name: "Q3 launch", when: "today", followUp: 0 }, { projectId: T, name: "Brand", when: "today", followUp: 0 }]);
    expect(many).toMatchObject({ title: "2 project updates are waiting on you", body: "Q3 launch and Brand. Kanbo has drafts ready." });
  });
  it("its email links each project's Updates tab, escaped, and says nothing posts on its own", () => {
    const m = updateDueEmail([{ projectId: P, name: "<b>Q3</b> launch", when: "today", followUp: 0 }], "https://www.kanbo.co.uk");
    expect(m.subject).toBe("Your <b>Q3</b> launch update is due today");
    expect(m.html).toContain("&lt;b&gt;Q3&lt;/b&gt;");
    expect(m.html).not.toContain("<b>Q3</b>");
    expect(m.html).toContain(`https://www.kanbo.co.uk/p/${P}/updates`);
    expect(m.text).toMatch(/Check it, change what you like, and post/);
    expect(m.text).toMatch(/at most twice more/);
  });
  it("an ask names who asked and opens the project's updates", () => {
    expect(updateAskPush("Theo Vance", "Winter League", P)).toMatchObject({ title: "Theo Vance asked for an update", body: "On Winter League. Kanbo has a draft ready.", url: `/p/${P}/updates`, kind: "update" });
    expect(updateAskEmail("Theo Vance", "Winter League", "https://x.example/p/1/updates").subject).toBe("Theo Vance asked for an update on Winter League");
    expect(noticeLine("update", "Theo Vance")).toBe("Theo Vance asked for an update");
  });
  it("two held asks on one project go as one, opening the project rather than the Inbox", () => {
    const ask = (actor: string, at: string): ComposeRow => ({ kind: "update", actor_name: actor, title: "Winter League", task_id: null, created_at: `2026-10-09T09:0${at}:00Z`,
      payload: { v: 1, line: noticeLine("update", actor), url: `/p/${P}/updates` } });
    const b = composeBundle([ask("Theo Vance", "1"), ask("Ada Lovelace", "2")], "https://www.kanbo.co.uk");
    expect(b.push?.url).toBe(`/p/${P}/updates`);
    expect(b.email?.html).toContain("Theo Vance asked for an update");
  });
  it("the digest carries your project updates, and an update alone is worth a digest", () => {
    const m = digestEmail([], [], "2026-10-09", "https://www.kanbo.co.uk", { updates: [{ projectId: P, name: "Q3 launch", line: "due today" }] })!;
    expect(m.subject).toBe("Your Kanbo digest: your project update");
    expect(m.html).toContain(`/p/${P}/updates`);
    expect(m.text).toMatch(/Kanbo has a draft ready on Today/);
  });
});

describe("a posted update (0054)", () => {
  const u = { actorName: "Sana Rao", projectName: "Brand <Refresh>", projectId: "p-1", status: "at_risk", summary: "Hero waits on copy.", ask: "Daniel, approve the hero by Thursday?" };
  it("the people its Ask names: a push and an email that lead with the ask", () => {
    const p = updatePostedPush(u);
    expect(p).toMatchObject({ title: "Sana Rao asked you something", url: "/p/p-1/updates", kind: "update" });
    expect(p.body).toBe("Brand <Refresh>: Daniel, approve the hero by Thursday?");
    const m = updatePostedEmail(u, true, "https://www.kanbo.co.uk/p/p-1/updates");
    expect(m.subject).toBe("Sana Rao asked you something in the Brand <Refresh> update");
    expect(m.html).toContain("Daniel, approve the hero by Thursday?");
    expect(m.html).toContain("Brand &lt;Refresh&gt;");
    expect(postedLine(u, true)).toBe("Sana Rao asked you something in an update");
  });
  it("everyone else: an FYI email with the call and the words", () => {
    const m = updatePostedEmail({ ...u, ask: null }, false, "");
    expect(m.subject).toBe("Sana Rao posted an update on Brand <Refresh>: At risk");
    expect(m.html).toContain("Hero waits on copy.");
    expect(postedLine(u, false)).toBe("Sana Rao posted an update");
    expect(statusWord("on_hold")).toBe("On hold");
    expect(statusWord("great")).toBe("");
  });
  it("the digest: an Ask for you, replies on yours, and what was posted, under the project", () => {
    const it = (id: string, meta: Record<string, unknown>, who = "Sana Rao"): DigestItem =>
      ({ id, task_id: null, task_title: "Brand Refresh", kind: "update", detail: who, created_at: `2026-11-10T09:0${id}:00Z`, meta });
    const [t] = digestThreads([it("1", { update_event: "posted", ask: true, status_update_id: "su" })]);
    expect(t).toMatchObject({ title: "Brand Refresh", lines: ["Sana asked you something in an update"] });
    const [r] = digestThreads([it("2", { update_event: "comment", ask: false }, "Maya Lin")]);
    expect(r.lines).toEqual(["1 reply on your update from Maya"]);
    const [f] = digestThreads([it("3", { update_event: "posted", ask: false })]);
    expect(f.lines).toEqual(["Sana posted an update"]);
  });
  it("the digest: a busy update is one thread for its project, not a line per reply", () => {
    const reply = (id: string, who: string, project = "p-1"): DigestItem =>
      ({ id, task_id: null, task_title: project === "p-1" ? "Brand Refresh" : "Launch", kind: "update", detail: who, created_at: `2026-11-10T09:0${id}:00Z`,
        meta: { update_event: "comment", ask: false, project_id: project, status_update_id: "su" } });
    const threads = digestThreads([reply("1", "Maya Lin"), reply("2", "Theo Vance"), reply("3", "Maya Lin"), reply("4", "Sana Rao", "p-2")]);
    expect(threads.map((t) => [t.title, t.lines])).toEqual([
      ["Launch", ["1 reply on your update from Sana"]],
      ["Brand Refresh", ["3 replies on your update from Maya and Theo"]],
    ]);
  });
});
