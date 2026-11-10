/* ============================================================
   KANBO — the meeting's stage: one agenda item at a time, set large
   enough to read on a screen across the room. Kanbo's read; a person
   (done, today, blocked, who's off, their week); Radar's risks; goals
   behind pace; projects to look at (the one pill, and why); last
   meeting's actions with where each stands now (read live from the
   task, as you can see it). A task opens in the task panel over the
   room. The wrap-up lives in RoomWrap.
   ============================================================ */
import type { ReactNode } from "react";
import { Avatar, Icon, Meter, ProjectTile, StatusGlyph } from "../primitives";
import { getMember, getProject, toLocalISO, KANBO_TODAY } from "../../data/data";
import type { Task } from "../../data/types";
import { loadTone } from "../../lib/radar";
import { actionState } from "../../lib/meetings/agenda";
import type { AgendaEntry, AgendaItem } from "../../lib/meetings/types";

const firstName = (name: string) => name.trim().split(/\s+/)[0] || name;

export interface StageContext {
  taskById: ReadonlyMap<string, Task>;
  nameOf: (id: string) => string | undefined;
  onOpenTask: (id: string) => void;
  /** workspace names (a Group meeting's rows say whose they are) */
  wsName?: (id: string | null | undefined) => string | undefined;
  /** the agenda, for the overview's list */
  agenda: readonly AgendaItem[];
  onGo?: (index: number) => void;
}

/** A person's mark: their avatar, else their initial. */
export function PersonMark({ id, name, size = 28 }: { id: string; name?: string; size?: number }) {
  if (getMember(id)) return <Avatar id={id} size={size} />;
  return <span className="kmtg-initial" style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }} aria-hidden="true">{(name ?? "?").charAt(0).toUpperCase()}</span>;
}

function TaskLine({ e, ctx }: { e: AgendaEntry; ctx: StageContext }) {
  const live = ctx.taskById.get(e.taskId);
  const status = live?.status ?? e.status;
  return (
    <li className="kmtg-task">
      <button type="button" className="kmtg-task-btn" onClick={() => ctx.onOpenTask(e.taskId)} disabled={!live} title={live ? undefined : "You can't open this task"}>
        <StatusGlyph status={status} size={16} />
        <span className="kmtg-task-text">
          <span className="kmtg-task-title" data-done={status === "done" || undefined}>{live?.title ?? e.title}</span>
          {e.note && <span className="kmtg-task-note" data-tone={e.tone}>{e.note}</span>}
        </span>
      </button>
    </li>
  );
}

function Column({ label, items, more, empty, ctx, tone }: { label: string; items: AgendaEntry[]; more: number; empty: string; ctx: StageContext; tone?: "signal" }) {
  return (
    <section className="kmtg-col" data-tone={tone}>
      <h3 className="kmtg-col-h">{label}<span className="kmtg-col-n">{items.length + more}</span></h3>
      {items.length ? (
        <ul className="kmtg-tasks">
          {items.map((e) => <TaskLine key={e.taskId} e={e} ctx={ctx} />)}
          {more > 0 && <li className="kmtg-more">+{more} more</li>}
        </ul>
      ) : <p className="kmtg-none">{empty}</p>}
    </section>
  );
}

const SEV_WORD = { signal: "Needs action", warn: "Watch", neutral: "Heads up" } as const;
const TONE_ICON: Record<string, string> = { off_track: "alert", at_risk: "alert", overdue: "clock", pace: "target" };

export function RoomStage({ item, ctx, extra }: { item: AgendaItem; ctx: StageContext; extra?: ReactNode }) {
  const todayISO = toLocalISO(KANBO_TODAY);
  switch (item.kind) {
    case "overview":
      return (
        <div className="kmtg-item" data-kind="overview">
          <p className="kmtg-eyebrow"><Icon name="kanbo" size={14} /> Kanbo's read</p>
          <p className="kmtg-lede">{item.lede.map((p, i) => p.strong ? <b key={i}>{p.text}</b> : <span key={i}>{p.text}</span>)}</p>
          <ol className="kmtg-plan">
            {ctx.agenda.map((a, i) => i === 0 ? null : (
              <li key={a.key}>
                <button type="button" className="kmtg-plan-row" onClick={() => ctx.onGo?.(i)} disabled={!ctx.onGo}>
                  <span className="kmtg-plan-n">{i + 1}</span>
                  {a.kind === "person" ? <PersonMark id={a.personId} name={a.title} size={20} /> : null}
                  <span className="kmtg-plan-t">{a.title}</span>
                  {a.kind === "person" && a.off && <span className="kmtg-off" data-now={a.offNow || undefined}>{a.off}</span>}
                  <span className="kmtg-plan-c">{countOf(a)}</span>
                </button>
              </li>
            ))}
          </ol>
          {extra}
        </div>
      );
    case "person": {
      const tone = item.load ? loadTone(item.load.hours, item.load.capacity) : "ink";
      return (
        <div className="kmtg-item" data-kind="person">
          <header className="kmtg-person-head">
            <PersonMark id={item.personId} name={item.title} size={48} />
            <div className="kmtg-person-who">
              <h2 className="kmtg-h">{item.title}</h2>
              <p className="kmtg-sub">
                {item.role && <span>{item.role}</span>}
                {item.off && <span className="kmtg-off" data-now={item.offNow || undefined}>{item.off}</span>}
              </p>
            </div>
            {item.load && (
              <span className="kmtg-load" data-tone={tone}>
                <span className="kmtg-load-n">{item.load.hours}h / {item.load.capacity}h</span>
                <Meter value={item.load.hours} max={Math.max(1, item.load.capacity * 1.25)} marker={item.load.capacity} width={96} height={4} tone={tone}
                  label={`${item.title}: ${item.load.hours} of ${item.load.capacity} hours this week`} />
                <span className="kmtg-load-l">this week</span>
              </span>
            )}
          </header>
          <div className="kmtg-cols">
            <Column label="Done" items={item.done} more={item.more.done} empty="Nothing finished since the last workday" ctx={ctx} />
            <Column label="Today" items={item.today} more={item.more.today} empty={item.offNow ? "Off today" : "Nothing on today"} ctx={ctx} />
            <Column label="Blocked" items={item.blocked} more={item.more.blocked} empty="Nothing blocked" ctx={ctx} tone={item.blocked.length ? "signal" : undefined} />
          </div>
          {extra}
        </div>
      );
    }
    case "risks":
      return (
        <div className="kmtg-item" data-kind="risks">
          <h2 className="kmtg-h">{item.title}</h2>
          <ul className="kmtg-rows">
            {item.risks.map((r) => (
              <li key={r.id} className="kmtg-rowi" data-tone={r.severity}>
                <span className="kmtg-sev" data-tone={r.severity} aria-hidden="true" />
                <span className="kmtg-rowi-text">
                  <span className="kmtg-rowi-t">{r.title}</span>
                  <span className="kmtg-rowi-s"><span className="sr-only">{SEV_WORD[r.severity]}: </span>{r.reason}{ctx.wsName?.(r.workspaceId) ? ` · ${ctx.wsName(r.workspaceId)}` : ""}</span>
                </span>
                {r.memberId && <PersonMark id={r.memberId} name={ctx.nameOf(r.memberId)} size={24} />}
                {r.taskIds[0] && ctx.taskById.has(r.taskIds[0]) && (
                  <button type="button" className="kmtg-open" onClick={() => ctx.onOpenTask(r.taskIds[0])}>Open</button>
                )}
              </li>
            ))}
          </ul>
          {extra}
        </div>
      );
    case "goals":
      return (
        <div className="kmtg-item" data-kind="goals">
          <h2 className="kmtg-h">{item.title}</h2>
          <ul className="kmtg-rows">
            {item.goals.map((g) => (
              <li key={g.id} className="kmtg-rowi" data-tone={g.why === "off_track" || g.why === "overdue" ? "signal" : "warn"}>
                <Icon name={(TONE_ICON[g.why] ?? "target") as "alert"} size={16} />
                <span className="kmtg-rowi-text">
                  <span className="kmtg-rowi-t">{g.name}</span>
                  <span className="kmtg-rowi-s">{g.line}{ctx.wsName?.(g.workspaceId) ? ` · ${ctx.wsName(g.workspaceId)}` : ""}</span>
                </span>
                <span className="kmtg-pct">
                  <span>{g.pct}%</span>
                  <Meter value={g.pct} max={100} width={72} height={4} tone={g.why === "off_track" || g.why === "overdue" ? "signal" : "warn"} label={`${g.name}: ${g.pct}%`} />
                </span>
                {g.ownerId && <PersonMark id={g.ownerId} name={ctx.nameOf(g.ownerId)} size={24} />}
              </li>
            ))}
          </ul>
          {extra}
        </div>
      );
    case "projects":
      return (
        <div className="kmtg-item" data-kind="projects">
          <h2 className="kmtg-h">{item.title}</h2>
          <ul className="kmtg-rows">
            {item.projects.map((p) => {
              const proj = getProject(p.id) ?? { id: p.id, name: p.name, emoji: p.emoji ?? "📁", color: p.color ?? "var(--ink-3)" };
              return (
                <li key={p.id} className="kmtg-rowi" data-tone={p.tone}>
                  <ProjectTile project={proj} size={28} />
                  <span className="kmtg-rowi-text">
                    <span className="kmtg-rowi-t">{p.name}</span>
                    <span className="kmtg-rowi-s">{[p.missing && p.label !== "Update missing" ? "Update missing" : "",
                      // a rosier call than the work: both sides say it; otherwise what Kanbo counts
                      p.mismatch ? `${p.says}; ${p.sees}` : p.detail, ctx.wsName?.(p.workspaceId) ?? ""].filter(Boolean).join(" · ")}</span>
                  </span>
                  <span className="kmtg-pill" data-tone={p.tone} data-mismatch={p.mismatch || undefined} title={`${p.says} · ${p.sees}`}>{p.pill}</span>
                </li>
              );
            })}
          </ul>
          {extra}
        </div>
      );
    case "actions":
      return (
        <div className="kmtg-item" data-kind="actions">
          <h2 className="kmtg-h">{item.title}</h2>
          {item.from && <p className="kmtg-sub">From {item.from.title}</p>}
          {item.actions.length ? (
            <ul className="kmtg-rows">
              {item.actions.map((a) => {
                const task = a.taskId ? ctx.taskById.get(a.taskId) : undefined;
                const st = actionState(a, task, todayISO);
                return (
                  <li key={a.itemId} className="kmtg-rowi" data-state={st.state}>
                    {task ? <StatusGlyph status={task.status} size={16} /> : <Icon name={st.state === "overdue" ? "clock" : "circle"} size={16} />}
                    <span className="kmtg-rowi-text">
                      <span className="kmtg-rowi-t" data-done={st.state === "done" || undefined}>{task?.title ?? a.body}</span>
                      <span className="kmtg-rowi-s" data-state={st.state}>{st.label}</span>
                    </span>
                    {a.ownerId && <span className="kmtg-owner"><PersonMark id={a.ownerId} name={ctx.nameOf(a.ownerId)} size={22} /><span>{firstName(ctx.nameOf(a.ownerId) ?? "")}</span></span>}
                    {task && <button type="button" className="kmtg-open" onClick={() => ctx.onOpenTask(task.id)}>Open</button>}
                  </li>
                );
              })}
            </ul>
          ) : <p className="kmtg-none">Last meeting left no actions.</p>}
          {extra}
        </div>
      );
    default:
      return null;
  }
}

/** "3 risks", "2", "5 done · 1 blocked" — the overview's count beside each item. */
function countOf(a: AgendaItem): string {
  switch (a.kind) {
    case "person": return [a.done.length + a.more.done ? `${a.done.length + a.more.done} done` : "", a.blocked.length + a.more.blocked ? `${a.blocked.length + a.more.blocked} blocked` : ""].filter(Boolean).join(" · ");
    case "risks": return String(a.risks.length);
    case "goals": return String(a.goals.length);
    case "projects": return String(a.projects.length);
    case "actions": return String(a.actions.length);
    default: return "";
  }
}
