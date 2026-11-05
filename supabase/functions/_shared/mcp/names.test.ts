// @vitest-environment node
import { describe, expect, it } from "vitest";
import { readMentions, readPerson, readProject } from "./names.ts";

const p = (id: string, name: string) => ({ id, name });
const one = (r: { kind: string; hit?: { id: string } }) => (r.kind === "one" ? r.hit!.id : r.kind);

describe("reading a project's name", () => {
  const list = [p("a", "Shops redesign"), p("b", "Q3 Product Launch"), p("c", "Launch east"), p("d", "Ops"), p("e", "Marketing")];
  it.each([
    ["Ops", "d"], ["ops", "d"], ["Marketing", "e"], ["mark", "e"], ["shops", "a"], ["redesign", "a"], ["q3", "b"],
  ])("%s means %s", (q, id) => expect(one(readProject(q, list))).toBe(id));
  it("never a piece of a word", () => {
    expect(one(readProject("hops", list))).toBe("none");
    expect(one(readProject("esign", list))).toBe("none");
    expect(one(readProject("ops", [p("a", "Shops redesign")]))).toBe("none");
  });
  it("more than one fitting equally is nobody's guess", () => {
    const r = readProject("launch", list);
    expect(r.kind).toBe("several");
    expect(r.kind === "several" && r.hits.map((h) => h.id)).toEqual(["b", "c"]);
  });
  it("the exact name beats a word in another", () => {
    expect(one(readProject("launch", [...list, p("f", "Launch")]))).toBe("f");
  });
  it("one letter is too little, and nothing is nothing", () => {
    expect(one(readProject("m", list))).toBe("none");
    expect(one(readProject("", list))).toBe("none");
    expect(one(readProject("##", list))).toBe("none");
  });
});

describe("reading a person's name", () => {
  const people = [p("j", "Joanna Smith"), p("s1", "Sam Jones"), p("s2", "Sam Rao"), p("a", "Anna Lee"), p("me", "me"), p("r", "Rae José")];
  it.each([
    ["joanna", "j"], ["Joanna Smith", "j"], ["joa", "j"], ["smith", "j"], ["me", "me"], ["anna", "a"], ["Sam Jones", "s1"], ["jose", "r"],
  ])("%s means %s", (q, id) => expect(one(readPerson(q, people))).toBe(id));
  it("never a piece of a word", () => {
    expect(one(readPerson("ann", [p("j", "Joanna Smith")]))).toBe("none");
    expect(one(readPerson("oann", people))).toBe("none");
  });
  it("the start of a word two people share is nobody's guess", () => {
    expect(readPerson("jo", people).kind).toBe("several");
  });
  it("two with the same first name are both named", () => {
    const r = readPerson("sam", people);
    expect(r.kind === "several" && r.hits.map((h) => h.id)).toEqual(["s1", "s2"]);
  });
});

describe("reading @names in a comment", () => {
  const people = [p("bob", "Bob Baker"), p("s1", "Sam Jones"), p("s2", "Sam Rao"), p("me", "Alice Adams")];
  const ids = (body: string) => readMentions(body, people, "me").people.map((x) => x.id);
  it("a first name only one person has, or a full name", () => {
    expect(ids("@Bob can you check this today?")).toEqual(["bob"]);
    expect(ids("Could @bob, or (@Bob Baker), look?")).toEqual(["bob"]);
    expect(ids("@Sam Jones please")).toEqual(["s1"]);
    expect(ids("Line one\n@Bob")).toEqual(["bob"]);
  });
  it("two people with that first name: neither, and it says so", () => {
    const r = readMentions("@Sam please", people);
    expect(r.people).toEqual([]);
    expect(r.notes).toEqual(["“@Sam” could be Sam Jones or Sam Rao, so it reached neither. Write their full name."]);
  });
  it("no guessing from part of a name", () => {
    const r = readMentions("@Ba and @Bo", people);
    expect(r.people).toEqual([]);
    expect(r.notes).toHaveLength(2);
  });
  it("an email address isn't a mention", () => {
    expect(readMentions("mail bob@example.org", people)).toEqual({ people: [], notes: [] });
  });
  it("you don't mention yourself, and each person and note counts once", () => {
    expect(ids("@Alice")).toEqual([]);
    expect(ids("@Bob @bob @Bob Baker")).toEqual(["bob"]);
    expect(readMentions("@Zed and @zed", people).notes).toHaveLength(1);
  });
});
