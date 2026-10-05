/* ============================================================
   KANBO — Rules (what happens automatically when a task is added
   or changes) and Requests (forms that file tasks into a project).
   Both live under Projects, and inside each project pre-filtered
   to it (`projectId`).
   ============================================================ */
import { useEffect, useState } from "react";
import { Button, DateChip, EmptyState, Icon, IconButton, ProjectDot, projectPaint } from "../primitives";
import { getProject, getMember, TAGS, PRIORITY_META } from "../../data/data";
import type { Project, Section, AutomationRule, AutomationAction, AutomationActionType, FormDef, FormFieldKey, TagDef, Priority } from "../../data/types";
import { resolveTagId, useStableOrder } from "./reportingUtils";
import { DraftInput } from "../project/DraftInput";
import { PublicLinkPanel } from "../integrations";
import "../project/projects.css";

const PRIORITIES: Priority[] = ["low", "medium", "high", "urgent"];

/** The project a new rule or form lands in: the one you're in, else the one you
 *  picked, else this workspace's first (a remembered pick from another
 *  workspace falls back, so nothing is saved outside the team you're viewing). */
function useTargetProject(realProjects: Project[], projectId?: string) {
  const fixed = projectId && realProjects.some((p) => p.id === projectId) ? projectId : undefined;
  const [pidSel, setPid] = useState(fixed ?? realProjects[0]?.id ?? "");
  const pid = fixed ?? (realProjects.some((p) => p.id === pidSel) ? pidSel : (realProjects[0]?.id ?? ""));
  useEffect(() => { if (pid !== pidSel) setPid(pid); }, [pid, pidSel]);
  return { pid, setPid, fixed: !!fixed };
}

/* ---------------- RULES ---------------- */
const ACTION_LABEL: Record<AutomationActionType, string> = {
  set_priority: "Set priority to",
  set_assignee: "Assign to",
  set_section: "Move to section",
  add_tag: "Add tag",
};
const TRIGGER_LABEL: Record<AutomationRule["trigger"], string> = {
  task_created: "a task is created",
  status_changed: "a task's status changes",
  task_completed: "a task is completed",
};
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** "Add tag" value picker — bound to real tag ids. Rules saved before this
 *  picker stored free text (which never matched a tag, so the rule did
 *  nothing visible); those show up flagged, with a one-click link when a tag
 *  with that label exists. */
function TagPicker({ value, tags, onChange, label, disabled = false }: { value: string; tags: Record<string, TagDef>; onChange: (v: string) => void; label: string; disabled?: boolean }) {
  const entries = Object.entries(tags).sort((a, b) => a[1].label.localeCompare(b[1].label));
  const known = !!tags[value];
  const foreignId = !known && UUID_RE.test(value);           // a teammate's tag — valid, just not in your list
  const legacy = !!value && !known && !foreignId;            // free text from the old input
  const match = legacy ? resolveTagId(value, tags) : null;
  const color = known ? tags[value].color : undefined;
  return (
    <span className="kpj-tagpick">
      <span aria-hidden="true" className="kpj-tagpick-dot" data-empty={!color || undefined} style={color ? { background: projectPaint(color).solid } : undefined} />
      <select className="kpj-field" value={value} disabled={disabled} onChange={(e) => { if (!disabled) onChange(e.target.value); }} aria-label={label} aria-invalid={legacy || undefined}>
        {!value && <option value="" disabled>Choose a tag…</option>}
        {foreignId && <option value={value}>A teammate's tag</option>}
        {legacy && <option value={value}>“{value}” — not a tag</option>}
        {entries.map(([id, t]) => <option key={id} value={id}>{t.label}</option>)}
      </select>
      {match && !disabled && <Button variant="ghost" size="sm" icon="link" onClick={() => onChange(match)}>Link to tag “{tags[match].label}”</Button>}
      {legacy && (disabled || !match) && <span className="kpj-hint" data-tone="signal">{disabled ? "This action adds nothing: it isn't linked to a tag." : "Choose a tag: this action adds nothing until you do."}</span>}
      {entries.length === 0 && !disabled && <span className="kpj-hint">No tags yet. Create one from any task first.</span>}
    </span>
  );
}

export function AutomationsView({ rules, projects, members, sections, tags, onCreate, onUpdate, onDelete, projectId, readOnly = false }: {
  rules: AutomationRule[];
  projects: Project[];
  members: { id: string; name: string }[];
  sections: Section[];
  /** tag registry (id → label/colour); defaults to the live TAGS reference data */
  tags?: Record<string, TagDef>;
  onCreate: (projectId: string, name: string, actions: AutomationAction[], trigger: AutomationRule["trigger"]) => void;
  onUpdate: (id: string, patch: { name?: string; actions?: AutomationAction[]; enabled?: boolean; trigger?: AutomationRule["trigger"] }) => void;
  onDelete: (id: string) => void;
  /** inside a project: show only its rules, and new rules land in it */
  projectId?: string;
  /** view only (guests) */
  readOnly?: boolean;
}) {
  const tagMap = tags ?? TAGS;
  const realProjects = projects.filter((p) => p.id !== "p-personal");
  const { pid, setPid, fixed } = useTargetProject(realProjects, projectId);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [trigger, setTrigger] = useState<AutomationRule["trigger"]>("task_created");
  const add = () => { const n = name.trim(); if (n && pid) { onCreate(pid, n, [], trigger); setName(""); setAdding(false); } };
  const firstTag = Object.entries(tagMap).sort((a, b) => a[1].label.localeCompare(b[1].label))[0]?.[0] ?? "";
  const defaultValue = (type: AutomationActionType): string =>
    type === "set_priority" ? "medium" : type === "set_assignee" ? (members[0]?.id ?? "") : type === "add_tag" ? firstTag : "";
  const personName = (id: string) => members.find((m) => m.id === id)?.name ?? (getMember(id)?.name ? `${getMember(id)!.name} (former member)` : "(former member)");
  const ordered = useStableOrder(projectId ? rules.filter((r) => r.projectId === projectId) : rules);
  const canAdd = !readOnly && realProjects.length > 0;

  const adder = adding && canAdd && (
    <div className="kpj-adder">
      {!fixed && <select className="kpj-field" value={pid} onChange={(e) => setPid(e.target.value)} aria-label="Project">{realProjects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>}
      <select className="kpj-field" value={trigger} onChange={(e) => setTrigger(e.target.value as AutomationRule["trigger"])} aria-label="Trigger">
        {(Object.keys(TRIGGER_LABEL) as AutomationRule["trigger"][]).map((t) => <option key={t} value={t}>When {TRIGGER_LABEL[t]}</option>)}
      </select>
      {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
      <input autoFocus className="kpj-field" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") add(); else if (e.key === "Escape") { e.stopPropagation(); setAdding(false); } }} placeholder="Rule name, e.g. Triage new bugs" aria-label="New rule name" />
      <Button variant="primary" onClick={add} disabled={!name.trim()}>Add</Button>
      <Button variant="ghost" onClick={() => setAdding(false)}>Cancel</Button>
    </div>
  );

  return (
    <div className="kpj-page">
      <div className="kpj-wrap">
        <div className="kpj-narrow">
          <div className="kpj-toolbar">
            <p className="kpj-toolbar-note">{projectId
              ? "Rules run on this project's tasks. Pick when a rule fires, then what it does."
              : "Rules do the busywork when a task is added or changes: assign it, set its priority, file or tag it."}</p>
            {canAdd && (ordered.length > 0 || adding) && <Button variant="primary" size="sm" icon="plus" onClick={() => setAdding(true)}>New rule</Button>}
          </div>
          {realProjects.length === 0 ? (
            <EmptyState art="layers" title="No projects yet" body="Rules run on a project's tasks, so start with a project." />
          ) : ordered.length === 0 && !adding ? (
            <EmptyState art="layers" title="No rules yet"
              body={readOnly ? "Nobody has set up a rule here yet." : "Say what should happen when a task is added, changes status or is completed, and Kanbo does it every time."}
              action={canAdd ? <Button variant="primary" icon="plus" onClick={() => setAdding(true)}>New rule</Button> : undefined} />
          ) : (
            <>
              {adder}
              <div className="kpj-stack">
                {ordered.map((rule) => {
                  const proj = getProject(rule.projectId) ?? realProjects.find((p) => p.id === rule.projectId);
                  const projSections = sections.filter((s) => s.projectId === rule.projectId);
                  const setActions = (actions: AutomationAction[]) => onUpdate(rule.id, { actions });
                  const setValue = (i: number, value: string) => setActions(rule.actions.map((x, j) => j === i ? { ...x, value } : x));
                  return (
                    <article key={rule.id} className="kpj-card" data-paused={!rule.enabled || undefined} aria-label={`Rule ${rule.name}`}>
                      <div className="kpj-card-head">
                        {proj && !projectId && <ProjectDot color={proj.color} size={10} title={proj.name} />}
                        {readOnly
                          ? <span className="kpj-name-static">{rule.name}</span>
                          : <DraftInput value={rule.name} required label={`Rule name: ${rule.name}`} onCommit={(v) => onUpdate(rule.id, { name: v })} className="kpj-name-input" />}
                        <div className="kpj-card-side">
                          {!projectId && proj && <span className="kpj-card-meta">{proj.name}</span>}
                          {!rule.enabled && <span className="kpj-card-meta">Paused</span>}
                          <button type="button" role="switch" className="ktoggle-switch" aria-checked={rule.enabled} aria-label={`Run rule ${rule.name}`}
                            title={rule.enabled ? "On: click to pause" : "Paused: click to turn on"} disabled={readOnly}
                            onClick={() => onUpdate(rule.id, { enabled: !rule.enabled })}>
                            <span className="ktoggle-thumb" aria-hidden="true" />
                          </button>
                          {!readOnly && (
                            <IconButton icon="trash" size="sm" tone="danger" label={`Delete rule ${rule.name}`}
                              onClick={() => { if (window.confirm(`Delete the rule “${rule.name}”?`)) onDelete(rule.id); }} />
                          )}
                        </div>
                      </div>
                      <div className="kpj-card-body">
                        <div className="kpj-rule-when">
                          <span>When</span>
                          <select className="kpj-field" data-size="sm" value={rule.trigger} disabled={readOnly}
                            onChange={(e) => onUpdate(rule.id, { trigger: e.target.value as AutomationRule["trigger"] })} aria-label={`Trigger for ${rule.name}`}>
                            {(Object.keys(TRIGGER_LABEL) as AutomationRule["trigger"][]).map((t) => <option key={t} value={t}>{TRIGGER_LABEL[t]}</option>)}
                          </select>
                          <span>then</span>
                        </div>
                        <div className="kpj-rule-actions">
                          {rule.actions.length === 0 && <p className="kpj-rule-empty">No actions yet. The rule does nothing until it has one{readOnly ? "." : ": add one below."}</p>}
                          {rule.actions.map((a, i) => (
                            <div key={i} className="kpj-rule-action">
                              <span className="kpj-rule-action-label">{ACTION_LABEL[a.type]}</span>
                              {a.type === "set_priority" && (
                                <select className="kpj-field" value={a.value} disabled={readOnly} onChange={(e) => setValue(i, e.target.value)} aria-label={`Priority set by ${rule.name}`}>
                                  {PRIORITIES.map((p) => <option key={p} value={p}>{PRIORITY_META[p]?.label ?? p}</option>)}
                                </select>
                              )}
                              {a.type === "set_assignee" && (
                                <select className="kpj-field" value={a.value} disabled={readOnly} onChange={(e) => setValue(i, e.target.value)} aria-label={`Person assigned by ${rule.name}`}>
                                  {!a.value && <option value="" disabled>Choose a person…</option>}
                                  {a.value && !members.some((m) => m.id === a.value) && <option value={a.value}>{personName(a.value)}</option>}
                                  {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                                </select>
                              )}
                              {a.type === "set_section" && (
                                <select className="kpj-field" value={a.value} disabled={readOnly} onChange={(e) => setValue(i, e.target.value)} aria-label={`Section used by ${rule.name}`}>
                                  <option value="">No section</option>
                                  {a.value && !projSections.some((sct) => sct.id === a.value) && <option value={a.value}>(deleted section)</option>}
                                  {projSections.map((sct) => <option key={sct.id} value={sct.id}>{sct.name}</option>)}
                                </select>
                              )}
                              {a.type === "add_tag" && <TagPicker value={a.value} tags={tagMap} onChange={(v) => setValue(i, v)} label={`Tag added by ${rule.name}`} disabled={readOnly} />}
                              {!readOnly && (
                                <IconButton icon="x" size="sm" label={`Remove “${ACTION_LABEL[a.type]}” from ${rule.name}`} style={{ marginLeft: "auto" }}
                                  onClick={() => setActions(rule.actions.filter((_, j) => j !== i))} />
                              )}
                            </div>
                          ))}
                        </div>
                        {!readOnly && (
                          <div className="kpj-rule-add">
                            {(Object.keys(ACTION_LABEL) as AutomationActionType[]).map((type) => (
                              <button key={type} type="button" className="kpj-chip" aria-label={`Add action “${ACTION_LABEL[type]}” to ${rule.name}`}
                                onClick={() => setActions([...rule.actions, { type, value: defaultValue(type) }])}>
                                <Icon name="plus" size={14} sw={1.75} /> {ACTION_LABEL[type]}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    </article>
                  );
                })}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/* ---------------- REQUESTS (intake forms) ---------------- */
const FORM_FIELDS: { key: FormFieldKey; label: string }[] = [
  { key: "description", label: "Description" },
  { key: "priority", label: "Priority" },
  { key: "dueDate", label: "Due date" },
  { key: "assignee", label: "Assignee" },
];
/** `assigneeId` is "" when the form asks for an assignee and the submitter
 *  chose "Unassigned", and undefined when the form doesn't ask. */
export interface FormValues { title: string; description?: string; priority?: string; dueDate?: string; assigneeId?: string }
export function FormsView({ forms, projects, members, onCreate, onUpdate, onDelete, onSubmit, onPublicChange, projectId, readOnly = false }: {
  forms: FormDef[];
  projects: Project[];
  members: { id: string; name: string }[];
  onCreate: (projectId: string, name: string, fields: FormFieldKey[]) => void;
  onUpdate: (id: string, patch: { name?: string; fields?: FormFieldKey[] }) => void;
  onDelete: (id: string) => void;
  /** file the request. Return false if it wasn't taken (the words stay in the form). */
  onSubmit: (projectId: string, values: FormValues) => boolean | void;
  /** a form's public link was switched on/off or regenerated (already saved): update the list */
  onPublicChange?: (id: string, patch: { publicEnabled: boolean; publicToken: string | null }) => void;
  /** inside a project: show only its forms, and new forms land in it */
  projectId?: string;
  /** guests: see which forms there are and what they ask for; no filling in, building, renaming or deleting */
  readOnly?: boolean;
}) {
  const realProjects = projects.filter((p) => p.id !== "p-personal");
  const { pid, setPid, fixed } = useTargetProject(realProjects, projectId);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [fillFor, setFillFor] = useState<string | null>(null);
  const [vals, setVals] = useState<FormValues>({ title: "" });
  // a remembered assignee from another workspace would silently assign the task outside this team
  const assigneeId = vals.assigneeId && members.some((m) => m.id === vals.assigneeId) ? vals.assigneeId : "";
  const add = () => { const n = name.trim(); if (n && pid) { onCreate(pid, n, ["description", "priority"]); setName(""); setAdding(false); } };
  const submit = (f: FormDef) => {
    if (!vals.title.trim()) return;
    const taken = onSubmit(f.projectId, { ...vals, title: vals.title.trim(), assigneeId: f.fields.includes("assignee") ? assigneeId : undefined });
    if (taken === false) return; // refused: keep what they typed
    setVals({ title: "" }); setFillFor(null);
  };
  const ordered = useStableOrder(projectId ? forms.filter((f) => f.projectId === projectId) : forms);
  const canAdd = !readOnly && realProjects.length > 0;

  const adder = adding && canAdd && (
    <div className="kpj-adder">
      {!fixed && <select className="kpj-field" value={pid} onChange={(e) => setPid(e.target.value)} aria-label="Project">{realProjects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>}
      {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
      <input autoFocus className="kpj-field" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") add(); else if (e.key === "Escape") { e.stopPropagation(); setAdding(false); } }} placeholder="Form name, e.g. Bug report" aria-label="New form name" />
      <Button variant="primary" onClick={add} disabled={!name.trim()}>Add</Button>
      <Button variant="ghost" onClick={() => setAdding(false)}>Cancel</Button>
    </div>
  );

  return (
    <div className="kpj-page">
      <div className="kpj-wrap">
        <div className="kpj-narrow">
          <div className="kpj-toolbar">
            <p className="kpj-toolbar-note">{projectId
              ? "Teammates fill these in to file work into this project."
              : "Request forms turn what people ask for into tasks, filed straight into the right project."}
              {readOnly && ordered.length > 0 && " Only members can file requests; ask one to file yours."}</p>
            {canAdd && (ordered.length > 0 || adding) && <Button variant="primary" size="sm" icon="plus" onClick={() => setAdding(true)}>New form</Button>}
          </div>
          {realProjects.length === 0 ? (
            <EmptyState art="briefcase" title="No projects yet" body="A request form files each submission into a project, so start with a project." />
          ) : ordered.length === 0 && !adding ? (
            <EmptyState art="inbox" title="No request forms yet"
              body={readOnly ? "Nobody has set up a request form here yet." : "Build a form for the things people ask for, like bug reports or design requests. Each one becomes a task."}
              action={canAdd ? <Button variant="primary" icon="plus" onClick={() => setAdding(true)}>New form</Button> : undefined} />
          ) : (
            <>
              {adder}
              <div className="kpj-stack">
                {ordered.map((f) => {
                  const proj = getProject(f.projectId) ?? realProjects.find((p) => p.id === f.projectId);
                  const filling = fillFor === f.id;
                  return (
                    <article key={f.id} className="kpj-card" aria-label={`Request form ${f.name}`}>
                      <div className="kpj-card-head">
                        {proj && !projectId && <ProjectDot color={proj.color} size={10} title={proj.name} />}
                        {readOnly
                          ? <span className="kpj-name-static">{f.name}</span>
                          : <DraftInput value={f.name} required label={`Form name: ${f.name}`} onCommit={(v) => onUpdate(f.id, { name: v })} className="kpj-name-input" />}
                        <div className="kpj-card-side">
                          {!projectId && proj && <span className="kpj-card-meta">{proj.name}</span>}
                          {!readOnly && (
                            <Button variant={filling ? "ghost" : "secondary"} size="sm" aria-expanded={filling} aria-label={`${filling ? "Close" : "Open"} form ${f.name}`}
                              onClick={() => { setFillFor(filling ? null : f.id); setVals({ title: "" }); }}>{filling ? "Close" : "Open form"}</Button>
                          )}
                          {!readOnly && (
                            <IconButton icon="trash" size="sm" tone="danger" label={`Delete form ${f.name}`}
                              onClick={() => { if (window.confirm(`Delete the form “${f.name}”?`)) onDelete(f.id); }} />
                          )}
                        </div>
                      </div>
                      {readOnly ? (
                        <p className="kpj-card-meta" style={{ margin: "8px 0 0" }}>Asks for a title{f.fields.length ? `, ${FORM_FIELDS.filter((ff) => f.fields.includes(ff.key)).map((ff) => ff.label.toLowerCase()).join(", ")}` : ""}.</p>
                      ) : (
                        <div className="kpj-form-fields" role="group" aria-label={`Fields asked for by ${f.name}`}>
                          {FORM_FIELDS.map((ff) => {
                            const on = f.fields.includes(ff.key);
                            return (
                              <button key={ff.key} type="button" className="kpj-chip" aria-pressed={on}
                                onClick={() => onUpdate(f.id, { fields: on ? f.fields.filter((x) => x !== ff.key) : [...f.fields, ff.key] })}>
                                <Icon name={on ? "check" : "plus"} size={14} sw={1.75} />{ff.label}
                              </button>
                            );
                          })}
                        </div>
                      )}
                      {/* anyone with the link can submit (guests only see the link while it's on) */}
                      <PublicLinkPanel form={f} canEdit={!readOnly} projectName={proj?.name} onChange={(p) => onPublicChange?.(f.id, p)} />
                      {filling && !readOnly && (
                        <form className="kpj-form-fill" aria-label={`Fill in ${f.name}`} onSubmit={(e) => { e.preventDefault(); submit(f); }}>
                          {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
                          <input autoFocus className="kpj-field" value={vals.title} onChange={(e) => setVals((v) => ({ ...v, title: e.target.value }))} placeholder="Title (required)" aria-label="Title"
                            // Enter files a title-only form; when the form asks for more, it moves on to the next field
                            onKeyDown={(e) => {
                              if (e.key !== "Enter" || e.nativeEvent.isComposing || !f.fields.length) return;
                              e.preventDefault();
                              const els = Array.from(e.currentTarget.form?.elements ?? []) as HTMLElement[];
                              els[els.indexOf(e.currentTarget) + 1]?.focus();
                            }} />
                          {f.fields.includes("description") && <textarea className="kpj-field" value={vals.description ?? ""} onChange={(e) => setVals((v) => ({ ...v, description: e.target.value }))} placeholder="Description" aria-label="Description" rows={3} />}
                          {(f.fields.includes("priority") || f.fields.includes("dueDate") || f.fields.includes("assignee")) && (
                            <div className="kpj-form-fill-row">
                              {f.fields.includes("priority") && (
                                <select className="kpj-field" value={vals.priority ?? "medium"} onChange={(e) => setVals((v) => ({ ...v, priority: e.target.value }))} aria-label="Priority" style={{ width: "auto" }}>
                                  {PRIORITIES.map((p) => <option key={p} value={p}>{PRIORITY_META[p]?.label ?? p} priority</option>)}
                                </select>
                              )}
                              {f.fields.includes("dueDate") && (
                                <DateChip size="md" label="Due date" value={vals.dueDate} placeholder="Due date" onChange={(d) => setVals((v) => ({ ...v, dueDate: d }))} />
                              )}
                              {f.fields.includes("assignee") && (
                                <select className="kpj-field" value={assigneeId} onChange={(e) => setVals((v) => ({ ...v, assigneeId: e.target.value }))} aria-label="Assignee" style={{ width: "auto" }}>
                                  <option value="">Unassigned</option>{members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                                </select>
                              )}
                            </div>
                          )}
                          <Button type="submit" variant="primary" disabled={!vals.title.trim()}>Submit request</Button>
                        </form>
                      )}
                    </article>
                  );
                })}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
