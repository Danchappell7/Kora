import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import type { TaskDropTargetOptions } from "../../lib/dnd";
import type { Task, WorkspaceMember } from "../../data/types";

/* the drag kit is u3's: capture what the people rows register */
const targets: TaskDropTargetOptions[] = [];
vi.mock("../../lib/dnd", async (orig) => {
  const real = await orig<typeof import("../../lib/dnd")>();
  return {
    ...real,
    useTaskDropTarget: (o: TaskDropTargetOptions) => {
      targets.push(o);
      return { bind: { ref: () => undefined, "data-kdnd-target": o.disabled ? undefined : o.target.kind }, isOver: false, canDrop: false, payload: null };
    },
  };
});
const { TeamView } = await import("./TeamView");

const WS = "ws-foundrise";
const member = (p: Partial<WorkspaceMember> & { id: string }): WorkspaceMember => ({
  workspaceId: WS, userId: null, email: "x@kanbo.app", name: "", role: "member", status: "active", ...p,
});
const MEMBERS = [
  member({ id: "w1", userId: "m-1", email: "maya@kanbo.app" }),
  member({ id: "w2", userId: "m-3", email: "sana@kanbo.app", role: "admin" }),
  member({ id: "w3", email: "new@kanbo.app", status: "invited" }),
];
const task = { id: "t1", title: "Q3 budget", projectId: "p-launch", status: "todo", assigneeId: "m-1", aiScore: 1 } as unknown as Task;
const latest = (userId: string) => targets.filter((t) => t.target.kind === "person" && t.target.id === userId).slice(-1)[0];

beforeEach(() => { localStorage.clear(); targets.length = 0; });

describe("TeamView › people take dropped tasks", () => {
  it("each active person's row is a “person” target named after them; a drop reassigns through the host", () => {
    const onDropTasksOnPerson = vi.fn();
    const { container } = render(<TeamView tasks={[task]} workspace={WS} currentUserId="m-self" myRole="owner" members={MEMBERS}
      workspaces={[{ id: WS, name: "Foundrise", ownerId: "m-self" }]} onInvite={vi.fn()} onRemoveMember={vi.fn()} onDropTasksOnPerson={onDropTasksOnPerson} />);
    const sana = latest("m-3")!;
    expect(sana.target.label).toBe("Sana Rao");
    expect(sana.disabled).toBe(false);
    sana.onDrop({ payload: { taskIds: ["t1"], source: "today", originId: "t1" }, target: sana.target, point: null, within: null, via: "keyboard" });
    expect(onDropTasksOnPerson).toHaveBeenCalledWith(["t1"], "m-3");
    expect(container.querySelectorAll('li.kppl-row[data-kdnd-target="person"]')).toHaveLength(2);
    // a pending invite has no one to hand work to yet
    expect(targets.filter((t) => t.target.kind === "person" && t.target.id === "").every((t) => t.disabled)).toBe(true);
  });

  it("guests (and hosts without a handler) get rows that take nothing", () => {
    render(<TeamView tasks={[task]} workspace={WS} currentUserId="m-self" myRole="guest" members={MEMBERS}
      onInvite={vi.fn()} onRemoveMember={vi.fn()} onDropTasksOnPerson={vi.fn()} />);
    expect(latest("m-1")!.disabled).toBe(true);
    targets.length = 0;
    render(<TeamView tasks={[task]} workspace={WS} currentUserId="m-self" myRole="owner" members={MEMBERS} onInvite={vi.fn()} onRemoveMember={vi.fn()} />);
    expect(latest("m-1")!.disabled).toBe(true);
  });
});
