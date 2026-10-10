// What a notification says: lone notices, bundles, the due list and the digest.
import { describe, expect, it } from "vitest";
import { composeBundle, digestEmail, digestThreads, dueEmail, eventEmail, filterDigestItems, kudosEmail, kudosPush, noticeLine, peopleList, type ComposeRow, type DigestItem } from "./notifyCompose";

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
