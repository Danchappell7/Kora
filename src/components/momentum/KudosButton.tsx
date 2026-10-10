/* ============================================================
   KANBO — one-tap kudos.                                         [u10]
   For a teammate's finished team task (Pulse's "Done since yesterday"
   rows, the task panel): tap → 🎉 sent ("Kudos sent to Sana", Undo);
   long-press / right-click / the caret → another emoji (KUDOS_EMOJI) and
   an optional note (≤ 140). Tap again to take it back. Shows how many
   kudos the task has (yours among them). A toggle button (aria-pressed)
   with a clear name; the caret is the keyboard and screen-reader way to
   the picker, so the long-press is never the only way in.
   Hidden for your own tasks (KudosTally shows what you got instead),
   unfinished ones, Personal ones and tasks nobody owns. Suspended people
   never reach the app; guests may give kudos (a reaction, not content).
   Optimistic: the count moves at once and goes back if the server says
   no (with the reason). onChange gets the task's kudos after each change.
   ============================================================ */
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import type { Kudos, KudosEmoji, Task } from "../../data/types";
import { Avatar, Button, Icon } from "../primitives";
import { Popover } from "../primitives/Popover";
import { useOptionalToast } from "../rituals/shared";
import { canGiveKudos, giveKudos, kudosErrorText, kudosFailure, KUDOS_EMOJI, KUDOS_NOTE_MAX, nameList, rememberKudosTask, takeBackKudos } from "../../lib/momentum";
import { firstWord, nameFrom, trapTab } from "./shared";
import "./momentum.css";

export interface KudosButtonProps {
  task: Pick<Task, "id" | "title" | "status" | "assigneeId" | "workspaceId">;
  currentUserId: string;
  /** "Sana" — who it's for */
  recipientName: string;
  /** every kudos on this task (yours among them, if given) */
  kudos: Kudos[];
  size?: "sm" | "md";
  disabled?: boolean;
  onChange?: (next: Kudos[]) => void;
  /** (optional) names for the "who sent kudos" list: workspace members; default: the app's directory */
  people?: readonly { id?: string; userId?: string | null; name?: string; email?: string }[];
}

/** What a screen reader calls each emoji. */
export const KUDOS_EMOJI_NAMES: Readonly<Record<KudosEmoji, string>> = {
  "🎉": "Party popper", "👏": "Clapping hands", "🙌": "Raised hands", "💪": "Flexed arm", "⭐": "Star",
  "🚀": "Rocket", "❤️": "Heart", "🔥": "Fire", "💯": "Hundred points", "🏆": "Trophy",
};

const LONG_PRESS_MS = 450;
const POP_MS = 450;
/** a list's identity for the optimistic override: ids and emoji, in order */
const sigOf = (list: readonly Kudos[]) => list.map((k) => `${k.id}:${k.emoji}:${k.note ?? ""}`).join("|");

export function KudosButton({ task, currentUserId, recipientName, kudos, size = "sm", disabled, onChange, people }: KudosButtonProps) {
  const toast = useOptionalToast();
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const wrapRef = useRef<HTMLSpanElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  // the host's list, unless a change made here hasn't reached it yet
  const given = useMemo(() => kudos.filter((k) => k.taskId === task.id), [kudos, task.id]);
  const baseSig = sigOf(given);
  const [override, setOverride] = useState<{ base: string; next: Kudos[] } | null>(null);
  const shown = override && override.base === baseSig ? override.next : given;
  const mine = shown.find((k) => k.fromUser === currentUserId);
  const others = shown.filter((k) => k.fromUser !== currentUserId);

  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [pop, setPop] = useState(false);
  const [say, setSay] = useState("");
  const popTimer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(popTimer.current), []);

  const who = firstWord(recipientName);
  // (the host hears about it even when this button has gone, e.g. an Undo after the row left)
  const settle = (next: Kudos[]) => {
    if (alive.current) setOverride({ base: baseSig, next });
    onChange?.(next);
  };
  const tell = (text: string, tone: "ok" | "error" = "ok") => {
    if (toast) { if (tone === "error") toast.error(text); else toast.success(text); }
    else setSay(text);
  };

  const give = async (emoji: KudosEmoji = "🎉", note: string | null = null, opts: { replace?: boolean } = {}) => {
    if (busy || disabled) return;
    const before = shown;
    const rest = before.filter((k) => k.fromUser !== currentUserId);
    const provisional: Kudos = {
      id: `pending-${task.id}`, taskId: task.id, workspaceId: task.workspaceId ?? "", fromUser: currentUserId, toUser: task.assigneeId,
      emoji, note: note?.trim() || null, createdAt: new Date().toISOString(),
    };
    setBusy(true);
    setOverride({ base: baseSig, next: [...rest, provisional] });
    rememberKudosTask({ id: task.id, title: task.title, status: task.status, assigneeId: task.assigneeId, workspaceId: task.workspaceId ?? null });
    let tookBack = false;
    try {
      if (opts.replace && before.some((k) => k.fromUser === currentUserId)) { await takeBackKudos(task.id); tookBack = true; }
      const k = await giveKudos(task.id, emoji, note);
      const next = [...rest, k];
      settle(next);
      if (!alive.current) return;
      setPop(true);
      clearTimeout(popTimer.current);
      popTimer.current = setTimeout(() => { if (alive.current) setPop(false); }, POP_MS);
      const msg = opts.replace ? `Kudos updated for ${who}` : `Kudos sent to ${who}`;
      if (toast && !opts.replace) toast.action(msg, "Undo", () => { void takeBack({ quiet: true, from: next }); }, {});
      else tell(msg);
    } catch (e) {
      // (a change whose old kudos was already taken back: say so, rather than show it still there)
      if (tookBack) settle(rest);
      else if (alive.current) setOverride({ base: baseSig, next: before });
      if (!alive.current) return;
      tell(kudosErrorText(kudosFailure(e)), "error");
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const takeBack = async (opts: { quiet?: boolean; from?: Kudos[] } = {}) => {
    if (busy && !opts.from) return;
    const before = opts.from ?? shown;
    const next = before.filter((k) => k.fromUser !== currentUserId);
    setBusy(true);
    setOverride({ base: baseSig, next });
    try {
      await takeBackKudos(task.id);
      settle(next);
      if (!alive.current) return;
      tell(opts.quiet ? `Kudos to ${who} taken back` : "Kudos taken back");
    } catch (e) {
      if (!alive.current) return;
      setOverride({ base: baseSig, next: before });
      tell(kudosErrorText(kudosFailure(e)), "error");
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  /* long-press (touch) or right-click opens the picker; the caret does it for everyone */
  const press = useRef<{ timer: ReturnType<typeof setTimeout> | undefined; fired: boolean }>({ timer: undefined, fired: false });
  useEffect(() => () => clearTimeout(press.current.timer), []);
  const onPointerDown = (e: ReactPointerEvent<HTMLButtonElement>) => {
    press.current.fired = false;
    clearTimeout(press.current.timer);
    if (e.pointerType !== "touch" || disabled) return;
    press.current.timer = setTimeout(() => { press.current.fired = true; setOpen(true); }, LONG_PRESS_MS);
  };
  const endPress = () => clearTimeout(press.current.timer);
  const onMainClick = () => {
    if (press.current.fired) { press.current.fired = false; return; }   // that was a long-press
    if (mine) void takeBack();
    else void give("🎉");
  };

  if (!canGiveKudos(task, currentUserId)) return null;

  const n = shown.length;
  const face = mine?.emoji ?? others[others.length - 1]?.emoji ?? "🎉";
  const nameOf = (id: string) => (id === currentUserId ? "you" : firstWord(nameFrom(people, id)));
  const whoGave = n ? nameList([...others.map((k) => nameOf(k.fromUser)), ...(mine ? ["you"] : [])]) : "";
  const label = `Kudos for ${who}${n ? `, ${n} so far` : ""}`;
  const tip = mine ? `You sent ${mine.emoji}. Tap to take it back` : n ? `From ${whoGave}. Tap to add yours` : `Send ${who} kudos`;

  return (
    <span ref={wrapRef} className="kkudos" data-size={size} data-mine={mine ? "" : undefined} data-empty={n ? undefined : ""}
      data-open={open ? "" : undefined} data-busy={busy ? "" : undefined} data-pop={pop ? "" : undefined}>
      <button type="button" aria-pressed={!!mine} aria-label={label} title={tip} disabled={disabled}
        aria-describedby={whoGave ? `${uid}-who` : undefined}
        onClick={onMainClick} onPointerDown={onPointerDown} onPointerUp={endPress} onPointerCancel={endPress} onPointerLeave={endPress}
        onContextMenu={(e) => { if (disabled) return; e.preventDefault(); setOpen(true); }}>
        <span className="kkudos-emoji" aria-hidden="true">{face}</span>
        {n > 0 && <span className="kkudos-n" aria-hidden="true">{n}</span>}
      </button>
      <span className="kkudos-sep" aria-hidden="true" />
      <button ref={moreRef} type="button" className="kkudos-more" aria-label={mine ? `Change or take back your kudos for ${who}` : `Choose an emoji and add a note for ${who}`}
        aria-haspopup="dialog" aria-expanded={open} disabled={disabled} onClick={() => setOpen((o) => !o)}>
        <Icon name="chevronDown" size={12} sw={2} />
      </button>
      {whoGave && <span id={`${uid}-who`} className="sr-only">From {whoGave}</span>}
      {!toast && <span className="sr-only" role="status">{say}</span>}
      {open && (
        <KudosPicker anchorRef={moreRef} onClose={() => setOpen(false)} who={who} title={task.title} mine={mine ?? null} others={others}
          nameOf={(id) => nameFrom(people, id)} busy={busy}
          onSend={(emoji, note) => { setOpen(false); void give(emoji, note, { replace: !!mine }); }}
          onTakeBack={() => { setOpen(false); void takeBack(); }} />
      )}
    </span>
  );
}

/** The picker: ten emoji (a radio group: arrows move, the choice is the checked one), an optional note, who else sent kudos. */
function KudosPicker({ anchorRef, onClose, who, title, mine, others, nameOf, busy, onSend, onTakeBack }: {
  anchorRef: RefObject<HTMLElement>;
  onClose: () => void;
  who: string;
  title: string;
  mine: Kudos | null;
  others: Kudos[];
  nameOf: (id: string) => string;
  busy: boolean;
  onSend: (emoji: KudosEmoji, note: string | null) => void;
  onTakeBack: () => void;
}) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const [emoji, setEmoji] = useState<KudosEmoji>(mine?.emoji ?? "🎉");
  const [note, setNote] = useState(mine?.note ?? "");
  const checkedRef = useRef<HTMLButtonElement | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const opts = useRef<(HTMLButtonElement | null)[]>([]);
  const unchanged = !!mine && mine.emoji === emoji && (mine.note ?? "") === note.trim();

  const onGridKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const i = KUDOS_EMOJI.indexOf(emoji);
    const cols = 5;
    let j = -1;
    if (e.key === "ArrowRight") j = (i + 1) % KUDOS_EMOJI.length;
    else if (e.key === "ArrowLeft") j = (i - 1 + KUDOS_EMOJI.length) % KUDOS_EMOJI.length;
    else if (e.key === "ArrowDown") j = (i + cols) % KUDOS_EMOJI.length;
    else if (e.key === "ArrowUp") j = (i - cols + KUDOS_EMOJI.length) % KUDOS_EMOJI.length;
    else if (e.key === "Home") j = 0;
    else if (e.key === "End") j = KUDOS_EMOJI.length - 1;
    if (j < 0) return;
    e.preventDefault();
    setEmoji(KUDOS_EMOJI[j]);
    opts.current[j]?.focus();
  };
  const send = () => { if (!busy && !unchanged) onSend(emoji, note.trim() || null); };

  return (
    <Popover open anchorRef={anchorRef} onClose={onClose} role="dialog" label={`Kudos for ${who}`} align="end" minWidth={260} initialFocus={checkedRef}>
      <div ref={boxRef} className="kkudos-pop" onKeyDown={(e) => trapTab(e, boxRef.current)}>
        <p className="kkudos-pop-head">
          Kudos for {who}
          <span className="kkudos-pop-task">for “{title}”</span>
        </p>
        <div className="kkudos-grid" role="radiogroup" aria-label="Emoji" onKeyDown={onGridKey}>
          {KUDOS_EMOJI.map((e, i) => (
            <button key={e} ref={(el) => { opts.current[i] = el; if (e === emoji) checkedRef.current = el; }}
              type="button" role="radio" className="kkudos-opt" aria-checked={e === emoji} aria-label={KUDOS_EMOJI_NAMES[e]} tabIndex={e === emoji ? 0 : -1}
              onClick={() => setEmoji(e)}>
              <span aria-hidden="true">{e}</span>
            </button>
          ))}
        </div>
        <div className="kkudos-field">
          <label htmlFor={`${uid}-note`}>Note (optional)<span aria-hidden="true">{note.length}/{KUDOS_NOTE_MAX}</span></label>
          <input id={`${uid}-note`} className="kkudos-input" type="text" maxLength={KUDOS_NOTE_MAX} value={note} placeholder="Great work on this"
            aria-describedby={`${uid}-left`} autoComplete="off"
            onChange={(ev) => setNote(ev.target.value.slice(0, KUDOS_NOTE_MAX))}
            onKeyDown={(ev) => { if (ev.key === "Enter" && !ev.nativeEvent.isComposing) { ev.preventDefault(); send(); } }} />
          <span id={`${uid}-left`} className="sr-only">{KUDOS_NOTE_MAX - note.length} characters left</span>
        </div>
        {others.length > 0 && (
          <ul className="kkudos-who" aria-label="Kudos so far">
            {others.slice(-5).map((k) => (
              <li key={k.id}>
                <span aria-hidden="true"><Avatar id={k.fromUser} size={16} /></span>
                <span><b>{firstWord(nameOf(k.fromUser))}</b> <span aria-label={KUDOS_EMOJI_NAMES[k.emoji]} role="img">{k.emoji}</span>{k.note ? <> <q>{k.note}</q></> : null}</span>
              </li>
            ))}
            {others.length > 5 && <li><span>and {others.length - 5} more</span></li>}
          </ul>
        )}
        <div className="kkudos-acts">
          {mine && <Button size="sm" variant="ghost" onClick={onTakeBack} disabled={busy}>Take back</Button>}
          <Button size="sm" variant="primary" onClick={send} disabled={busy || unchanged}>{mine ? "Update" : "Send kudos"}</Button>
        </div>
      </div>
    </Popover>
  );
}

/** Your own finished task: what your teammates sent (read only). Nothing when there's none. */
export function KudosTally({ kudos, taskId, people }: { kudos: readonly Kudos[]; taskId: string; people?: KudosButtonProps["people"] }) {
  const list = kudos.filter((k) => k.taskId === taskId);
  if (!list.length) return null;
  const names = nameList(list.map((k) => firstWord(nameFrom(people, k.fromUser))));
  const face = list[list.length - 1].emoji;
  return (
    <span className="kkudos-tally" title={`Kudos from ${names}`}>
      <span className="kkudos-emoji" aria-hidden="true">{face}</span>
      <span className="kkudos-n" aria-hidden="true">{list.length}</span>
      <span className="sr-only">{list.length} kudos, from {names}</span>
    </span>
  );
}
