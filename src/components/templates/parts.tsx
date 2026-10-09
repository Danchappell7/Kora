/* ============================================================
   KANBO — small pieces the template library's screens share:
   the template's tile (its emoji on a spectrum hue, like a project's),
   where it comes from ("Built-in", "Shared", "Yours"), and the toast
   hook that's a no-op outside a ToastProvider.
   ============================================================ */
import { ProjectTile, spectrumColor } from "../primitives";
import type { SpectrumKey } from "../primitives";
import { useToast } from "../Toast";
import type { LibraryTemplate } from "../../data/types";

/* the built-ins wear fixed hues, spread round the wheel; everyone else's comes from its id */
const BUILTIN_HUES: Record<string, SpectrumKey> = {
  "builtin-lib-client-onboarding": "lagoon",
  "builtin-lib-bug-report": "coral",
  "builtin-lib-weekly-report": "sky",
  "builtin-lib-hiring-loop": "jade",
  "builtin-lib-content-piece": "orchid",
  "builtin-lib-event-checklist": "tangerine",
  "builtin-lib-expense-claim": "amber",
  "builtin-lib-contract-review": "cobalt",
};

/** The template as something a ProjectTile can wear. */
export function templateLook(t: Pick<LibraryTemplate, "id" | "name" | "emoji">) {
  const hue = BUILTIN_HUES[t.id];
  return { id: "tpl:" + t.id, name: t.name, emoji: t.emoji ?? undefined, color: hue ? spectrumColor(hue) : "" };
}

export function TemplateTile({ template, size = 20 }: { template: Pick<LibraryTemplate, "id" | "name" | "emoji">; size?: 16 | 20 | 28 | 44 }) {
  return <ProjectTile project={templateLook(template)} size={size} />;
}

export type TemplateKind = "builtin" | "shared" | "yours";
export function templateKind(t: Pick<LibraryTemplate, "builtin" | "userId" | "shared">, userId: string): TemplateKind {
  if (t.builtin) return "builtin";
  if (t.userId === userId) return "yours";
  return "shared";
}
export const KIND_LABEL: Record<TemplateKind, string> = { builtin: "Built-in", shared: "Shared", yours: "Yours" };

// a component can render outside a ToastProvider (tests, embeds): toasts are then a no-op
export function useOptionalToast() {
  try { return useToast(); } catch { return null; }
}

/** a DOM-safe id from useId() */
export const safeId = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "");
