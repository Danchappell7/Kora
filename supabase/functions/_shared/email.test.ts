// @vitest-environment node
// Unit tests for the Edge Functions' email helpers (escaping, links, Resend).
import { afterEach, describe, expect, it, vi } from "vitest";
import { adminRecipients, appUrlFrom, DEFAULT_APP_URL, esc, escapeLike, isEmail, oneLine, renderEmail, sendEmail, tokenLink, whereEmail } from "./email.ts";

afterEach(() => { vi.restoreAllMocks(); });

describe("escaping", () => {
  it("esc() neutralises tags, attributes and quotes", () => {
    expect(esc(`<a href="x" onclick='y'>&</a>`)).toBe("&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;");
    expect(esc(null)).toBe("");
  });

  it("renderEmail escapes the heading and the button, and builds a plain-text twin", () => {
    const { html, text } = renderEmail({
      heading: `Join <a href="https://evil.example">Payroll</a> on Kanbo`,
      paragraphs: [`Hi ${esc("<b>Bob</b>")},`],
      cta: { label: `Open "it"`, href: `https://www.kanbo.co.uk/?a=1&b="2"` },
      footnotes: ["Ignore if unexpected."],
    });
    expect(html).not.toContain(`<a href="https://evil.example"`);
    expect(html).toContain("Join &lt;a href=&quot;https://evil.example&quot;&gt;Payroll&lt;/a&gt; on Kanbo");
    expect(html).toContain(`href="https://www.kanbo.co.uk/?a=1&amp;b=&quot;2&quot;"`);
    expect(html).toContain("Hi &lt;b&gt;Bob&lt;/b&gt;,");
    expect(text).toContain(`Open "it": https://www.kanbo.co.uk/?a=1&b="2"`);
    expect(text).toContain("Hi <b>Bob</b>,");
    expect(text).not.toMatch(/<p|<div|<strong/);
  });

  it("oneLine flattens newlines and caps length", () => {
    expect(oneLine("Payroll\r\nBcc: x@y.z", 200)).toBe("Payroll Bcc: x@y.z");
    expect(oneLine("abcdefghij", 5)).toBe("abcd…");
  });

  it("escapeLike makes wildcards literal", () => {
    expect(escapeLike("j_smith%@a.co")).toBe("j\\_smith\\%@a.co");
  });

  it("whereEmail never lets a `*` act as a wildcard", () => {
    const calls: string[] = [];
    const q = {
      eq(c: string, v: string) { calls.push(`eq ${c} ${v}`); return q; },
      ilike(c: string, p: string) { calls.push(`ilike ${c} ${p}`); return q; },
    };
    whereEmail(q, "email", "j_smith@a.co");
    whereEmail(q, "email", "*@company.com"); // PostgREST reads * in a like pattern as %
    expect(calls).toEqual(["ilike email j\\_smith@a.co", "eq email *@company.com"]);
  });

  it("isEmail accepts real addresses only", () => {
    expect(isEmail("jo@company.co.uk")).toBe(true);
    expect(isEmail("jo@company")).toBe(false);
    expect(isEmail("not an email")).toBe(false);
    expect(isEmail(`${"a".repeat(250)}@x.io`)).toBe(false);
  });
});

describe("links", () => {
  it("appUrlFrom trims trailing slashes and refuses non-http values", () => {
    expect(appUrlFrom("https://www.kanbo.co.uk///")).toBe("https://www.kanbo.co.uk");
    expect(appUrlFrom("javascript:alert(1)")).toBe(DEFAULT_APP_URL);
    expect(appUrlFrom(undefined)).toBe(DEFAULT_APP_URL);
  });

  it("tokenLink builds the scanner-safe ?token_hash= landing link", () => {
    expect(tokenLink("https://www.kanbo.co.uk/", "ab c&d", "invite"))
      .toBe("https://www.kanbo.co.uk/?token_hash=ab%20c%26d&type=invite");
    expect(tokenLink("https://www.kanbo.co.uk", "h1", "recovery"))
      .toBe("https://www.kanbo.co.uk/?token_hash=h1&type=recovery");
  });
});

describe("sendEmail", () => {
  const mail = { to: "jo@company.co.uk", subject: "Hello\nthere", html: "<p>x</p>", text: "x", replyTo: "r@company.co.uk" };

  it("does nothing (and says so) when Resend isn't configured", async () => {
    const f = vi.fn();
    expect(await sendEmail({ resendKey: "" }, mail, f as unknown as typeof fetch)).toMatchObject({ ok: false, status: 0 });
    expect(f).not.toHaveBeenCalled();
  });

  it("sends html + text + reply_to with a one-line subject", async () => {
    const f = vi.fn(async () => new Response("{}", { status: 200 }));
    const r = await sendEmail({ resendKey: "re_x", from: "Kanbo <no-reply@kanbo.co.uk>" }, mail, f as unknown as typeof fetch);
    expect(r.ok).toBe(true);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ from: "Kanbo <no-reply@kanbo.co.uk>", to: "jo@company.co.uk", subject: "Hello there", text: "x", reply_to: "r@company.co.uk" });
  });

  it("retries once on a 429, then succeeds", async () => {
    vi.useFakeTimers();
    const f = vi.fn()
      .mockResolvedValueOnce(new Response("slow down", { status: 429 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    const p = sendEmail({ resendKey: "re_x" }, mail, f as unknown as typeof fetch);
    await vi.runAllTimersAsync();
    expect((await p).ok).toBe(true);
    expect(f).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("doesn't retry a permanent rejection, and reports it", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const f = vi.fn(async () => new Response("domain not verified", { status: 403 }));
    const r = await sendEmail({ resendKey: "re_x" }, mail, f as unknown as typeof fetch);
    expect(r).toMatchObject({ ok: false, status: 403, error: "domain not verified" });
    expect(f).toHaveBeenCalledTimes(1);
  });
});

describe("adminRecipients", () => {
  const db = (rows: unknown[], error: unknown = null) => ({
    from: () => ({ select: () => ({ eq: () => ({ limit: async () => ({ data: rows, error }) }) }) }),
  });

  it("merges ADMIN_NOTIFY_EMAIL with platform admins, de-duplicated", async () => {
    const out = await adminRecipients(
      db([{ email: "Dan@Kanbo.co.uk", suspended: false }, { email: "ops@company.co.uk", suspended: false }, { email: "gone@company.co.uk", suspended: true }, { email: null, suspended: false }]),
      "dan@kanbo.co.uk, team@company.co.uk; not-an-email",
    );
    expect(out.sort()).toEqual(["dan@kanbo.co.uk", "ops@company.co.uk", "team@company.co.uk"]);
  });

  it("still uses the secret when the admin lookup fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await adminRecipients(db([], { message: "boom" }), "a@b.co")).toEqual(["a@b.co"]);
  });
});
