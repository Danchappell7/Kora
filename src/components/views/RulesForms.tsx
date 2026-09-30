/* ============================================================
   KANBO — Rules (automations that run on new or changed tasks)
   and Requests (intake forms that file tasks into a project)
   ============================================================ */
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Icon, EmptyArt } from "../primitives";
import { getProject, getMember, TAGS, PRIORITY_META } from "../../data/data";
import type { Project, Section, AutomationRule, AutomationAction, AutomationActionType, FormDef, FormFieldKey, TagDef, Priority } from "../../data/types";
import { resolveTagId, useStableOrder } from "./reportingUtils";

const inp: React.CSSProperties = { height: 32, padding: "0 9px", borderRadius: 8, border: "1px solid var(--hairline)", background: "var(--surface)", color: "var(--ink-2)", fontFamily: "var(--font-display)", fontSize: 13, outline: "none" };
const nameInput: CSSProperties = { flex: 1, minWidth: 0, border: "none", background: "transparent", outline: "none", fontFamily: "var(--font-display)", fontSize: 15, fontWeight: 600, color: "var(--ink)", padding: "2px 0" };
const closeBtn: CSSProperties = { border: "none", background: "transparent", color: "var(--ink-4)", cursor: "pointer", fontSize: 16, lineHeight: 1, padding: "2px 4px", borderRadius: 6, flexShrink: 0 };
const PRIORITIES: Priority[] = ["low", "medium", "high", "urgent"];

function EmptyState({ icon, title, sub }: { icon: "target" | "briefcase" | "chart"; title: string; sub: string }) {
  return (
    <div style={{ textAlign: "center", padding: "70px 24px", color: "var(--ink-4)" }}>
      <div style={{ marginBottom: 14 }}><EmptyArt kind={icon} /></div>
      <p style={{ fontSize: 16, color: "var(--ink)", margin: 0, fontWeight: 600, fontFamily: "var(--font-head)", letterSpacing: "-0.01em" }}>{title}</p>
      <p style={{ fontSize: 13, margin: "5px 0 0", lineHeight: 1.5 }}>{sub}</p>
    </div>
  );
}

/** A field that edits a local draft and saves once — on blur or Enter; Escape
 *  reverts. Saving on every keystroke sent ~25 UPDATEs per name, and a
 *  realtime reload in between could revert the field mid-word.
 *  Only a value the user actually typed is ever saved: focusing a field and
 *  leaving it never writes, so a teammate's change that arrives meanwhile
 *  shows up and is kept. */
function DraftInput({ value, onCommit, label, style, type = "text", placeholder, required = false, min, max, title }: {
  value: string | number | undefined;
  /** save the typed value. Return false to reject it (the field shows the
   *  saved value again), or a string to show the value as it was stored. */
  onCommit: (v: string) => void | string | false;
  label: string;
  style?: CSSProperties;
  type?: "text" | "number";
  placeholder?: string;
  /** an empty value reverts instead of saving (names can't be blank) */
  required?: boolean;
  min?: number;
  max?: number;
  title?: string;
}) {
  const external = value == null ? "" : String(value);
  const [draft, setDraft] = useState(external);
  // true once the user has typed; until then the field keeps following `value`
  const dirty = useRef(false);
  const cancelled = useRef(false);
  // follow outside changes (another tab, a teammate) — but never over unsaved typing
  useEffect(() => { if (!dirty.current) setDraft(external); }, [external]);
  const commit = () => {
    const typed = dirty.current, escaped = cancelled.current;
    dirty.current = false; cancelled.current = false;
    if (!typed || escaped) { setDraft(external); return; }
    const v = type === "text" ? draft.trim() : draft;
    if ((required && !v) || v === external) { setDraft(external); return; }
    const shown = onCommit(v);
    setDraft(shown === false ? external : typeof shown === "string" ? shown : v);
  };
  return (
    <input type={type} value={draft} min={min} max={max} title={title} placeholder={placeholder} aria-label={label} style={style}
      onChange={(e) => { dirty.current = true; setDraft(e.target.value); }}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") { e.preventDefault(); e.currentTarget.blur(); }
        else if (e.key === "Escape") { e.stopPropagation(); cancelled.current = true; e.currentTarget.blur(); }
      }} />
  );
}

/* ---------------- AUTOMATIONS ---------------- */
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
function TagPicker({ value, tags, onChange, label }: { value: string; tags: Record<string, TagDef>; onChange: (v: string) => void; label: string }) {
  const entries = Object.entries(tags).sort((a, b) => a[1].label.localeCompare(b[1].label));
  const known = !!tags[value];
  const foreignId = !known && UUID_RE.test(value);           // a teammate's tag — valid, just not in your list
  const legacy = !!value && !known && !foreignId;            // free text from the old input
  const match = legacy ? resolveTagId(value, tags) : null;
  const color = known ? tags[value].color : undefined;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8, flexWrap: "wrap", minWidth: 0 }}>
      <span aria-hidden style={{ width: 9, height: 9, borderRadius: 3, flexShrink: 0, background: color ?? "transparent", border: color ? "none" : "1px dashed var(--hairline-strong)" }} />
      <select value={value} onChange={(e) => onChange(e.target.value)} aria-label={label} aria-invalid={legacy || undefined}
        style={{ ...inp, border: legacy ? "1px solid color-mix(in oklch, var(--prio-urgent) 55%, transparent)" : inp.border }}>
        {!value && <option value="" disabled>Choose a tag…</option>}
        {foreignId && <option value={value}>A teammate's tag</option>}
        {legacy && <option value={value}>“{value}” — not a tag</option>}
        {entries.map(([id, t]) => <option key={id} value={id}>{t.label}</option>)}
      </select>
      {match && <button type="button" onClick={() => onChange(match)} className="btn btn-ghost" style={{ padding: "3px 9px", fontSize: 12 }}>Link to tag “{tags[match].label}”</button>}
      {legacy && !match && <span style={{ fontSize: 11.5, color: "var(--prio-urgent)" }}>Choose a tag — this action adds nothing until you do.</span>}
      {entries.length === 0 && <span style={{ fontSize: 11.5, color: "var(--ink-4)" }}>No tags yet — create one from any task first.</span>}
    </span>
  );
}

export function AutomationsView({ rules, projects, members, sections, tags, onCreate, onUpdate, onDelete }: {
  rules: AutomationRule[];
  projects: Project[];
  members: { id: string; name: string }[];
  sections: Section[];
  /** tag registry (id → label/colour); defaults to the live TAGS reference data */
  tags?: Record<string, TagDef>;
  onCreate: (projectId: string, name: string, actions: AutomationAction[], trigger: AutomationRule["trigger"]) => void;
  onUpdate: (id: string, patch: { name?: string; actions?: AutomationAction[]; enabled?: boolean; trigger?: AutomationRule["trigger"] }) => void;
  onDelete: (id: string) => void;
}) {
  const tagMap = tags ?? TAGS;
  const realProjects = projects.filter((p) => p.id !== "p-personal");
  const [adding, setAdding] = useState(false);
  const [pidSel, setPid] = useState(realProjects[0]?.id ?? "");
  // after a workspace switch the remembered project isn't in the list any more —
  // fall back to this workspace's first project so a new rule lands here
  const pid = realProjects.some((p) => p.id === pidSel) ? pidSel : (realProjects[0]?.id ?? "");
  useEffect(() => { if (pid !== pidSel) setPid(pid); }, [pid, pidSel]);
  const [name, setName] = useState("");
  const [trigger, setTrigger] = useState<AutomationRule["trigger"]>("task_created");
  const add = () => { const n = name.trim(); if (n && pid) { onCreate(pid, n, [], trigger); setName(""); setAdding(false); } };
  const firstTag = Object.entries(tagMap).sort((a, b) => a[1].label.localeCompare(b[1].label))[0]?.[0] ?? "";
  const defaultValue = (type: AutomationActionType): string =>
    type === "set_priority" ? "medium" : type === "set_assignee" ? (members[0]?.id ?? "") : type === "add_tag" ? firstTag : "";
  const personName = (id: string) => members.find((m) => m.id === id)?.name ?? (getMember(id)?.name ? `${getMember(id)!.name} (former member)` : "(former member)");
  const ordered = useStableOrder(rules);
  const small: CSSProperties = { height: 26, padding: "0 6px", borderRadius: 7, border: "1px solid var(--hairline)", background: "var(--surface)", color: "var(--ink-2)", fontFamily: "var(--font-display)", fontSize: 12, outline: "none", cursor: "pointer" };

  return (
    <div style={{ flex: 1, overflowY: "auto", padding: "24px 24px 48px", maxWidth: 880, width: "100%", margin: "0 auto" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
        <p style={{ flex: "1 1 260px", fontSize: 13, color: "var(--ink-4)", margin: 0 }}>Pick a trigger, then the actions to apply automatically when it fires.</p>
        {realProjects.length > 0 && <button onClick={() => setAdding(true)} className="btn btn-accent" style={{ marginLeft: "auto", padding: "7px 13px", fontSize: 13 }}><Icon name="plus" size={15} /> New rule</button>}
      </div>
      {realProjects.length === 0 ? <EmptyState icon="chart" title="No projects yet" sub="Create a project first — rules run on its new tasks." /> : adding && (
        <div className="glass" style={{ borderRadius: 12, padding: 12, marginBottom: 14, display: "flex", gap: 8, flexWrap: "wrap" }}>
          <select value={pid} onChange={(e) => setPid(e.target.value)} style={inp} aria-label="Project">{realProjects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
          <select value={trigger} onChange={(e) => setTrigger(e.target.value as AutomationRule["trigger"])} style={inp} aria-label="Trigger">
            {(Object.keys(TRIGGER_LABEL) as AutomationRule["trigger"][]).map((t) => <option key={t} value={t}>When {TRIGGER_LABEL[t]}</option>)}
          </select>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") add(); else if (e.key === "Escape") setAdding(false); }} placeholder="Rule name, e.g. Triage inbound" aria-label="New rule name" style={{ ...inp, flex: 1, minWidth: 160 }} />
          <button onClick={add} className="btn btn-accent" style={{ padding: "5px 12px", fontSize: 12.5 }}>Add</button>
          <button onClick={() => setAdding(false)} className="btn btn-ghost" style={{ padding: "5px 10px", fontSize: 12.5 }}>Cancel</button>
        </div>
      )}
      {rules.length === 0 && !adding && realProjects.length > 0 ? <EmptyState icon="chart" title="No rules yet" sub="Create a rule to auto-assign, prioritise or file new tasks." /> : (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {ordered.map((rule) => {
            const proj = getProject(rule.projectId);
            const projSections = sections.filter((s) => s.projectId === rule.projectId);
            const setActions = (actions: AutomationAction[]) => onUpdate(rule.id, { actions });
            const setValue = (i: number, value: string) => setActions(rule.actions.map((x, j) => j === i ? { ...x, value } : x));
            return (
              <div key={rule.id} className="glass" style={{ borderRadius: 14, padding: "15px 17px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10, flexWrap: "wrap" }}>
                  {proj && <span style={{ width: 9, height: 9, borderRadius: 2, background: proj.color, flexShrink: 0 }} />}
                  <DraftInput value={rule.name} required label={`Rule name: ${rule.name}`} onCommit={(v) => onUpdate(rule.id, { name: v })} style={{ ...nameInput, flex: "1 1 160px" }} />
                  <div style={{ display: "flex", alignItems: "center", gap: 10, marginLeft: "auto" }}>
                  <span style={{ fontSize: 12, color: "var(--ink-4)" }}>{proj?.name}</span>
                  {!rule.enabled && <span style={{ fontSize: 11.5, color: "var(--ink-4)" }}>Paused</span>}
                  <button type="button" role="switch" aria-checked={rule.enabled} aria-label={`Run rule ${rule.name}`} title={rule.enabled ? "On — click to pause" : "Paused — click to turn on"}
                    onClick={() => onUpdate(rule.id, { enabled: !rule.enabled })}
                    style={{ width: 40, height: 22, flexShrink: 0, borderRadius: 999, border: "none", cursor: "pointer", padding: 0, background: rule.enabled ? "var(--accent)" : "var(--hairline-strong)", position: "relative", transition: "background .15s" }}>
                    <span style={{ position: "absolute", top: 2, left: rule.enabled ? 20 : 2, width: 18, height: 18, borderRadius: 99, background: "#fff", boxShadow: "0 1px 2px oklch(0.25 0.02 266 / 0.2), 0 0 0 0.5px oklch(0.25 0.02 266 / 0.08)", transition: "left .15s" }} />
                  </button>
                  <button onClick={() => { if (window.confirm(`Delete automation “${rule.name}”?`)) onDelete(rule.id); }} aria-label={`Delete rule ${rule.name}`} style={closeBtn}>×</button>
                  </div>
                </div>
                <div style={{ opacity: rule.enabled ? 1 : 0.62, transition: "opacity .2s" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 12, color: "var(--ink-4)", marginBottom: 8 }}>
                    <span>When</span>
                    <select value={rule.trigger} onChange={(e) => onUpdate(rule.id, { trigger: e.target.value as AutomationRule["trigger"] })} aria-label={`Trigger for ${rule.name}`} style={small}>
                      {(Object.keys(TRIGGER_LABEL) as AutomationRule["trigger"][]).map((t) => <option key={t} value={t}>{TRIGGER_LABEL[t]}</option>)}
                    </select>
                    <span>→</span>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                    {rule.actions.length === 0 && <p style={{ fontSize: 12.5, color: "var(--ink-4)", margin: 0 }}>No actions yet — add one below. The rule does nothing until it has one.</p>}
                    {rule.actions.map((a, i) => (
                      <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                        <span style={{ fontSize: 12.5, color: "var(--ink-3)", width: 120, flexShrink: 0 }}>{ACTION_LABEL[a.type]}</span>
                        {a.type === "set_priority" && (
                          <select value={a.value} onChange={(e) => setValue(i, e.target.value)} aria-label={`Priority set by ${rule.name}`} style={inp}>
                            {PRIORITIES.map((p) => <option key={p} value={p}>{PRIORITY_META[p]?.label ?? p}</option>)}
                          </select>
                        )}
                        {a.type === "set_assignee" && (
                          <select value={a.value} onChange={(e) => setValue(i, e.target.value)} aria-label={`Person assigned by ${rule.name}`} style={inp}>
                            {!a.value && <option value="" disabled>Choose a person…</option>}
                            {a.value && !members.some((m) => m.id === a.value) && <option value={a.value}>{personName(a.value)}</option>}
                            {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                          </select>
                        )}
                        {a.type === "set_section" && (
                          <select value={a.value} onChange={(e) => setValue(i, e.target.value)} aria-label={`Section used by ${rule.name}`} style={inp}>
                            <option value="">—</option>
                            {a.value && !projSections.some((sct) => sct.id === a.value) && <option value={a.value}>(deleted section)</option>}
                            {projSections.map((sct) => <option key={sct.id} value={sct.id}>{sct.name}</option>)}
                          </select>
                        )}
                        {a.type === "add_tag" && <TagPicker value={a.value} tags={tagMap} onChange={(v) => setValue(i, v)} label={`Tag added by ${rule.name}`} />}
                        <button onClick={() => setActions(rule.actions.filter((_, j) => j !== i))} aria-label={`Remove “${ACTION_LABEL[a.type]}” from ${rule.name}`} style={{ ...closeBtn, marginLeft: "auto", fontSize: 14 }}>×</button>
                      </div>
                    ))}
                  </div>
                  <div style={{ display: "flex", gap: 6, marginTop: 10, flexWrap: "wrap" }}>
                    {(Object.keys(ACTION_LABEL) as AutomationActionType[]).map((type) => (
                      <button key={type} onClick={() => setActions([...rule.actions, { type, value: defaultValue(type) }])} aria-label={`Add action “${ACTION_LABEL[type]}” to ${rule.name}`} style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "4px 10px", borderRadius: 999, border: "1px solid var(--hairline)", background: "transparent", cursor: "pointer", fontSize: 12, color: "var(--ink-3)", fontFamily: "var(--font-display)" }}>
                        <Icon name="plus" size={12} /> {ACTION_LABEL[type]}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ---------------- INTAKE FORMS ---------------- */
const FORM_FIELDS: { key: FormFieldKey; label: string }[] = [
  { key: "description", label: "Description" },
  { key: "priority", label: "Priority" },
  { key: "dueDate", label: "Due date" },
  { key: "assignee", label: "Assignee" },
];
/** `assigneeId` is "" when the form asks for an assignee and the submitter
 *  chose "Unassigned", and undefined when the form doesn't ask. */
export interface FormValues { title: string; description?: string; priority?: string; dueDate?: string; assigneeId?: string }
export function FormsView({ forms, projects, members, onCreate, onUpdate, onDelete, onSubmit }: {
  forms: FormDef[];
  projects: Project[];
  members: { id: string; name: string }[];
  onCreate: (projectId: string, name: string, fields: FormFieldKey[]) => void;
  onUpdate: (id: string, patch: { name?: string; fields?: FormFieldKey[] }) => void;
  onDelete: (id: string) => void;
  onSubmit: (projectId: string, values: FormValues) => void;
}) {
  const realProjects = projects.filter((p) => p.id !== "p-personal");
  const [adding, setAdding] = useState(false);
  const [pidSel, setPid] = useState(realProjects[0]?.id ?? "");
  // after a workspace switch the remembered project isn't in the list any more —
  // fall back to this workspace's first project so the form is saved here
  const pid = realProjects.some((p) => p.id === pidSel) ? pidSel : (realProjects[0]?.id ?? "");
  useEffect(() => { if (pid !== pidSel) setPid(pid); }, [pid, pidSel]);
  const [name, setName] = useState("");
  const [fillFor, setFillFor] = useState<string | null>(null);
  const [vals, setVals] = useState<FormValues>({ title: "" });
  // a remembered assignee from another workspace would silently assign the task outside this team
  const assigneeId = vals.assigneeId && members.some((m) => m.id === vals.assigneeId) ? vals.assigneeId : "";
  const add = () => { const n = name.trim(); if (n && pid) { onCreate(pid, n, ["description", "priority"]); setName(""); setAdding(false); } };
  const submit = (f: FormDef) => { if (vals.title.trim()) { onSubmit(f.projectId, { ...vals, title: vals.title.trim(), assigneeId: f.fields.includes("assignee") ? assigneeId : undefined }); setVals({ title: "" }); setFillFor(null); } };
  const ordered = useStableOrder(forms);

  return (
    <div style={{ flex: 1, overflowY: "auto", padding: "24px 24px 48px", maxWidth: 880, width: "100%", margin: "0 auto" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
        <p style={{ flex: "1 1 260px", fontSize: 13, color: "var(--ink-4)", margin: 0 }}>Build a form — each submission becomes a task in its project.</p>
        {realProjects.length > 0 && <button onClick={() => setAdding(true)} className="btn btn-accent" style={{ marginLeft: "auto", padding: "7px 13px", fontSize: 13 }}><Icon name="plus" size={15} /> New form</button>}
      </div>
      {realProjects.length === 0 ? <EmptyState icon="briefcase" title="No projects yet" sub="Create a project first — forms file submissions into it." /> : adding && (
        <div className="glass" style={{ borderRadius: 12, padding: 12, marginBottom: 14, display: "flex", gap: 8, flexWrap: "wrap" }}>
          <select value={pid} onChange={(e) => setPid(e.target.value)} style={inp} aria-label="Project">{realProjects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") add(); else if (e.key === "Escape") setAdding(false); }} placeholder="Form name, e.g. Bug report" aria-label="New form name" style={{ ...inp, flex: 1, minWidth: 160 }} />
          <button onClick={add} className="btn btn-accent" style={{ padding: "5px 12px", fontSize: 12.5 }}>Add</button>
          <button onClick={() => setAdding(false)} className="btn btn-ghost" style={{ padding: "5px 10px", fontSize: 12.5 }}>Cancel</button>
        </div>
      )}
      {forms.length === 0 && !adding && realProjects.length > 0 ? <EmptyState icon="briefcase" title="No forms yet" sub="Create a form to capture requests as tasks." /> : (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {ordered.map((f) => {
            const proj = getProject(f.projectId);
            const filling = fillFor === f.id;
            return (
              <div key={f.id} className="glass" style={{ borderRadius: 14, padding: "15px 17px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                  {proj && <span style={{ width: 9, height: 9, borderRadius: 2, background: proj.color, flexShrink: 0 }} />}
                  <DraftInput value={f.name} required label={`Form name: ${f.name}`} onCommit={(v) => onUpdate(f.id, { name: v })} style={{ ...nameInput, flex: "1 1 160px" }} />
                  <div style={{ display: "flex", alignItems: "center", gap: 10, marginLeft: "auto" }}>
                  <span style={{ fontSize: 12, color: "var(--ink-4)" }}>{proj?.name}</span>
                  <button onClick={() => { setFillFor(filling ? null : f.id); setVals({ title: "" }); }} aria-expanded={filling} aria-label={`${filling ? "Close" : "Open"} form ${f.name}`} className="btn btn-ghost" style={{ padding: "5px 11px", fontSize: 12.5 }}>{filling ? "Close" : "Open form"}</button>
                  <button onClick={() => { if (window.confirm(`Delete form “${f.name}”?`)) onDelete(f.id); }} aria-label={`Delete form ${f.name}`} style={closeBtn}>×</button>
                  </div>
                </div>
                <div style={{ display: "flex", gap: 6, marginTop: 10, flexWrap: "wrap" }} role="group" aria-label={`Fields asked for by ${f.name}`}>
                  {FORM_FIELDS.map((ff) => {
                    const on = f.fields.includes(ff.key);
                    return <button key={ff.key} aria-pressed={on} onClick={() => onUpdate(f.id, { fields: on ? f.fields.filter((x) => x !== ff.key) : [...f.fields, ff.key] })} style={{ padding: "3px 10px", borderRadius: 999, cursor: "pointer", fontSize: 12, border: `1px solid ${on ? "var(--accent)" : "var(--hairline)"}`, background: on ? "var(--accent-dim)" : "transparent", color: on ? "var(--ink)" : "var(--ink-4)", fontFamily: "var(--font-display)" }}>{ff.label}</button>;
                  })}
                </div>
                {filling && (
                  <div style={{ marginTop: 14, borderTop: "1px solid var(--hairline)", paddingTop: 14, display: "flex", flexDirection: "column", gap: 9 }}>
                    <input autoFocus value={vals.title} onChange={(e) => setVals((v) => ({ ...v, title: e.target.value }))} placeholder="Title (required)" aria-label="Title" style={inp} />
                    {f.fields.includes("description") && <textarea value={vals.description ?? ""} onChange={(e) => setVals((v) => ({ ...v, description: e.target.value }))} placeholder="Description" aria-label="Description" rows={2} style={{ ...inp, height: "auto", padding: "8px 9px", resize: "vertical" }} />}
                    {f.fields.includes("priority") && <select value={vals.priority ?? "medium"} onChange={(e) => setVals((v) => ({ ...v, priority: e.target.value }))} aria-label="Priority" style={inp}>{PRIORITIES.map((p) => <option key={p} value={p}>{PRIORITY_META[p]?.label ?? p}</option>)}</select>}
                    {f.fields.includes("dueDate") && <input type="date" value={vals.dueDate ?? ""} onChange={(e) => setVals((v) => ({ ...v, dueDate: e.target.value }))} aria-label="Due date" style={inp} />}
                    {f.fields.includes("assignee") && <select value={assigneeId} onChange={(e) => setVals((v) => ({ ...v, assigneeId: e.target.value }))} aria-label="Assignee" style={inp}><option value="">Unassigned</option>{members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select>}
                    <button onClick={() => submit(f)} disabled={!vals.title.trim()} className="btn btn-accent" style={{ alignSelf: "flex-start", padding: "6px 13px", fontSize: 13, opacity: vals.title.trim() ? 1 : 0.6 }}>Submit → create task</button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
