/* Meetings (0056), wired through the whole app in demo mode: Team › Pulse's Run meeting opens the start sheet,
   Start opens the room over the page (Previous / Next and the keys), End and send recap turns it into the recap,
   and Pulse then has no live meeting; the Inbox's recap from last week opens that meeting's recap; the Group page
   offers a meeting on each business. (A guest never has Pulse, and its Run meeting is the team's only: TeamPulse's
   own test.) */
import { describe, it, expect, afterEach, beforeAll, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import App from "./App";
import { loadAllChunks } from "./lib/lazyLoad";
import { AuthProvider } from "./auth/AuthProvider";
import { ToastProvider } from "./components/Toast";
import { resetMeetings } from "./lib/meetings/sync";
import { resetMeetingBus } from "./components/meetings/meetingBus";

beforeAll(loadAllChunks, 60_000);

const renderApp = () => render(<ToastProvider><AuthProvider><App /></AuthProvider></ToastProvider>);
const boot = async () => { renderApp(); await waitFor(() => expect(screen.getByRole("navigation", { name: "Main" })).toBeInTheDocument()); };
const at = (url: string) => window.history.replaceState(null, "", url);

beforeEach(() => { resetMeetings(); resetMeetingBus(); localStorage.setItem("kanbo-onboarded", "1"); localStorage.setItem("kanbo-tour-done", "1"); });
afterEach(() => { localStorage.clear(); sessionStorage.clear(); window.history.replaceState(null, "", "/"); resetMeetings(); resetMeetingBus(); });

describe("App · Run meeting (0056)", () => {
  it("from Pulse: the start sheet, the room, and the recap once it's ended", async () => {
    at("/team");
    await boot();
    fireEvent.click(await screen.findByRole("button", { name: "Run meeting" }));
    const sheet = await screen.findByRole("dialog", { name: "Run a meeting" });
    await waitFor(() => expect(within(sheet).getByText(/^5 from /)).toBeInTheDocument());
    fireEvent.click(within(sheet).getByRole("button", { name: "Start meeting" }));
    const room = await screen.findByRole("dialog", { name: /^Foundrise team meeting, / });
    expect(within(room).getByText("Kanbo's read")).toBeInTheDocument();
    const agenda = within(room).getByRole("navigation", { name: "Agenda" });
    expect(within(agenda).getByRole("button", { name: /Last meeting's actions/ })).toBeInTheDocument();
    fireEvent.click(within(room).getByRole("button", { name: "Next" }));
    expect(within(agenda).getAllByRole("button").find((b) => b.getAttribute("aria-current") === "step")).toHaveTextContent(/Rao|Lin|Vance|Okai/);
    fireEvent.click(within(room).getByRole("button", { name: "End meeting" }));
    fireEvent.click(await within(room).findByRole("button", { name: "End and send recap" }));
    expect(await within(room).findByText("Recap", { selector: ".kmtg-eyebrow" })).toBeInTheDocument();
    fireEvent.click(within(room).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /^Foundrise team meeting, / })).toBeNull());
    expect(await screen.findByRole("button", { name: "Run meeting" })).toBeInTheDocument();
  });

  it("last week's recap waits in the Inbox, and opens that meeting's recap", async () => {
    at("/inbox");
    await boot();
    fireEvent.click(await screen.findByRole("button", { name: /Maya Lin shared the recap of Foundrise team meeting/ }));
    const room = await screen.findByRole("dialog", { name: /^Foundrise team meeting, / });
    expect(await within(room).findByText(/run by Maya Lin/)).toBeInTheDocument();
    expect(within(room).getByText("Chase legal on the pricing page copy")).toBeInTheDocument();
  });

  it("the Group page offers a meeting on each business, and one over them all", async () => {
    at("/projects/group");
    await boot();
    expect(await screen.findByRole("button", { name: "Run group meeting" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Run meeting" }).length).toBeGreaterThanOrEqual(2);
  });
});
