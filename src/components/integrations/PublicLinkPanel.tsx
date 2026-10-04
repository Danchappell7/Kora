/* ============================================================
   KANBO — a form's public link.                             [f9-public-forms]
   "Anyone with the link can submit" toggle, the link (copy), "Regenerate
   link" (confirm: the old link stops working), and a QR code (lib/qr,
   pure SVG; download as SVG). Read-only for people who can't edit the
   form (guests): they see the link only while it's on. Demo: toggles
   locally and links to /f/demo. Before 0043: explains it isn't switched
   on yet.
   Mount (integrator): in the Forms / Requests UI (RulesForms, project
   Requests tab), per form.
   CONTRACT STUB — f9 replaces the body, keeps the name and props.
   ============================================================ */
import type { FormDef } from "../../data/types";

export interface PublicLinkPanelProps {
  form: FormDef;
  /** may switch it / regenerate it (owner, admin, member; never guests) */
  canEdit: boolean;
  /** the project's name, for the QR download's file name and alt text */
  projectName?: string;
  /** the form's new public state, so the host updates its list */
  onChange?: (patch: { publicEnabled: boolean; publicToken: string | null }) => void;
}

export function PublicLinkPanel(props: PublicLinkPanelProps) {
  void props;
  return null;
}
