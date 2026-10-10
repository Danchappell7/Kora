/* KANBO — what a template library failure means, in words (lib/templates templateFailure). */
import type { TemplateFailure } from "../../data/types";

const TEXT: Record<TemplateFailure, string> = {
  not_allowed: "You can't change that template. Only its maker (or a workspace owner or admin, for a shared one) can.",
  too_many: "You've reached 300 templates. Delete some you don't use to make room.",
  invalid: "Something in this template is too long or the wrong shape. Shorten it and try again.",
  not_found: "That template has gone. Someone may have deleted it.",
  unavailable: "Templates can't be saved yet: the library isn't set up on this server.",
  network: "You're offline. Try again when you're connected.",
  error: "Something went wrong. Try again.",
};

export function failureText(f: TemplateFailure): string {
  return TEXT[f] ?? TEXT.error;
}
