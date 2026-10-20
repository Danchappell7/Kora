import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { SlackSourceChip } from "./SlackSourceChip";

describe("SlackSourceChip", () => {
  it("links to the Slack message in a new tab, named for screen readers", () => {
    const url = "https://acme.slack.com/archives/C024BE91L/p1700000000123456";
    render(<SlackSourceChip permalink={url} />);
    const a = screen.getByRole("link", { name: /From Slack: open the message in acme\.slack\.com/ });
    expect(a).toHaveAttribute("href", url);
    expect(a).toHaveAttribute("target", "_blank");
    expect(a.getAttribute("rel")).toContain("noopener");
    expect(a.getAttribute("rel")).toContain("noreferrer");
    expect(a).toHaveTextContent("From Slack");
  });
  it("renders nothing without a real Slack message link", () => {
    for (const bad of [null, undefined, "", "javascript:alert(1)", "https://evil.test/archives/C1/p1", "https://acme.slack.com.evil.test/archives/C1/p1"]) {
      const { container, unmount } = render(<SlackSourceChip permalink={bad} />);
      expect(container).toBeEmptyDOMElement();
      unmount();
    }
  });
});
