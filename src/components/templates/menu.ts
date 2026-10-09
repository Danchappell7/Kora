/* ============================================================
   KANBO — the New task split menu's template entry.            [u9]
   Tiny on purpose: the page header (shell) can import THIS file for
   the item's words and icon without pulling the library in. The
   library itself (TemplateLibrary) is lazy-loaded by the host.
   ============================================================ */
import type { IconName } from "../../data/types";

/** "From a template…" in New task ▾ (opens the template library) */
export const FROM_TEMPLATE_MENU: { icon: IconName; label: string } = { icon: "layers", label: "From a template…" };
