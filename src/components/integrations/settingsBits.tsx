/* ============================================================
   KANBO — Settings building blocks for the integration panels.
   The same markup as SettingsModal's own Group / Row (its kset-* styles
   apply when a panel is mounted inside Settings), so Slack, Calendar
   feed, Push and Install panels read as native Settings sections.
   Shared by f6–f8; owned by the architect — packages don't edit it.
   ============================================================ */
import { useId, type ReactNode } from "react";

/** A titled card of rows: <SetGroup title="Slack"> <SetRow …/> … </SetGroup>. */
export function SetGroup({ title, children, danger, action }: { title: string; children: ReactNode; danger?: boolean; action?: ReactNode }) {
  const id = "kset-g" + useId().replace(/[^a-zA-Z0-9_-]/g, "");
  return (
    <section className="kset-group" data-tone={danger ? "signal" : undefined} aria-labelledby={id}>
      <div className="kset-group-head">
        <h3 id={id} className="kset-group-title">{title}</h3>
        {action}
      </div>
      <div className="kset-card">{children}</div>
    </section>
  );
}

/** Label (and a line of help) on the left, the control on the right. `group`
 *  makes the row a labelled group (for segmented controls). */
export function SetRow({ label, desc, icon, group, children }: { label: ReactNode; desc?: ReactNode; icon?: ReactNode; group?: boolean; children?: ReactNode }) {
  const id = "kset-r" + useId().replace(/[^a-zA-Z0-9_-]/g, "");
  return (
    <div className="kset-row" role={group ? "group" : undefined} aria-labelledby={group ? `${id}-l` : undefined} aria-describedby={group && desc ? `${id}-d` : undefined}>
      {icon && <span className="kset-row-icon">{icon}</span>}
      <div className="kset-row-text">
        <span id={`${id}-l`} className="kset-row-label">{label}</span>
        {desc && <span id={`${id}-d`} className="kset-row-desc">{desc}</span>}
      </div>
      {children != null && children !== false && <div className="kset-row-ctl">{children}</div>}
    </div>
  );
}

/** The one-line intro under a section title (13/400 ink-3). */
export function SetIntro({ children }: { children: ReactNode }) {
  return <p className="kset-intro">{children}</p>;
}

/** A quiet note under a group (12/500 ink-3). */
export function SetNote({ children }: { children: ReactNode }) {
  return <p className="kset-note">{children}</p>;
}
