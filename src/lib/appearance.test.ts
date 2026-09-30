import { describe, it, expect, beforeEach } from "vitest";
import { loadAppearance, saveAppearance, applyAppearance, DEFAULT_APPEARANCE } from "./appearance";

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-density");
});

describe("appearance: density, suggestions and AI", () => {
  it("defaults to comfortable rows with suggestions and AI on (older saves included)", () => {
    localStorage.setItem("kanbo-accent", "teal"); // a save from before these fields existed
    expect(loadAppearance()).toEqual({ accent: "teal", textSize: "normal", ambient: false, density: "comfortable", suggestions: true, ai: true });
    expect(DEFAULT_APPEARANCE).toMatchObject({ density: "comfortable", suggestions: true, ai: true });
  });

  it("round-trips through storage and ignores junk", () => {
    saveAppearance({ accent: "violet", textSize: "large", ambient: false, density: "compact", suggestions: false, ai: false });
    expect(loadAppearance()).toMatchObject({ textSize: "large", density: "compact", suggestions: false, ai: false });
    localStorage.setItem("kanbo-density", "cosy");
    expect(loadAppearance().density).toBe("comfortable");
  });

  it("sets <html data-density>, comfortable when unset", () => {
    applyAppearance({ accent: "violet", textSize: "normal", ambient: false, density: "compact" });
    expect(document.documentElement).toHaveAttribute("data-density", "compact");
    applyAppearance({ accent: "violet", textSize: "normal", ambient: false });
    expect(document.documentElement).toHaveAttribute("data-density", "comfortable");
  });
});
