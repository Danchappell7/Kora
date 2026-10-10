/* ============================================================
   KANBO — demo Inbox items for calmer notifications (0048).   [u4]
   Three more realistic items for the demo world, so the demo Inbox shows a
   bundle and a kudos row:
     • Sana and Maya comment on the launch deck (with Theo's comment already
       in the seed: "3 comments on Finalise Q3 launch narrative deck from
       Sana, Maya and Theo")
     • Theo sends 🙌 for a task you finished yesterday, with a note
   The thread snooze the demo starts with (the staging mention, back
   tomorrow at nine) lives in lib/notifyPrefs.
   Integrator: add demoNotifyActivity() to the demo activity seed in
   store.ts (next to DEMO_ACTIVITY); ids are stable, so a re-seed is safe.
   ============================================================ */
import type { Activity } from "../data/types";
import { TASKS } from "../data/data";

const ago = (now: number, minutes: number) => new Date(now - minutes * 60_000).toISOString();
const titleOf = (id: string, fallback: string) => TASKS.find((t) => t.id === id)?.title ?? fallback;

/** Newest first. */
export function demoNotifyActivity(now: number = Date.now()): Activity[] {
  const deck = "t-1";
  const deckTitle = titleOf(deck, "Finalise Q3 launch narrative deck");
  // the demo person's own finished task (Pulse's "done since yesterday")
  const won = TASKS.find((t) => t.id === "t-12" && t.status === "done") ?? TASKS.find((t) => t.status === "done" && t.assigneeId === "m-self");
  const items: Activity[] = [
    { id: "a-demo-n1", taskId: deck, taskTitle: deckTitle, kind: "comment", detail: "Sana Rao", createdAt: ago(now, 18) },
    { id: "a-demo-n2", taskId: deck, taskTitle: deckTitle, kind: "comment", detail: "Maya Lin", createdAt: ago(now, 52) },
  ];
  if (won) {
    items.push({
      id: "a-demo-n3", taskId: won.id, taskTitle: won.title, kind: "kudos", detail: "Theo Vance", createdAt: ago(now, 95),
      meta: { kudosId: "kd-demo-1", emoji: "🙌", note: "Lovely work on this, thank you" },
    });
  }
  return items;
}
