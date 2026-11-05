// ============================================================
// KANBO — reading names for the MCP server, where nobody is watching.
//
// The grammar's own match takes the first partial or substring hit, which is fine
// when a person sees the highlight as they type. A model reports success and the
// task lands in the wrong project, on the wrong person. So here a name counts only
// if it's an exact name, an exact first name or the start of a whole word, and
// when more than one fits, none of them is chosen and the caller says so.
//
// Pure module: names.test.ts.
// ============================================================
import { norm, words } from "../nlp.ts";

export interface Named { id: string; name: string }

export type NameRead<T> = { kind: "one"; hit: T } | { kind: "several"; hits: T[] } | { kind: "none" };

const read = <T>(hits: T[]): NameRead<T> | null =>
  hits.length === 1 ? { kind: "one", hit: hits[0] } : hits.length > 1 ? { kind: "several", hits } : null;

/** "#launch" → "Q3 Product Launch": the whole name, then a whole word, then (2+ letters) the start of a word. */
export function readProject<T extends Named>(q: string, projects: readonly T[]): NameRead<T> {
  const n = norm(q);
  if (!n) return { kind: "none" };
  const c = projects.map((p) => ({ p, full: norm(p.name), ws: words(p.name) }));
  return read(c.filter((x) => x.full === n).map((x) => x.p))
    ?? read(c.filter((x) => x.ws.includes(n)).map((x) => x.p))
    ?? (n.length >= 2 ? read(c.filter((x) => x.full.startsWith(n) || x.ws.some((w) => w.startsWith(n))).map((x) => x.p)) : null)
    ?? { kind: "none" };
}

/** "@sana" → "Sana Rao": the whole name, then a first name, then (2+ letters) the start of a word. */
export function readPerson<T extends Named>(q: string, people: readonly T[]): NameRead<T> {
  const n = norm(q);
  if (!n) return { kind: "none" };
  const c = people.map((m) => ({ m, full: norm(m.name), ws: words(m.name) }));
  return read(c.filter((x) => x.full === n).map((x) => x.m))
    ?? read(c.filter((x) => x.ws[0] === n).map((x) => x.m))
    ?? (n.length >= 2 ? read(c.filter((x) => x.ws.some((w) => w.startsWith(n))).map((x) => x.m)) : null)
    ?? { kind: "none" };
}

export interface MentionRead {
  /** the people the text exactly names */
  people: Named[];
  /** in plain words: every @name that reached nobody, and why */
  notes: string[];
}

const MENTION_RE = /(?:^|[\s(\[,;:])@(\p{L}[\p{L}\p{N}'’-]*)(?:[ \t]+(\p{L}[\p{L}\p{N}'’-]*))?/gu;

/**
 * @names in a comment, exactly: a full name ("@Sana Rao") or a first name only one person here has
 * ("@Sana"). A guess would notify the wrong person, so anything else reaches nobody, and the answer says so.
 */
export function readMentions(body: string, people: readonly Named[], me: string | null = null): MentionRead {
  const found = new Map<string, Named>();
  const notes: string[] = [];
  const noted = new Set<string>();
  const note = (key: string, line: string) => { if (!noted.has(key)) { noted.add(key); notes.push(line); } };
  const c = people.map((m) => ({ m, full: norm(m.name), first: words(m.name)[0] ?? "" }));
  for (const match of body.matchAll(MENTION_RE)) {
    const first = match[1], second = match[2];
    const both = second ? c.filter((x) => x.full === norm(`${first} ${second}`)) : [];
    const hits = both.length ? both : c.filter((x) => x.full === norm(first) || x.first === norm(first));
    if (hits.length === 1) {
      if (hits[0].m.id !== me) found.set(hits[0].m.id, hits[0].m);
    } else if (hits.length > 1) {
      note(norm(first), `“@${first}” could be ${hits.map((x) => x.m.name).join(" or ")}, so it reached neither. Write their full name.`);
    } else {
      note(norm(first), `No one called “${first}” is on this task's workspace, so @${first} reached nobody.`);
    }
  }
  return { people: [...found.values()], notes };
}
