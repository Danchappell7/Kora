import { useState, useEffect } from "react";

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
}

/* ---- deep-work timer hook ---- */
export function useFocusTimer(): FocusTimer {
  const [running, setRunning] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [targetMin, setTargetMin] = useState(90);
  const [taskId, setTaskId] = useState("t-1");
  const weekMin = 118;
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [running]);
  const reset = () => { setSeconds(0); setRunning(false); };
  return { running, setRunning, seconds, reset, targetMin, setTargetMin, taskId, setTaskId, weekMin };
}
