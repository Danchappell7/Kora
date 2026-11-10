import { describe, it, expect, vi, afterEach } from "vitest";
import { posterHtml, printPoster, showPoster } from "./packPoster";
import { openPosterWindow } from "./posterWindow";

const URL_ = "https://www.kanbo.co.uk/f/abc123";

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("posterHtml", () => {
  it("is one A4 page: the headline, its line, the QR code for the link, how to use it, and whose form it is", () => {
    const html = posterHtml({ headline: "Something broken?", line: "Scan to tell the team.", formName: "Report a maintenance problem", projectName: "Studio maintenance", workspaceName: "Northside Studios", url: URL_ });
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("@page{size:A4 portrait");
    expect(html).toContain("<h1>Something broken?</h1>");
    expect(html).toContain('<p class="line">Scan to tell the team.</p>');
    expect(html).toMatch(/<svg [^>]*role="img"[^>]*><title>QR code that opens the Report a maintenance problem form<\/title>/);
    expect(html).toContain(`<p class="url">${URL_}</p>`);
    expect(html).toContain("Report a maintenance problem · Studio maintenance · Northside Studios");
    expect(html).toContain("Point your phone's camera at the code");
  });

  it("escapes everything it's given, and keeps a colour that isn't one out of the page", () => {
    const html = posterHtml({ headline: "<script>alert(1)</script>", formName: 'A "form" & more', url: URL_, color: "red;}</style><script>x()</script>" });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("A &quot;form&quot; &amp; more");
    expect(html).toContain("background:#1F2A44");
    expect(posterHtml({ headline: "x", formName: "y", url: URL_, color: "oklch(0.7 0.1 22)" })).toContain("background:oklch(0.7 0.1 22)");
    // no line, no empty paragraph
    expect(posterHtml({ headline: "x", formName: "y", url: URL_ })).not.toContain('class="line"');
  });
});

describe("the poster's window", () => {
  const fakeWindow = () => {
    const doc = { open: vi.fn(), write: vi.fn(), close: vi.fn() };
    return { document: doc, focus: vi.fn(), print: vi.fn(), close: vi.fn() } as unknown as Window & { document: typeof doc };
  };

  it("opens inside the click with a holding page, then shows the poster and prints it", () => {
    vi.useFakeTimers();
    const w = fakeWindow();
    vi.spyOn(window, "open").mockReturnValue(w);
    expect(openPosterWindow()).toBe(w);
    expect((w.document.write as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain("Preparing your poster");
    showPoster(w, { headline: "Hi", formName: "Form", url: URL_ });
    expect((w.document.write as ReturnType<typeof vi.fn>).mock.calls[1][0]).toContain("<h1>Hi</h1>");
    vi.advanceTimersByTime(400);
    expect(w.print).toHaveBeenCalled();
  });

  it("says so when the browser blocks it", () => {
    vi.spyOn(window, "open").mockReturnValue(null);
    expect(openPosterWindow()).toBeNull();
    expect(printPoster({ headline: "Hi", formName: "Form", url: URL_ })).toBe(false);
  });
});
