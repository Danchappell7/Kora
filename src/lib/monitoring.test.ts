import { describe, it, expect } from "vitest";
import { scrubCapabilityUrls, scrubEvent } from "./monitoring";

describe("scrubCapabilityUrls", () => {
  it("replaces a public form's token in its address", () => {
    expect(scrubCapabilityUrls("https://www.kanbo.co.uk/f/Ab3_x-9QwErTyUiOpAsDfGhJ")).toBe("https://www.kanbo.co.uk/f/:token");
    expect(scrubCapabilityUrls("/f/Ab3_x-9QwErTyUiOpAsDfGhJ?utm=1")).toBe("/f/:token?utm=1");
  });

  it("replaces ?t= tokens on form and calendar-feed requests, keeping the other parameters", () => {
    expect(scrubCapabilityUrls("https://x.supabase.co/functions/v1/public-form?t=Ab3_x-9QwErTyUiOp"))
      .toBe("https://x.supabase.co/functions/v1/public-form?t=:token");
    expect(scrubCapabilityUrls("https://x.supabase.co/functions/v1/ics-feed?ping=1&t=deadbeef#x"))
      .toBe("https://x.supabase.co/functions/v1/ics-feed?ping=1&t=:token#x");
  });

  it("works inside a serialised event and leaves everything else alone", () => {
    const event = JSON.stringify({ request: { url: "https://www.kanbo.co.uk/f/SECRET_token_123" }, transaction: "/today", breadcrumbs: [{ data: { url: "/functions/v1/public-form?t=SECRET" } }] });
    const clean = scrubCapabilityUrls(event);
    expect(clean).not.toContain("SECRET");
    expect(JSON.parse(clean)).toEqual({ request: { url: "https://www.kanbo.co.uk/f/:token" }, transaction: "/today", breadcrumbs: [{ data: { url: "/functions/v1/public-form?t=:token" } }] });
    expect(scrubCapabilityUrls("/functions/v1/notify?task=1")).toBe("/functions/v1/notify?task=1");
  });

  it("scrubs an event in place, leaving Sentry's own objects (and cycles) alone", () => {
    class Scope { url = "/f/SECRET_token_123"; }
    const scope = new Scope();
    const crumb: Record<string, unknown> = { category: "fetch", data: { url: "https://x.supabase.co/functions/v1/public-form?t=SECRET" } };
    crumb.self = crumb;
    const event = {
      request: { url: "https://www.kanbo.co.uk/f/SECRET_token_123" },
      transaction: "/f/SECRET_token_123",
      breadcrumbs: [crumb],
      spans: [{ description: "GET https://x.supabase.co/functions/v1/ics-feed?t=SECRET" }],
      sdkProcessingMetadata: { capturedSpanScope: scope, dynamicSamplingContext: { transaction: "/f/SECRET_token_123" } },
    };
    expect(scrubEvent(event)).toBe(event);
    expect(event.request.url).toBe("https://www.kanbo.co.uk/f/:token");
    expect(event.transaction).toBe("/f/:token");
    expect((crumb.data as { url: string }).url).toBe("https://x.supabase.co/functions/v1/public-form?t=:token");
    expect(event.spans[0].description).toBe("GET https://x.supabase.co/functions/v1/ics-feed?t=:token");
    expect(event.sdkProcessingMetadata.dynamicSamplingContext.transaction).toBe("/f/:token");
    expect(event.sdkProcessingMetadata.capturedSpanScope).toBe(scope);   // untouched
  });
});
