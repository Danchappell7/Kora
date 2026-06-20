import { useState, useEffect, useRef } from "react";

export interface FocusTimer {
  running: boolean;
  setRunning: React.Dispatch<React.SetStateAction<boolean>>;
  seconds: number;
  reset: () => void;
  targetMin: number;
  setTargetMin: (m: number) => void;
  taskId: string;
  setTaskId: (id: string) => void;
  weekMin: number;
  /** bank the current elapsed time into today's focus total, then reset. returns minutes banked. */
  endSession: () => number;
  /* pomodoro */
  pomodoro: boolean;
  setPomodoro: (v: boolean) => void;
  phase: "work" | "break";
  cyclesToday: number;
  focusMinToday: number;
}

const WORK_DEFAULT = 25;
const BREAK_MIN = 5;
const todayKey = () => { const d = new Date(); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; };
function loadStat(): { date: string; cycles: number; min: number } {
  try { const v = JSON.parse(localStorage.getItem("kanbo-focus-stat") || "{}"); if (v && v.date === todayKey()) return v; } catch { /* private mode */ }
  return { date: todayKey(), cycles: 0, min: 0 };
}

/* ---- deep-work timer hook (with optional Pomodoro cycles) ---- */
export function useFocusTimer(): FocusTimer {
  const [running, setRunning] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [targetMin, setTargetMin] = useState(90);
  const [taskId, setTaskId] = useState("");
  const [pomodoro, setPomodoroState] = useState(false);
  const [phase, setPhase] = useState<"work" | "break">("work");
  const [stat, setStat] = useState(loadStat);
  const statRef = useRef(stat); statRef.current = stat;
  const weekMin = 0;

  const persist = (s: { date: string; cycles: number; min: number }) => {
    statRef.current = s; setStat(s);
    try { localStorage.setItem("kanbo-focus-stat", JSON.stringify(s)); } catch { /* private mode */ }
  };

  // tick
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [running]);

  // pomodoro phase transitions — fire when the current interval elapses
  useEffect(() => {
    if (!pomodoro || !running) return;
    if (seconds < targetMin * 60) return;
    if (phase === "work") {
      persist({ date: todayKey(), cycles: statRef.current.cycles + 1, min: statRef.current.min + targetMin });
      setPhase("break"); setTargetMin(BREAK_MIN); setSeconds(0);
    } else {
      setPhase("work"); setTargetMin(WORK_DEFAULT); setSeconds(0);
    }
  }, [seconds, pomodoro, running, targetMin, phase]);

  const setPomodoro = (v: boolean) => {
    setPomodoroState(v); setSeconds(0); setPhase("work"); setTargetMin(v ? WORK_DEFAULT : 90);
  };
  const reset = () => { setSeconds(0); setRunning(false); if (pomodoro) setPhase("work"); };

  // Stop & bank: add the elapsed minutes to today's focus total, then reset.
  // (Pomodoro completed work-phases are already banked; `seconds` only holds
  // the current unbanked interval, so there's no double-counting.)
  const endSession = (): number => {
    const mins = Math.round(seconds / 60);
    if (mins > 0) {
      const base = statRef.current.date === todayKey() ? statRef.current : { date: todayKey(), cycles: 0, min: 0 };
      persist({ date: todayKey(), cycles: base.cycles, min: base.min + mins });
    }
    setSeconds(0); setRunning(false); if (pomodoro) setPhase("work");
    return mins;
  };

  return {
    running, setRunning, seconds, reset, targetMin, setTargetMin, taskId, setTaskId, weekMin, endSession,
    pomodoro, setPomodoro, phase, cyclesToday: stat.cycles, focusMinToday: stat.min,
  };
}
