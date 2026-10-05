/* The public request form page: every state, the keyboard and screen-reader
   paths, the theme, and the demo preview. The function is stubbed by
   mocking lib/publicForms' two network calls (the rest of the module is
   real: validation, the demo form, the theme). */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { PublicFormLoad, PublicFormSchema } from "../data/types";

const net = vi.hoisted(() => ({
  load: null as null | ((token: string) => Promise<unknown>),
  submit: null as null | ((token: string, s: unknown) => Promise<unknown>),
}));
vi.mock("../lib/publicForms", async (orig) => {
  const real = await orig<typeof import("../lib/publicForms")>();
  return {
    ...real,
    loadPublicForm: (token: string, opts?: object) => (net.load ? net.load(token) : real.loadPublicForm(token, opts)),
    submitPublicForm: (token: string, s: never, opts?: object) => (net.submit ? net.submit(token, s) : real.submitPublicForm(token, s, { demoDelayMs: 0, ...opts })),
  };
});

import { PublicFormPage } from "./PublicFormPage";
import { FIELD_MESSAGES } from "../lib/publicForms";

const TOKEN = "0123456789abcdef0123456789abcdef";
const FORM: PublicFormSchema = {
  name: "Design requests", intro: "Tell us what you need.\nWe reply within a day.",
  project: { name: "Website refresh", emoji: "🎨", color: "oklch(0.62 0.16 293)" },
  workspace: { name: "Foundrise", logoUrl: "https://abc.supabase.co/logo.png" },
  fields: ["description", "priority", "dueDate"],
};
const loads = (r: PublicFormLoad) => { net.load = vi.fn(async () => r); };

beforeEach(() => {
  net.load = null;
  net.submit = null;
  sessionStorage.clear();
  document.title = "Kanbo";
  document.documentElement.setAttribute("data-theme", "dark");
});
afterEach(() => { vi.restoreAllMocks(); });

const fill = (label: RegExp | string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const send = () => fireEvent.click(screen.getByRole("button", { name: /send request/i }));

describe("loading and the form", () => {
  it("shows a loading state, then the branded form", async () => {
    let resolve!: (r: PublicFormLoad) => void;
    net.load = vi.fn(() => new Promise((r) => { resolve = r as never; }));
    const { container } = render(<PublicFormPage token={TOKEN} />);
    expect(screen.getByRole("status")).toHaveTextContent(/loading the form/i);
    expect(container.querySelector("main")).toHaveAttribute("aria-busy", "true");
    await act(async () => { resolve({ ok: true, form: FORM }); });
    expect(screen.getByRole("heading", { level: 1, name: "Design requests" })).toBeInTheDocument();
    expect(screen.getByText(/We reply within a day/)).toBeInTheDocument();
    expect(screen.getByText("Foundrise")).toBeInTheDocument();
    expect(screen.getByText("Website refresh")).toBeInTheDocument();
    expect(container.querySelector(".kpcover-wrap")).toBeInTheDocument();
    expect(container.querySelector(".kptile")).toHaveTextContent("🎨");
    expect(document.title).toBe("Design requests · Foundrise");
    expect(document.head.querySelector('meta[name="robots"]')).toHaveAttribute("content", "noindex, nofollow");
  });
  it("asks only for the fields the form asks for (title, name and email always)", async () => {
    loads({ ok: true, form: { ...FORM, fields: [] } });
    render(<PublicFormPage token={TOKEN} />);
    await screen.findByRole("heading", { name: "Design requests" });
    expect(screen.getByLabelText("What do you need?")).toHaveAttribute("aria-required", "true");
    expect(screen.getByLabelText("Your name")).toHaveAttribute("autocomplete", "name");
    expect(screen.getByLabelText("Your email")).toHaveAttribute("type", "email");
    expect(screen.queryByLabelText(/details/i)).toBeNull();
    expect(screen.queryByRole("radio")).toBeNull();
    expect(screen.queryByLabelText(/needed by/i)).toBeNull();
  });
  it("priority is four labelled radios, medium to start with; the date can't be in the past", async () => {
    loads({ ok: true, form: FORM });
    render(<PublicFormPage token={TOKEN} />);
    const group = await screen.findByRole("group", { name: "How urgent is it?" });
    const radios = within(group).getAllByRole("radio");
    expect(radios.map((r) => (r.closest("label") as HTMLElement).textContent)).toEqual(["Low", "Medium", "High", "Urgent"]);
    expect(within(group).getByRole("radio", { name: "Medium" })).toBeChecked();
    expect(screen.getByLabelText(/needed by/i)).toHaveAttribute("min", expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/));
  });
  it("the honeypot is out of reach for people and assistive tech", async () => {
    loads({ ok: true, form: FORM });
    const { container } = render(<PublicFormPage token={TOKEN} />);
    await screen.findByRole("heading", { name: "Design requests" });
    const hp = container.querySelector('input[name="website"]') as HTMLInputElement;
    expect(hp).toHaveAttribute("tabindex", "-1");
    expect(hp.closest('[aria-hidden="true"]')).not.toBeNull();
    expect(hp.closest(".kpub-hp")).not.toBeNull();
  });
});

describe("sending", () => {
  it("checks before sending: errors tied to their fields, focus on the first, a count announced", async () => {
    loads({ ok: true, form: FORM });
    net.submit = vi.fn();
    render(<PublicFormPage token={TOKEN} />);
    await screen.findByRole("heading", { name: "Design requests" });
    fill("Your email", "nope");
    send();
    const title = screen.getByLabelText("What do you need?");
    expect(title).toHaveAttribute("aria-invalid", "true");
    const describedBy = title.getAttribute("aria-describedby")!.split(" ");
    expect(describedBy.map((id) => document.getElementById(id)?.textContent)).toContain(FIELD_MESSAGES.titleMissing);
    expect(screen.getByLabelText("Your email")).toHaveAttribute("aria-invalid", "true");
    await waitFor(() => expect(title).toHaveFocus());
    expect(screen.getByText("3 answers need another look.")).toBeInTheDocument();
    expect(net.submit).not.toHaveBeenCalled();
    // fixing a field clears its error straight away
    fill("What do you need?", "Banner");
    expect(title).not.toHaveAttribute("aria-invalid");
  });
  it("sends the request and thanks them with a reference, focus on the heading", async () => {
    loads({ ok: true, form: FORM });
    net.submit = vi.fn(async () => ({ ok: true, reference: "KB-7F3A9C" }));
    render(<PublicFormPage token={TOKEN} />);
    await screen.findByRole("heading", { name: "Design requests" });
    fill("What do you need?", "Autumn banner");
    fill(/details/i, "1200 × 600, by Friday");
    fireEvent.click(screen.getByRole("radio", { name: "High" }));
    fill("Your name", "Sam Jones");
    fill("Your email", "sam@example.com");
    send();
    const done = await screen.findByRole("heading", { name: "Request sent" });
    await waitFor(() => expect(done).toHaveFocus());
    expect(net.submit).toHaveBeenCalledWith(TOKEN, { title: "Autumn banner", description: "1200 × 600, by Friday", priority: "high", name: "Sam Jones", email: "sam@example.com" });
    expect(screen.getByText("KB-7F3A9C")).toBeInTheDocument();
    expect(screen.getByText(/Thanks, Sam\. It's with the Foundrise team now, filed under Website refresh\./)).toBeInTheDocument();
    // another one keeps who they are
    fireEvent.click(screen.getByRole("button", { name: /send another request/i }));
    expect(screen.getByLabelText("What do you need?")).toHaveValue("");
    expect(screen.getByLabelText("Your name")).toHaveValue("Sam Jones");
    expect(screen.getByLabelText("Your email")).toHaveValue("sam@example.com");
  });
  it("copies the reference", async () => {
    loads({ ok: true, form: FORM });
    net.submit = vi.fn(async () => ({ ok: true, reference: "KB-7F3A9C" }));
    const writeText = vi.fn(async () => {});
    Object.assign(navigator, { clipboard: { writeText } });
    render(<PublicFormPage token={TOKEN} />);
    await screen.findByRole("heading", { name: "Design requests" });
    fill("What do you need?", "Banner"); fill("Your name", "Sam"); fill("Your email", "sam@example.com");
    send();
    await screen.findByRole("heading", { name: "Request sent" });
    fireEvent.click(screen.getByRole("button", { name: "Copy reference KB-7F3A9C" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("KB-7F3A9C"));
    expect(await screen.findByText("Copied")).toBeInTheDocument();
  });
  it("shows the server's field messages", async () => {
    loads({ ok: true, form: FORM });
    net.submit = vi.fn(async () => ({ ok: false, reason: "invalid", message: "Bad", field: "email", fields: { email: FIELD_MESSAGES.emailInvalid } }));
    render(<PublicFormPage token={TOKEN} />);
    await screen.findByRole("heading", { name: "Design requests" });
    fill("What do you need?", "Banner"); fill("Your name", "Sam"); fill("Your email", "sam@example.com");
    send();
    await waitFor(() => expect(screen.getByLabelText("Your email")).toHaveAttribute("aria-invalid", "true"));
    expect(screen.getByText(FIELD_MESSAGES.emailInvalid)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText("Your email")).toHaveFocus());
  });
  it("too many requests or no connection: says so, keeps every answer", async () => {
    loads({ ok: true, form: FORM });
    net.submit = vi.fn(async () => ({ ok: false, reason: "rate_limited", message: "x", retryAfter: 240 }));
    render(<PublicFormPage token={TOKEN} />);
    await screen.findByRole("heading", { name: "Design requests" });
    fill("What do you need?", "Banner"); fill("Your name", "Sam"); fill("Your email", "sam@example.com");
    send();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/a lot of requests from here\. Wait about 4 minutes/);
    expect(alert).toHaveTextContent(/Your answers are still here/);
    await waitFor(() => expect(alert).toHaveFocus());
    expect(screen.getByLabelText("What do you need?")).toHaveValue("Banner");
    net.submit = vi.fn(async () => ({ ok: false, reason: "network", message: "x" }));
    send();
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/couldn't be reached/));
  });
  it("the form's hourly allowance is used up: says the form is busy, not their network", async () => {
    loads({ ok: true, form: FORM });
    net.submit = vi.fn(async () => ({ ok: false, reason: "rate_limited", message: "x", retryAfter: 1800, scope: "form" }));
    render(<PublicFormPage token={TOKEN} />);
    await screen.findByRole("heading", { name: "Design requests" });
    fill("What do you need?", "Banner"); fill("Your name", "Sam"); fill("Your email", "sam@example.com");
    send();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/This form has had a lot of requests in the last hour\. Wait about 30 minutes/);
    expect(alert).not.toHaveTextContent(/from here/);
  });
  it("switched off while they were filling it in: the form gives way to the explanation", async () => {
    loads({ ok: true, form: FORM });
    net.submit = vi.fn(async () => ({ ok: false, reason: "disabled", message: "x" }));
    render(<PublicFormPage token={TOKEN} />);
    await screen.findByRole("heading", { name: "Design requests" });
    fill("What do you need?", "Banner"); fill("Your name", "Sam"); fill("Your email", "sam@example.com");
    send();
    const h = await screen.findByRole("heading", { name: "This form isn't taking requests" });
    await waitFor(() => expect(h).toHaveFocus());
  });
  it("keeps a draft for this tab and brings it back", async () => {
    loads({ ok: true, form: FORM });
    const first = render(<PublicFormPage token={TOKEN} />);
    await screen.findByRole("heading", { name: "Design requests" });
    fill("What do you need?", "Half-typed");
    fill("Your name", "Sam");
    await waitFor(() => expect(sessionStorage.getItem(`kanbo-public-form:${TOKEN}`)).toContain("Half-typed"));
    first.unmount();
    render(<PublicFormPage token={TOKEN} />);
    await screen.findByRole("heading", { name: "Design requests" });
    expect(screen.getByLabelText("What do you need?")).toHaveValue("Half-typed");
    expect(screen.getByLabelText("Your name")).toHaveValue("Sam");
  });
});

describe("states without a form", () => {
  it.each([
    ["not_found", "We couldn't find this form", false],
    ["disabled", "This form isn't taking requests", false],
    ["unavailable", "This form isn't available right now", true],
    ["network", "Kanbo couldn't be reached", true],
  ] as const)("%s", async (reason, title, retry) => {
    loads({ ok: false, reason, message: "x" });
    render(<PublicFormPage token={TOKEN} />);
    expect(await screen.findByRole("heading", { level: 1, name: title })).toBeInTheDocument();
    expect(!!screen.queryByRole("button", { name: /try again/i })).toBe(retry);
    expect(document.title).toBe(`${title} · Kanbo`);
  });
  it("rate limited: says how long, and tries again on request", async () => {
    loads({ ok: false, reason: "rate_limited", message: "x", retryAfter: 90 });
    render(<PublicFormPage token={TOKEN} />);
    expect(await screen.findByText("Wait about 2 minutes, then try again.")).toBeInTheDocument();
    loads({ ok: true, form: FORM });
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(await screen.findByRole("heading", { name: "Design requests" })).toBeInTheDocument();
  });
  it("offline: tries again by itself when the connection comes back", async () => {
    loads({ ok: false, reason: "network", message: "x" });
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    render(<PublicFormPage token={TOKEN} />);
    expect(await screen.findByRole("heading", { name: "You're offline" })).toBeInTheDocument();
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
    loads({ ok: true, form: FORM });
    await act(async () => { window.dispatchEvent(new Event("online")); });
    expect(await screen.findByRole("heading", { name: "Design requests" })).toBeInTheDocument();
  });
});

describe("theme and the demo", () => {
  it("Paper by default, Navy when the system is dark (never the app's saved theme)", async () => {
    loads({ ok: true, form: FORM });
    const { unmount } = render(<PublicFormPage token={TOKEN} />);
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    await screen.findByRole("heading", { name: "Design requests" });
    unmount();
    vi.spyOn(window, "matchMedia").mockImplementation((q: string) => ({
      matches: q.includes("dark"), media: q, onchange: null, addEventListener: vi.fn(), removeEventListener: vi.fn(),
      addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
    }) as unknown as MediaQueryList);
    render(<PublicFormPage token={TOKEN} />);
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    await screen.findByRole("heading", { name: "Design requests" });
  });
  it("/f/demo previews the demo form and fakes the send, saying nothing is saved", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    render(<PublicFormPage token="demo" />);
    expect(await screen.findByRole("heading", { name: "Launch requests" })).toBeInTheDocument();
    expect(screen.getByText(/Nothing you send here is saved/)).toBeInTheDocument();
    fill("What do you need?", "Launch tweet"); fill("Your name", "Sam"); fill("Your email", "sam@example.com");
    send();
    expect(await screen.findByRole("heading", { name: "Request sent" })).toBeInTheDocument();
    expect(screen.getByText(/This was a preview, so nothing was sent anywhere/)).toBeInTheDocument();
    expect(screen.getByText(/^KB-[0-9A-F]{6}$/)).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
