/* ============================================================
   KANBO — a project doc, read only.                          [0047, w5]
   What guests see (and the version-history preview): the same blocks
   as the editor, as real headings, lists, quotes and links. Mentions
   are chips; a Make-task line carries its task's live status and opens
   the task. Doc headings sit under the doc's title, so heading 1 is an
   <h3> on the page (the project's name is its <h1>, the doc title <h2>).
   ============================================================ */
import type { ReactNode } from "react";
import type { DocBlock, DocSpan, Task } from "../../data/types";
import { STATUS_META } from "../../data/data";
import { Icon, StatusGlyph } from "../primitives";
import { DEFAULT_CALLOUT_ICON, isListType, listNumber } from "../../lib/docBlocks";

export type NameOf = (id: string) => string | undefined;

/** A span run as inline elements. */
export function SpansView({ spans, nameOf, placeholder }: { spans: readonly DocSpan[] | undefined; nameOf?: NameOf; placeholder?: string }) {
  const list = spans ?? [];
  if (!list.length && placeholder) return <span className="kdoc-ph">{placeholder}</span>;
  return (
    <>
      {list.map((s, i) => {
        if (s.mention) {
          const name = nameOf?.(s.mention);
          return <span key={i} className="kdoc-mention" data-mention={s.mention}>{name ? `@${name}` : s.text}</span>;
        }
        let node: ReactNode = s.text;
        if (s.marks?.includes("code")) node = <code>{node}</code>;
        if (s.marks?.includes("i")) node = <em>{node}</em>;
        if (s.marks?.includes("b")) node = <strong>{node}</strong>;
        if (s.href) node = <a href={s.href} target="_blank" rel="noopener noreferrer nofollow">{node}</a>;
        return <span key={i}>{node}</span>;
      })}
    </>
  );
}

/** A Make-task line's task: its live status, and the way to it. */
export function TaskChip({ taskId, task, onOpen, tabbable = true }: { taskId: string; task?: Task; onOpen?: (id: string) => void; tabbable?: boolean }) {
  const label = task ? STATUS_META[task.status]?.label ?? "Task" : "Task";
  const name = task ? `Task: ${task.title}, ${label}` : "Linked task (not in this project's list)";
  return (
    <button type="button" className="kdoc-task" data-status={task?.status ?? "unknown"} contentEditable={false}
      tabIndex={tabbable ? 0 : -1} aria-label={onOpen ? `Open ${name}` : name} title={task ? `Open “${task.title}”` : "Open the task"}
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); onOpen?.(taskId); }} disabled={!onOpen}>
      {task ? <StatusGlyph status={task.status} size={14} readOnly /> : <Icon name="tasks" size={14} sw={1.75} />}
      <span className="kdoc-task-label">{label}</span>
    </button>
  );
}

function headingTag(type: DocBlock["type"]): "h3" | "h4" | "h5" {
  return type === "h1" ? "h3" : type === "h2" ? "h4" : "h5";
}

/** The doc's blocks, read only. */
export function DocBlocksView({ blocks, nameOf, tasks, onOpenTask, emptyText = "Nothing written yet." }: {
  blocks: readonly DocBlock[];
  nameOf?: NameOf;
  tasks?: ReadonlyMap<string, Task>;
  onOpenTask?: (taskId: string) => void;
  emptyText?: string;
}) {
  const real = blocks.filter((b) => b.type === "divider" || (b.spans ?? []).some((s) => s.text));
  if (!real.length) return <p className="kdoc-view-empty">{emptyText}</p>;
  const out: ReactNode[] = [];
  let i = 0;
  const chip = (b: DocBlock) => (b.taskId ? <TaskChip taskId={b.taskId} task={tasks?.get(b.taskId)} onOpen={onOpenTask} /> : null);
  while (i < blocks.length) {
    const b = blocks[i];
    if (isListType(b.type)) {
      const items: ReactNode[] = [];
      while (i < blocks.length && isListType(blocks[i].type)) {
        const li = blocks[i];
        const marker = li.type === "numbered"
          ? <span className="kdoc-marker" data-kind="number">{listNumber(blocks, i)}.</span>
          : li.type === "todo"
            ? <span className="kdoc-marker kdoc-check" data-kind="check" data-checked={!!li.checked} role="img" aria-label={li.checked ? "Done" : "Not done"}>
                {li.checked && <Icon name="check" size={12} sw={2.6} />}
              </span>
            : <span className="kdoc-marker" data-kind="bullet" aria-hidden="true" />;
        items.push(
          <li key={li.id} className="kdoc-block" data-type={li.type} data-indent={li.indent ?? 0} data-checked={li.type === "todo" ? !!li.checked : undefined}>
            {marker}
            <span className="kdoc-text"><SpansView spans={li.spans} nameOf={nameOf} /></span>
            {chip(li)}
          </li>,
        );
        i++;
      }
      out.push(<ul key={`l-${b.id}`} className="kdoc-list" role="list">{items}</ul>);
      continue;
    }
    const spans = <SpansView spans={b.spans} nameOf={nameOf} />;
    switch (b.type) {
      case "h1": case "h2": case "h3": {
        const H = headingTag(b.type);
        out.push(<div key={b.id} className="kdoc-block" data-type={b.type}><H className="kdoc-text">{spans}</H>{chip(b)}</div>);
        break;
      }
      case "quote":
        out.push(<blockquote key={b.id} className="kdoc-block" data-type="quote"><p className="kdoc-text">{spans}</p>{chip(b)}</blockquote>);
        break;
      case "callout":
        out.push(
          <div key={b.id} className="kdoc-block" data-type="callout" role="note">
            <span className="kdoc-callout-icon" aria-hidden="true">{b.icon || DEFAULT_CALLOUT_ICON}</span>
            <p className="kdoc-text">{spans}</p>{chip(b)}
          </div>,
        );
        break;
      case "divider":
        out.push(<hr key={b.id} className="kdoc-block kdoc-rule" data-type="divider" />);
        break;
      default:
        if (!(b.spans ?? []).some((s) => s.text)) { out.push(<div key={b.id} className="kdoc-block kdoc-gap" data-type="p" aria-hidden="true" />); break; }
        out.push(<div key={b.id} className="kdoc-block" data-type="p"><p className="kdoc-text">{spans}</p>{chip(b)}</div>);
    }
    i++;
  }
  return <div className="kdoc-view">{out}</div>;
}
