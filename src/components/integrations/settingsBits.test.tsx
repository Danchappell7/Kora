/* settingsBits: the integration panels' Settings rows (architect-owned). */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { SetGroup, SetRow, SetIntro, SetNote } from "./settingsBits";
import * as integrations from ".";

describe("SetGroup / SetRow", () => {
  it("renders a labelled section with SettingsModal's markup", () => {
    render(
      <SetGroup title="Slack">
        <SetRow label="Channel" desc="Where Kanbo posts."><button type="button">Connect</button></SetRow>
      </SetGroup>,
    );
    const region = screen.getByRole("region", { name: "Slack" });
    expect(region.className).toBe("kset-group");
    expect(region.querySelector(".kset-card .kset-row .kset-row-ctl button")?.textContent).toBe("Connect");
    expect(screen.getByText("Where Kanbo posts.").className).toBe("kset-row-desc");
  });
  it("a group row is labelled and described by its text", () => {
    render(<SetRow group label="Auto-post" desc="Every weekday."><span>x</span></SetRow>);
    const g = screen.getByRole("group", { name: "Auto-post" });
    expect(g.getAttribute("aria-describedby")).toBeTruthy();
  });
  it("intro and note use the Settings text styles", () => {
    render(<><SetIntro>Intro</SetIntro><SetNote>Note</SetNote></>);
    expect(screen.getByText("Intro").className).toBe("kset-intro");
    expect(screen.getByText("Note").className).toBe("kset-note");
  });
});

describe("integration components", () => {
  it("export their final names for the integrator", () => {
    for (const k of ["SlackSettingsPanel", "SlackPostButton", "CalendarFeedPanel", "InstallPrompt", "PushSettingsPanel", "PublicLinkPanel"]) {
      expect(typeof (integrations as Record<string, unknown>)[k]).toBe("function");
    }
  });
});
