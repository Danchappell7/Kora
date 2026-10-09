/* Settings › Workspace › History in demo mode (lib/audit's fakes), plus the
   paging and failure states with the page query mocked. */
import { StrictMode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const { downloadCsv } = vi.hoisted(() => ({ downloadCsv: vi.fn() }));
vi.mock("../../lib/exportTasks", async (orig) => ({ ...(await orig<typeof import("../../lib/exportTasks")>()), downloadCsv }));

import { HistoryLog, actionMark, actionsFor, addDays, rangeDays } from "./HistoryLog";
import { MEMBERS } from "../../data/data";
import { AUDIT_ACTOR_KANBO, resetAuditDemo } from "../../lib/audit";
import * as audit from "../../lib/audit";

const section = () => screen.getByRole("region", { name: "History" });
const entries = () => within(section()).queryAllByRole("listitem");
const renderLog = (canSeeAll = true) => render(
  <StrictMode><HistoryLog workspaceId="ws-foundrise" workspaceName="Foundrise" members={MEMBERS} currentUserId="m-self" canSeeAll={canSeeAll} /></StrictMode>,
);

beforeEach(() => { resetAuditDemo({ demoDelayMs: 0 }); downloadCsv.mockReset(); vi.restoreAllMocks(); });

describe("helpers", () => {
  it("date ranges are UK days, inclusive; a backwards custom range is turned round", () => {
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(rangeDays("7", "2026-10-09", { from: "", to: "" })).toEqual({ from: "2026-10-03", to: "2026-10-09" });
    expect(rangeDays("today", "2026-10-09", { from: "", to: "" })).toEqual({ from: "2026-10-09", to: "2026-10-09" });
    expect(rangeDays("custom", "2026-10-09", { from: "2026-10-05", to: "2026-10-01" })).toEqual({ from: "2026-10-01", to: "2026-10-05" });
    expect(rangeDays("custom", "2026-10-09", { from: "2026-10-05", to: "" })).toEqual({ from: "2026-10-05", to: null });
    expect(rangeDays("any", "2026-10-09", { from: "x", to: "y" })).toEqual({ from: null, to: null });
  });
  it("action filter values", () => {
    expect(actionsFor("")).toBeNull();
    expect(actionsFor("role.changed")).toEqual(["role.changed"]);
    expect(actionsFor("group:People")).toEqual(["member.invited", "member.joined", "member.removed", "role.changed"]);
    expect(actionsFor("drop.table")).toBeNull();
    expect(actionMark("task.purged")).toEqual({ icon: "trash", tone: "signal" });
    expect(actionMark("project.restored")).toEqual({ icon: "undo", tone: "ok" });
  });
});

describe("HistoryLog", () => {
  it("an owner sees everyone's history by UK day, with your own actions as “You”", async () => {
    renderLog(true);
    expect(within(section()).getByText("Loading the history")).toBeInTheDocument();
    expect(await within(section()).findByText(/deleted the task “Draft press release” and 2 sub-tasks/)).toBeInTheDocument();
    expect(within(section()).getByRole("heading", { name: "Today" })).toBeInTheDocument();
    expect(within(section()).getByRole("heading", { name: "Yesterday" })).toBeInTheDocument();
    expect(entries().length).toBeGreaterThanOrEqual(20);
    const mine = entries().find((li) => /restored the task “Competitor teardown”/.test(li.textContent ?? ""))!;
    expect(within(mine).getByText("You")).toBeInTheDocument();
    expect(within(section()).getAllByText("Kanbo", { selector: "strong" }).length).toBeGreaterThan(0);
    expect(screen.queryByText(/You're seeing your own actions/)).toBeNull();
    const who = screen.getByLabelText("Person") as HTMLSelectElement;
    const options = within(who).getAllByRole("option").map((o) => o.textContent);
    expect(options[0]).toBe("Everyone");
    expect(options[1]).toBe("You (Daniel Okai)");
    expect(options[options.length - 1]).toBe("Kanbo (automatic)");
    expect(within(section()).getByText(/That's everything\. History is kept for a year\./)).toBeInTheDocument();
  });

  it("filters by person, action and date, and clears", async () => {
    renderLog(true);
    await within(section()).findByText(/Draft press release/);
    const all = entries().length;
    fireEvent.change(screen.getByLabelText("Action"), { target: { value: "group:People" } });
    await waitFor(() => expect(entries().length).toBeLessThan(all));
    for (const li of entries()) expect(li.textContent).toMatch(/invited|joined|left|removed|role|added/);
    fireEvent.change(screen.getByLabelText("Person"), { target: { value: AUDIT_ACTOR_KANBO } });
    expect(await within(section()).findByText("Nothing matches these filters")).toBeInTheDocument();
    fireEvent.click(within(section()).getAllByRole("button", { name: "Clear filters" })[0]);
    await waitFor(() => expect(entries().length).toBe(all));
    fireEvent.change(screen.getByLabelText("When"), { target: { value: "today" } });
    await waitFor(() => expect(within(section()).queryByRole("heading", { name: "Yesterday" })).toBeNull());
    expect(within(section()).getByRole("heading", { name: "Today" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("When"), { target: { value: "custom" } });
    expect(screen.getByLabelText("From")).toBeInTheDocument();
    expect(screen.getByLabelText("To")).toBeInTheDocument();
  });

  it("someone who isn't an owner or admin sees only their own actions, and is told so", async () => {
    const spy = vi.spyOn(audit, "listAuditEvents");
    renderLog(false);
    expect(screen.getByText("You're seeing your own actions. Owners and admins see everyone's.")).toBeInTheDocument();
    await within(section()).findByText(/restored the task “Competitor teardown”/);
    expect(screen.queryByLabelText("Person")).toBeNull();
    for (const li of entries()) expect(within(li).getByText("You")).toBeInTheDocument();
    expect(spy).toHaveBeenCalled();
    expect(spy.mock.calls.every(([q]) => q.actorId === "m-self")).toBe(true);
  });

  it("Export CSV downloads everything that matches", async () => {
    renderLog(true);
    await within(section()).findByText(/Draft press release/);
    fireEvent.click(within(section()).getByRole("button", { name: "Export CSV" }));
    await waitFor(() => expect(downloadCsv).toHaveBeenCalledTimes(1));
    const [name, csv] = downloadCsv.mock.calls[0] as [string, string];
    expect(name).toMatch(/^kanbo-history-foundrise-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(csv.startsWith('﻿"Time (UTC)","Time (UK)","Who","Action","What","Summary","Details"')).toBe(true);
    expect(csv.split("\r\n").length).toBe(entries().length + 2);
    expect(within(section()).getByText(/^Exported \d+ entries\.$/)).toBeInTheDocument();
  });
});

describe("HistoryLog paging and failures (query mocked)", () => {
  const ev = (i: number) => ({
    id: `e${String(i).padStart(3, "0")}`, workspaceId: "ws-foundrise", actorId: "m-1", actorName: "Maya Lin", action: "task.deleted",
    targetKind: "task", targetId: `t${i}`, targetTitle: `Task ${i}`, detail: {}, createdAt: new Date(Date.now() - i * 60_000).toISOString(),
  });
  it("Show older loads the next page with the cursor", async () => {
    const [one, two, three] = [ev(1), ev(2), ev(3)];
    const spy = vi.spyOn(audit, "listAuditEvents").mockImplementation(async (q) => (q.before
      ? { events: [three], next: null }
      : { events: [one, two], next: { createdAt: two.createdAt, id: two.id } }));
    renderLog(true);
    await within(section()).findByText(/Task 2/);
    fireEvent.click(within(section()).getByRole("button", { name: "Show older" }));
    expect(await within(section()).findByText(/Task 3/)).toBeInTheDocument();
    expect(spy).toHaveBeenLastCalledWith(expect.objectContaining({ before: { createdAt: two.createdAt, id: two.id } }));
    expect(within(section()).getByText(/That's everything/)).toBeInTheDocument();
  });
  it("an older page that fails can be tried again", async () => {
    let fail = true;
    vi.spyOn(audit, "listAuditEvents").mockImplementation(async (q) => {
      if (!q.before) return { events: [ev(1)], next: { createdAt: ev(1).createdAt, id: ev(1).id } };
      if (fail) { fail = false; throw new TypeError("Failed to fetch"); }
      return { events: [ev(2)], next: null };
    });
    renderLog(true);
    await within(section()).findByText(/Task 1/);
    fireEvent.click(within(section()).getByRole("button", { name: "Show older" }));
    expect(await within(section()).findByText("Couldn't load older entries.")).toBeInTheDocument();
    fireEvent.click(within(section()).getByRole("button", { name: "Try again" }));
    expect(await within(section()).findByText(/Task 2/)).toBeInTheDocument();
  });
  it("before 0047: not switched on yet; a failed load: try again", async () => {
    const spy = vi.spyOn(audit, "listAuditEvents").mockRejectedValue(Object.assign(new Error("Could not find the table 'public.audit_events'"), { code: "PGRST205" }));
    const { unmount } = renderLog(true);
    expect(await within(section()).findByText("History isn't switched on yet")).toBeInTheDocument();
    expect(within(section()).getByRole("button", { name: "Export CSV" })).toBeDisabled();
    unmount();
    spy.mockReset();
    spy.mockRejectedValue(new TypeError("Failed to fetch"));
    renderLog(true);
    expect(await within(section()).findByText("Couldn't load the history")).toBeInTheDocument();
    spy.mockResolvedValue({ events: [ev(1)], next: null });
    fireEvent.click(within(section()).getByRole("button", { name: "Try again" }));
    expect(await within(section()).findByText(/Task 1/)).toBeInTheDocument();
  });
});
