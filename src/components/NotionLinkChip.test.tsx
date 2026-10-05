/* Notion pages on a task (TaskDetail), in demo mode. */
import { beforeEach, describe, expect, it } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { NotionLinkChip } from "./NotionLinkChip";
import { NOTION_COPY, linkNotionPage, listTaskNotionLinks, resetNotionDemo } from "../lib/notion";

const WS = "ws-foundrise";
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

beforeEach(() => resetNotionDemo({ demoDelayMs: 0 }));

describe("NotionLinkChip", () => {
  it("nothing for a personal task, or a workspace without Notion and no links", async () => {
    const { container, rerender } = render(<NotionLinkChip taskId="t-1" workspaceId={null} canEdit />);
    await settle();
    expect(container).toBeEmptyDOMElement();
    rerender(<NotionLinkChip taskId="t-9" workspaceId="ws-reco" canEdit />);
    await settle();
    expect(container).toBeEmptyDOMElement();
  });

  it("shows linked pages as chips that open Notion; guests can't change them", async () => {
    render(<NotionLinkChip taskId="t-1" workspaceId={WS} canEdit={false} />);
    const section = await screen.findByRole("region", { name: /Notion/ });
    const links = within(section).getAllByRole("link");
    expect(links).toHaveLength(2);
    expect(links[0]).toHaveAccessibleName(/Q3 launch: narrative notes.*opens in a new tab/);
    expect(links[0]).toHaveAttribute("target", "_blank");
    expect(links[0]).toHaveAttribute("rel", "noopener noreferrer");
    expect(links[0].getAttribute("href")).toMatch(/^https:\/\/www\.notion\.so\//);
    expect(within(section).getByText(/synced · edited/)).toBeInTheDocument();
    expect(within(section).getByText("2")).toBeInTheDocument();
    expect(within(section).queryByRole("button")).toBeNull();
  });

  it("links a pasted page and unlinks it", async () => {
    render(<NotionLinkChip taskId="t-9" workspaceId={WS} canEdit />);
    fireEvent.click(await screen.findByRole("button", { name: "Link a page" }));
    const input = screen.getByRole("textbox", { name: "Notion page link" });
    await waitFor(() => expect(input).toHaveFocus());
    fireEvent.change(input, { target: { value: "https://example.com/not-notion" } });
    fireEvent.click(screen.getByRole("button", { name: "Link" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(NOTION_COPY.invalidLink);
    expect(input).toHaveAttribute("aria-invalid", "true");
    fireEvent.change(input, { target: { value: "https://www.notion.so/acme/Launch-brief-89abcdef0123456789abcdef01234567" } });
    fireEvent.click(screen.getByRole("button", { name: "Link" }));
    expect(await screen.findByRole("link", { name: /Launch brief/ })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Linked Launch brief.");
    expect(screen.queryByRole("textbox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Unlink Launch brief" }));
    await waitFor(() => expect(screen.queryByRole("link", { name: /Launch brief/ })).toBeNull());
    expect(screen.getByRole("status")).toHaveTextContent(/The page itself is untouched/);
    expect(await listTaskNotionLinks("t-9", WS)).toEqual([]);
  });

  it("Escape closes the form; links made elsewhere show up", async () => {
    render(<NotionLinkChip taskId="t-4" workspaceId={WS} canEdit />);
    fireEvent.click(await screen.findByRole("button", { name: "Link a page" }));
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Notion page link" }), { key: "Escape" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Link a page" })).toHaveFocus());
    await act(async () => { await linkNotionPage("t-4", "https://www.notion.so/Brand-voice-0123456789abcdef0123456789abcdef", WS); });
    expect(await screen.findByRole("link", { name: /Brand voice/ })).toBeInTheDocument();
  });
});
