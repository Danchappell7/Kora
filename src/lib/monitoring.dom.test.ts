/* Element paths as Sentry really builds them (its own htmlTreeAsString, in a DOM),
   through Kanbo's scrubbers: no task titles or people's names survive. */
import { describe, it, expect } from "vitest";
import { htmlTreeAsString } from "@sentry/core";
import { shapeBreadcrumb, scrubDomPath, scrubSpan } from "./monitoring";

function taskPanel(): HTMLElement {
  document.body.innerHTML = `
    <div id="root">
      <div role="dialog" aria-label="Task: Sack Sana" class="ktd-panel">
        <div class="ktd-head">
          <span class="ktd-presence" title="Also viewing: Sana Ahmed, Tom Ruiz">2</span>
          <button type="button" class="kbtn" aria-label="Close" title="Close task">x</button>
          <button class="kmore">more</button>
        </div>
        <div class="ktd-body"><input class="kfield" name="title" type="text" value="Sack Sana"></div>
        <img class="kav" alt="Tom Ruiz" src="data:,">
      </div>
    </div>`;
  return document.body;
}

describe("Sentry's element paths in a real DOM", () => {
  it("a click in the task panel names the elements, not the task or the people", () => {
    taskPanel();
    const targets = [
      document.querySelector("button.kmore")!,
      document.querySelector("button.kbtn")!,
      document.querySelector(".ktd-presence")!,
      document.querySelector("input.kfield")!,
      document.querySelector("img.kav")!,
    ];
    for (const el of targets) {
      const raw = htmlTreeAsString(el);
      expect(raw).toMatch(/Sana|Tom|Sack|title|Close task/);          // what Sentry would have sent
      const crumb = shapeBreadcrumb({ category: "ui.click", message: raw });
      expect(crumb.message, raw).not.toMatch(/Sana|Tom|Sack|Close task/);
      expect(crumb.message).not.toBe("[element]");                    // still a useful path
    }
    // the dialog's label (the task's title) rides along on a click on any plain button inside it
    expect(htmlTreeAsString(targets[0])).toBe('div.ktd-panel[aria-label="Task: Sack Sana"] > div.ktd-head > button.kmore');
    expect(shapeBreadcrumb({ category: "ui.click", message: htmlTreeAsString(targets[0]) }).message)
      .toBe("div.ktd-panel[aria-label] > div.ktd-head > button.kmore");
    expect(shapeBreadcrumb({ category: "ui.click", message: htmlTreeAsString(targets[1]) }).message)
      .toBe('button.kbtn[aria-label][type="button"][title]');
  });

  it("an interaction (INP) span named after the element is scrubbed the same way", () => {
    taskPanel();
    const name = htmlTreeAsString(document.querySelector(".ktd-presence"));
    const span = scrubSpan({ op: "ui.interaction.click", origin: "auto.http.browser.inp", description: name, data: {} });
    expect(name).toContain("Sana Ahmed, Tom Ruiz");
    expect(span.description).toBe("div.ktd-head > span.ktd-presence[title]");
    expect(scrubDomPath(name)).toBe(span.description);
  });
});
