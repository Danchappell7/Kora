/* ============================================================
   KANBO — the demo's teammates, live.                      [0048, u5]
   Demo mode has no Realtime, so presence comes from a small script set in
   the Foundrise week (lib/presence's hub loads this on first use):
     • Maya has "Finalise Q3 launch narrative deck" (t-1) open;
     • Theo has "Ship onboarding redesign to staging" (t-2) open, and the
       first time you open it he starts a comment ("Theo is typing…");
     • Sana is in the "Launch brief" doc: her caret sits in it, and the
       first time you open it she adds a line under "Risks and open
       questions", letter by letter, then saves (as her, in the demo's
       memory), so the "edited by Sana" highlight and the save merge both
       show for real;
     • all three show on the Q3 Product Launch channel (list rows, the
       project header) with what they have open.
   Each script runs once per page load. Nothing leaves the browser.
   ============================================================ */
import type { DocBlock } from "../../data/types";
import { getMember } from "../../data/data";
import { newBlockId } from "../../lib/docBlocks";
import { demoSaveAs, getProjectDoc } from "../../lib/docs";
import type { PresenceTransport, TransportChannel, TransportHandlers, WirePresence } from "./core";

type Who = "m-1" | "m-2" | "m-3";
const SCRIPT_DOC = "doc-launch-brief";
const LINE = "Legal have the pricing page copy; sign-off is booked for Wednesday.";

/** who's where, per channel */
function cast(kind: string, id: string): { who: Who; state: WirePresence["state"]; taskId?: string; docId?: string }[] {
  if (kind === "task" && id === "t-1") return [{ who: "m-1", state: "viewing" }];
  if (kind === "task" && id === "t-2") return [{ who: "m-2", state: "viewing" }];
  if (kind === "doc" && id === SCRIPT_DOC) return [{ who: "m-3", state: "editing" }];
  if (kind === "project" && id === "p-launch") {
    return [{ who: "m-1", state: "viewing", taskId: "t-1" }, { who: "m-2", state: "viewing", taskId: "t-2" }, { who: "m-3", state: "editing", docId: SCRIPT_DOC }];
  }
  return [];
}

const ran = new Set<string>();
const person = (who: Who) => {
  const m = getMember(who);
  return { userId: who, name: m?.name ?? "A teammate", color: m?.color ?? "", clientId: `demo-${who}` };
};

export function demoTransport(): PresenceTransport {
  return {
    open(topic: string, h: TransportHandlers): TransportChannel {
      const [, kind = "", ...rest] = topic.split(":");
      const id = rest.join(":");
      const timers: ReturnType<typeof setTimeout>[] = [];
      const later = (ms: number, fn: () => void) => { timers.push(setTimeout(fn, ms)); };
      let closed = false;
      let mine: WirePresence | null = null;
      const caret: { blockId: string; offset: number } | null = null as { blockId: string; offset: number } | null;
      let docCaret = caret;
      const entries = () => cast(kind, id).map((c): WirePresence => ({
        ...person(c.who), state: c.state, taskId: c.taskId ?? null, docId: c.docId ?? null,
        caret: c.who === "m-3" && kind === "doc" ? docCaret : null, at: beatAt,
      }));
      let beatAt = Date.now();
      const sync = () => { if (!closed) h.onSync([...entries(), ...(mine ? [mine] : [])]); };
      later(350, () => { if (closed) return; h.onStatus("live"); sync(); });
      // their heartbeat
      const beat = setInterval(() => { beatAt = Date.now(); sync(); }, 15_000);

      // Theo starts a comment on t-2
      if (kind === "task" && id === "t-2" && !ran.has(topic)) {
        ran.add(topic);
        const theo = person("m-2");
        const say = (on: boolean) => h.onBroadcast("typing", { ...theo, on, at: Date.now() });
        later(2200, () => say(true));
        later(3700, () => say(true));
        later(5200, () => say(true));
        later(6400, () => say(false));
      }

      // Sana writes a line in the launch brief, then saves
      if (kind === "doc" && id === SCRIPT_DOC) {
        const sana = person("m-3");
        void getProjectDoc(SCRIPT_DOC).then((doc) => {
          if (closed || !doc || !doc.body.length) return;
          const last = doc.body[doc.body.length - 1];
          docCaret = { blockId: last.id, offset: (last.spans ?? []).reduce((n, s) => n + s.text.length, 0) };
          sync();
          if (ran.has(topic)) return;
          ran.add(topic);
          const block: DocBlock = { id: newBlockId(), type: "bullet", spans: [] };
          let seq = Date.now();
          const send = (ops: unknown[]) => h.onBroadcast("ops", { docId: SCRIPT_DOC, ...sana, seq: (seq = Math.max(seq + 1, Date.now())), baseVersion: doc.updatedAt, ops, at: Date.now() });
          const caretTo = (offset: number) => h.onBroadcast("caret", { ...sana, caret: { blockId: block.id, offset } });
          later(3500, () => { send([{ t: "insert", block, afterId: last.id }]); docCaret = { blockId: block.id, offset: 0 }; caretTo(0); });
          let t = 3500;
          for (let n = 3; n < LINE.length + 3; n += 3) {
            const text = LINE.slice(0, Math.min(n, LINE.length));
            t += 110 + (text.endsWith(" ") ? 90 : 0);
            later(t, () => { send([{ t: "update", block: { ...block, spans: [{ text }] } }]); docCaret = { blockId: block.id, offset: text.length }; caretTo(text.length); });
          }
          later(t + 1400, () => {
            void demoSaveAs(SCRIPT_DOC, (body) => {
              const i = body.findIndex((b) => b.id === last.id);
              const done: DocBlock = { ...block, spans: [{ text: LINE }] };
              const rest = body.filter((b) => b.id !== block.id);
              rest.splice(i >= 0 ? i + 1 : rest.length, 0, done);
              return rest;
            }, "m-3");
          });
        });
      }

      return {
        track: (state) => { mine = state; queueMicrotask(sync); },
        untrack: () => { mine = null; queueMicrotask(sync); },
        send: () => !closed,
        close: () => { closed = true; clearInterval(beat); timers.forEach(clearTimeout); },
      };
    },
  };
}
