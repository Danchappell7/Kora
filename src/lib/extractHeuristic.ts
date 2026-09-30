/* ============================================================
   KANBO — Paste notes → tasks, on-device.
   Reads the actions out of meeting notes when Kanbo's AI isn't
   available (demo, off, over the daily limit, offline). It picks up:
     · checklist lines            "- [ ] Book the venue", "[ ] Order lunch"
     · marked lines               "TODO: …", "Action: …", "AP: …", "Next step: …"
     · owners                     "Sana to send the brief by Fri",
                                  "Theo will chase legal", "@maya draft the FAQ",
                                  "I'll send the recap"
     · bullets under a heading "Actions" / "Next steps" / "Action items"
       (with or without a colon — Google Docs and Notion copy headings as
       bare lines), until the next heading or a blank line and prose
   Dates, times and priorities in the line go through the one grammar
   (lib/nlp). People are matched against the workspace; a name that
   isn't in it is kept as `assigneeName` so the review sheet can flag it.
   ============================================================ */
import { matchMember, parseTask } from "./nlp";
import type { ExtractedTask } from "./askTypes";

export interface ExtractOptions {
  members: { id: string; name: string }[];
  today?: Date;
  /** the signed-in user, for "I'll …" / "I will …" */
  me?: string;
}

const MAX_TITLE = 200;
const BULLET = /^(?:[-*•◦▪‣·–—+]\s+|\d{1,3}[.)]\s+|[a-z][.)]\s+)/;
const CHECKBOX = /^\[([ xX✓✔]?)\]\s*|^([☐□▢☑☒✅✔✓])\s*/;
const TICKED = /[xX✓✔☑☒✅]/;
const MARKER = /^(?:todo|to[- ]do|action(?:\s+(?:item|point))?|ap|next\s+steps?|follow[- ]?up)\s*[:\-–—]\s*/i;
const ACTION_HEADING = /^(?:actions?|action\s+(?:items?|points?)|next\s+steps?|to[- ]?dos?|tasks?|follow[- ]?ups?|owners?\s*(?:&|and)\s*actions?)(?:\s+(?:from|for)\b.*)?$/i;
/** headings that end an Actions section even without a colon ("Notes", "Decisions") */
const OTHER_HEADING = /^(?:notes?|decisions?(?:\s+made)?|agenda|attendees|present|apologies|discussion|summary|updates?|questions?|open\s+questions|risks?|parking\s+lot|fyi|minutes|recap|context|background|key\s+points|highlights)$/i;
/** a plain line under Actions that is chat, not a task ("Thanks everyone", "Next meeting is Monday") */
const PROSE = /^(?:thanks|thank\s+you|cheers|great|good|nice|well\s+done|welcome|hi|hello|see\s+you|we\b|everyone|all\s+good|next\s+(?:meeting|call|sync|session|catch[- ]?up|check[- ]?in|review)\b)|\?$/i;
/** "Budget to be approved", "Sana will be told": nobody named does the work */
const PASSIVE = /^(?:be|been|being|get|gets|got)\b/i;
// capitalised words that open minutes the way a name does, but are things
const NOT_PEOPLE = new Set([
  "budget", "pricing", "price", "design", "legal", "finance", "marketing", "sales", "engineering", "product", "ops", "operations",
  "support", "website", "site", "app", "deck", "launch", "release", "contract", "invoice", "report", "roadmap", "plan", "project",
  "meeting", "doc", "docs", "copy", "brief", "date", "deadline", "venue", "event", "hr", "board", "leadership", "management",
  "client", "clients", "customer", "customers", "vendor", "supplier", "agency", "office", "data", "dashboard", "api", "server",
  "migration", "timeline", "scope", "proposal", "feedback", "review", "demo", "video", "press", "pr", "faq", "onboarding", "hiring",
  "everything", "nothing", "something", "everyone", "nobody", "it", "work", "bug", "bugs", "issue", "issues",
]);
// words that open a sentence the way a name would, but aren't people
const NOT_NAMES = new Set([
  "i", "we", "they", "you", "he", "she", "it", "this", "that", "these", "those", "everyone", "everybody", "someone",
  "somebody", "nobody", "all", "team", "there", "here", "need", "needs", "want", "wants", "plan", "plans", "going", "also",
  "then", "and", "but", "so", "please", "let", "lets", "what", "who", "when", "where", "why", "how", "which", "maybe",
  "might", "must", "should", "could", "would", "next", "remember", "decided", "decision", "agreed", "discussed",
  "question", "note", "notes", "time", "nice", "good", "great", "happy", "hard", "easy", "welcome", "thanks", "thank",
  "reminder", "moving", "back", "ready", "hope", "trying", "today", "tomorrow", "monday", "tuesday", "wednesday",
  "thursday", "friday", "saturday", "sunday", "action", "todo", "follow", "ap", "update", "updates", "q1", "q2", "q3", "q4",
]);

type Owner = { id?: string; name: string };

function ownerOf(name: string, members: ExtractOptions["members"]): Owner | null {
  const clean = name.replace(/^@/, "").replace(/['’]s$/, "").trim();
  if (!clean || NOT_NAMES.has(clean.toLowerCase())) return null;
  const m = matchMember(clean, members);
  if (m) return { id: m.id, name: clean };
  // someone not in the workspace is kept (the sheet flags them); a thing never is
  return clean.split(/\s+/).some((w) => NOT_PEOPLE.has(w.toLowerCase())) ? null : { name: clean };
}

/** "Sana to send…", "Theo will…", "@maya draft…", "I'll…" → the owner and the rest. */
function splitOwner(s: string, o: ExtractOptions, marked: boolean): { owner?: Owner; rest: string } | null {
  let m = s.match(/^@([\p{L}][\p{L}\p{N}._-]*)[,:]?\s+(?:(?:to|will|should|can)\s+)?(.+)$/u);
  if (m) {
    const who = matchMember(m[1].replace(/[._-]+$/, ""), o.members);
    return { owner: who ? { id: who.id, name: m[1] } : { name: m[1] }, rest: m[2] };
  }
  m = s.match(/^(?:I\s+will|I['’]ll|I\s+am\s+going\s+to|I['’]m\s+going\s+to|I\s+to)\s+(.+)$/);
  if (m) return { owner: o.me ? { id: o.me, name: "me" } : undefined, rest: m[1] };
  // "Maya Lin to …" / "Sana will …" / "Theo'll …"
  m = s.match(/^([\p{Lu}][\p{L}-]+(?:\s+[\p{Lu}][\p{L}-]+)?)(?:\s+(to|will|is\s+going\s+to|needs?\s+to|should)|['’]ll)\s+(.+)$/u);
  // "Budget to be approved by Friday": passive, so no one named owns it
  if (m && PASSIVE.test(m[3])) return null;
  if (m) {
    const owner = ownerOf(m[1], o.members);
    // an unknown name counts in the minutes' own form ("Priya to …"), or on a marked line;
    // "Pricing will change" is a sentence, not an action
    if (owner && (owner.id || marked || (m[2] ?? "").toLowerCase() === "to")) return { owner, rest: m[3] };
    if (owner || NOT_NAMES.has(m[1].toLowerCase())) return null;
  }
  if (marked) {
    // "Action: Maya – update the roadmap", "AP: Theo: book the room"
    m = s.match(/^([\p{Lu}][\p{L}-]+)\s*[:–—-]\s+(.+)$/u);
    if (m) {
      const owner = ownerOf(m[1], o.members);
      if (owner) return { owner, rest: m[2] };
    }
  }
  return null;
}

/** "Book the venue (Theo)" / "Book the venue – Theo": a workspace member named at the end. */
function trailingOwner(s: string, members: ExtractOptions["members"]): { owner: Owner; rest: string } | null {
  const m = s.match(/^(.+?)\s*(?:\(\s*@?([\p{L}][\p{L}-]*(?:\s+[\p{L}][\p{L}-]*)?)\s*\)|[–—-]\s*@?([\p{Lu}][\p{L}-]*(?:\s+[\p{Lu}][\p{L}-]*)?))\s*\.?$/u);
  if (!m) return null;
  const name = m[2] ?? m[3];
  const who = matchMember(name, members);
  return who && !NOT_NAMES.has(name.toLowerCase()) ? { owner: { id: who.id, name }, rest: m[1] } : null;
}

const tidy = (s: string) => {
  const t = s.replace(/\s+/g, " ").replace(/^["“‘']|["”’']$/g, "").replace(/[\s.;,]+$/, "").trim();
  const capped = t.length > MAX_TITLE ? t.slice(0, MAX_TITLE).trimEnd() : t;
  return capped.charAt(0).toUpperCase() + capped.slice(1);
};

/** The actions in a block of notes, in order, without duplicates. */
export function extractTasks(text: string, opts: ExtractOptions): ExtractedTask[] {
  const out: ExtractedTask[] = [];
  const seen = new Set<string>();
  let underActions = false;
  // a blank line since the heading or the section's last line: a plain line
  // after one is the notes moving on, not another action
  let gap = false;
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    let s = raw.trim();
    if (!s) { gap = true; continue; }
    // a heading switches "everything below is an action" on or off: "## Actions",
    // "Next steps:", "**Action items**", or a bare short line that can only be one
    const heading = s.replace(/^#{1,6}\s*/, "").replace(/^\*\*(.+)\*\*$/, "$1").replace(/:$/, "").trim();
    const styled = /^#{1,6}\s/.test(s) || /:$/.test(s) || /^\*\*.+\*\*:?$/.test(s);
    const bare = !BULLET.test(s) && (ACTION_HEADING.test(heading) || OTHER_HEADING.test(heading));
    if ((styled || bare) && heading.split(/\s+/).length <= 4) { underActions = ACTION_HEADING.test(heading); gap = false; continue; }

    let confidence = 0;
    const bulleted = BULLET.test(s);
    s = s.replace(BULLET, "");
    const box = s.match(CHECKBOX);
    if (box) {
      if (TICKED.test(box[1] ?? box[2] ?? "")) continue;   // ticked: already done
      s = s.slice(box[0].length);
      confidence = 0.9;
    }
    const marker = s.match(MARKER);
    if (marker) { s = s.slice(marker[0].length); confidence = Math.max(confidence, 0.9); }
    const marked = confidence > 0;
    const listed = marked || bulleted;

    // under an Actions heading: its bullets, and plain lines until a blank line
    // and prose (the notes moving on) close the section
    let inSection = underActions;
    if (inSection && !listed && (gap || PROSE.test(s))) {
      if (gap) underActions = false;
      inSection = false;
    }
    if (inSection) gap = false;

    let owner: Owner | undefined;
    const split = splitOwner(s, opts, marked || inSection);
    if (split) { owner = split.owner; s = split.rest; confidence = Math.max(confidence, 0.8); }
    else if (!marked && !inSection) continue;   // prose: not an action
    if (!owner) {
      const tail = trailingOwner(s, opts.members);
      if (tail) { owner = tail.owner; s = tail.rest; }
    }
    if (!confidence) confidence = bulleted ? 0.6 : 0.5;

    // dates, times and priorities in the line; "urgent" in notes means urgent
    const urgent = /(^|[\s(\[,;])urgent(?![\w'’])/i.test(s);
    const p = parseTask(s, { today: opts.today, kinds: ["date", "time", "priority"], priorityWords: true });
    const title = tidy(p.title);
    if (title.length < 2) continue;
    const key = title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const priority = p.priority === "high" && urgent && !p.spans.some((x) => x.kind === "priority" && /!/.test(s.slice(x.start, x.end))) ? "urgent" : p.priority;
    out.push({
      title,
      ...(owner?.id ? { assigneeId: owner.id } : {}),
      ...(owner && owner.name !== "me" ? { assigneeName: owner.name } : {}),
      ...(p.dueDate ? { dueDate: p.dueDate } : {}),
      ...(p.dueTime ? { dueTime: p.dueTime } : {}),
      ...(priority ? { priority } : {}),
      note: raw.trim(),
      confidence,
    });
  }
  return out;
}
