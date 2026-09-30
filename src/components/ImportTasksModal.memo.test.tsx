import { it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

// count analyses without changing what they return
const counter = vi.hoisted(() => ({ calls: 0 }));
vi.mock("../lib/importTasks", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../lib/importTasks")>();
  return { ...mod, analyseImport: (...args: Parameters<typeof mod.analyseImport>) => { counter.calls++; return mod.analyseImport(...args); } };
});
import { ImportTasksModal } from "./ImportTasksModal";

it("doesn't re-analyse when the parent re-renders with equal (but new) arrays", () => {
  // App rebuilds projects/members on every render (realtime updates, the focus timer)
  const props = () => ({ projects: [{ id: "p-web", name: "Website" }], members: [{ id: "u1", name: "Sarah Jones" }], defaultProjectId: "p-web" });
  const { rerender } = render(<ImportTasksModal open onClose={() => {}} onImport={() => {}} {...props()} />);
  fireEvent.change(screen.getByLabelText("Tasks to import"), { target: { value: "Book venue\nSend invites" } });
  const before = counter.calls;
  for (let i = 0; i < 5; i++) rerender(<ImportTasksModal open onClose={() => {}} onImport={() => {}} {...props()} />);
  expect(counter.calls - before).toBe(0);
  // a real change (a project renamed) is still picked up
  rerender(<ImportTasksModal open onClose={() => {}} onImport={() => {}} {...props()} projects={[{ id: "p-web", name: "Website v2" }]} />);
  expect(counter.calls - before).toBe(1);
  expect(screen.getByText("Into Website v2")).toBeInTheDocument();
});
