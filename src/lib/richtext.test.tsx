import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { safeHref, renderRich } from "./richtext";

const links = (md: string, names: string[] = []) => {
  const { container } = render(<div>{renderRich(md, names)}</div>);
  return Array.from(container.querySelectorAll("a")).map((a) => ({ text: a.textContent, href: a.getAttribute("href") }));
};

describe("safeHref", () => {
  it("allows http, https, mailto and tel", () => {
    expect(safeHref("https://docs.google.com/d/1")).toBe("https://docs.google.com/d/1");
    expect(safeHref("http://example.com")).toBe("http://example.com");
    expect(safeHref("mailto:dan@acme.com")).toBe("mailto:dan@acme.com");
    expect(safeHref("tel:+442071234567")).toBe("tel:+442071234567");
    expect(safeHref("HTTPS://EXAMPLE.COM")).toBe("HTTPS://EXAMPLE.COM");
  });

  it("rejects script-capable and other schemes", () => {
    for (const u of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,<script>alert(1)</script>", "vbscript:msgbox(1)", "file:///etc/passwd", "blob:https://x/1"]) {
      expect(safeHref(u)).toBeNull();
    }
  });

  it("strips C0 controls, invisible characters and whitespace before testing the scheme", () => {
    expect(safeHref("java\tscript:alert(1)")).toBeNull();
    expect(safeHref("java\nscript:alert(1)")).toBeNull();
    expect(safeHref("java\u0000script:alert(1)")).toBeNull();
    expect(safeHref("\u0001javascript:alert(1)")).toBeNull();
    expect(safeHref("  javascript:alert(1)")).toBeNull();
    expect(safeHref("java​script:alert(1)")).toBeNull();
    expect(safeHref(" javascript:alert(1)")).toBeNull();
    expect(safeHref("java script:alert(1)")).toBeNull();
    expect(safeHref("javascript :alert(1)")).toBeNull();
    expect(safeHref("  https://acme.com  ")).toBe("https://acme.com");
    expect(safeHref("https://acme.com/my file.pdf")).toBe("https://acme.com/my%20file.pdf");
    expect(safeHref("tel:+44 20 7123 4567")).toBe("tel:+442071234567");
  });

  it("prefixes scheme-less hosts with https:// so they don't open inside Kanbo", () => {
    expect(safeHref("www.acme.com/spec")).toBe("https://www.acme.com/spec");
    expect(safeHref("acme.co.uk")).toBe("https://acme.co.uk");
    expect(safeHref("acme.com:8080/x")).toBe("https://acme.com:8080/x");
    expect(safeHref("//cdn.acme.com/a.png")).toBe("https://cdn.acme.com/a.png");
    expect(safeHref("dan@acme.com")).toBe("mailto:dan@acme.com");
  });

  it("keeps explicit same-origin paths and rejects non-destinations", () => {
    expect(safeHref("/settings")).toBe("/settings");
    expect(safeHref("#section")).toBe("#section");
    expect(safeHref("/\\evil.com")).toBeNull(); // browsers read "/\\host" as "//host"
    expect(safeHref("spec")).toBeNull();
    expect(safeHref("")).toBeNull();
    expect(safeHref("https://")).toBeNull();
    expect(safeHref("mailto:")).toBeNull();
  });
});

describe("renderRich links", () => {
  it("autolinks bare http(s) and www. URLs", () => {
    expect(links("See https://docs.google.com/document/d/abc for details")).toEqual([
      { text: "https://docs.google.com/document/d/abc", href: "https://docs.google.com/document/d/abc" },
    ]);
    expect(links("go to www.acme.com")).toEqual([{ text: "www.acme.com", href: "https://www.acme.com" }]);
  });

  it("trims trailing punctuation but keeps balanced parentheses", () => {
    expect(links("Read https://acme.com/a.")[0].href).toBe("https://acme.com/a");
    expect(links("(see https://acme.com/a)")[0].href).toBe("https://acme.com/a");
    expect(links("https://en.wikipedia.org/wiki/Foo_(bar), ok")[0].href).toBe("https://en.wikipedia.org/wiki/Foo_(bar)");
    expect(links("done: https://acme.com/x?y=1!")[0].href).toBe("https://acme.com/x?y=1");
  });

  it("keeps the surrounding text intact", () => {
    const { container } = render(<div>{renderRich("before https://acme.com/x. after")}</div>);
    expect(container.textContent).toBe("before https://acme.com/x. after");
  });

  it("renders markdown links safely", () => {
    expect(links("[Spec](www.acme.com/spec)")).toEqual([{ text: "Spec", href: "https://www.acme.com/spec" }]);
    expect(links("[Wiki](https://en.wikipedia.org/wiki/Foo_(bar))")[0].href).toBe("https://en.wikipedia.org/wiki/Foo_(bar)");
    // unsafe targets render the label as plain text, never as a link
    expect(links("[click](javascript:alert(1))")).toEqual([]);
    expect(links("[click](java\tscript:alert(1))")).toEqual([]);
    const { container } = render(<div>{renderRich("[click](javascript:alert(1))")}</div>);
    expect(container.textContent).toContain("click");
  });

  it("opens links in a new tab without leaking the opener", () => {
    const { container } = render(<div>{renderRich("https://acme.com")}</div>);
    const a = container.querySelector("a")!;
    expect(a.getAttribute("target")).toBe("_blank");
    expect(a.getAttribute("rel")).toContain("noopener");
  });

  it("does not autolink inside code spans, words or emails", () => {
    expect(links("`https://acme.com`")).toEqual([]);
    expect(links("foo.www.acme.com")).toEqual([]);
    expect(links("mail dan@www.acme.com")).toEqual([]);
  });

  it("links inside bold/italic and next to mentions", () => {
    expect(links("**see https://acme.com**")).toEqual([{ text: "https://acme.com", href: "https://acme.com" }]);
    const { container } = render(<div>{renderRich("@Dan see https://acme.com", ["Dan"])}</div>);
    expect(container.querySelector("strong")?.textContent).toBe("@Dan");
    expect(container.querySelector("a")?.getAttribute("href")).toBe("https://acme.com");
  });
});
