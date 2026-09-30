/* Full-screen height for standalone pages (landing, legal, sign-in).
   `body` is overflow:hidden because the app shell scrolls inside its own
   panes, so these pages must be their own scroll container. 100dvh follows
   mobile browser toolbars, so the end of a page is never stuck behind
   Safari's bottom bar; 100vh is the fallback for older engines. */
export const FULL_HEIGHT: string =
  typeof CSS !== "undefined" && typeof CSS.supports === "function" && CSS.supports("height", "100dvh") ? "100dvh" : "100vh";
