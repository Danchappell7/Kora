/* ============================================================
   KANBO — toast notifications (replaces alert())
   ============================================================ */
import { createContext, useCallback, useContext, useState, type ReactNode } from "react";

type ToastType = "error" | "success" | "info";
interface ToastItem { id: number; message: string; type: ToastType }

interface ToastApi {
  toast: (message: string, type?: ToastType) => void;
  error: (message: string) => void;
  success: (message: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

let _id = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const remove = useCallback((id: number) => setItems((xs) => xs.filter((x) => x.id !== id)), []);

  const toast = useCallback((message: string, type: ToastType = "info") => {
    const id = ++_id;
    setItems((xs) => [...xs, { id, message, type }]);
    setTimeout(() => remove(id), type === "error" ? 7000 : 4000);
  }, [remove]);

  const api: ToastApi = {
    toast,
    error: useCallback((m: string) => toast(m, "error"), [toast]),
    success: useCallback((m: string) => toast(m, "success"), [toast]),
  };

  const color = (t: ToastType) => t === "error" ? "var(--st-blocked)" : t === "success" ? "var(--st-done)" : "var(--accent)";

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div role="status" aria-live="polite" style={{ position: "fixed", bottom: 20, right: 20, zIndex: 300, display: "flex", flexDirection: "column", gap: 10, maxWidth: "calc(100vw - 40px)", pointerEvents: "none" }}>
        {items.map((it) => (
          <div key={it.id} className="glass anim-fadeup" style={{ pointerEvents: "auto", display: "flex", alignItems: "flex-start", gap: 11, padding: "12px 14px", borderRadius: 13, width: 340, maxWidth: "100%", background: "var(--surface-raised)", boxShadow: "var(--shadow-lg)", borderLeft: `3px solid ${color(it.type)}` }}>
            <span style={{ width: 8, height: 8, borderRadius: 99, marginTop: 5, flexShrink: 0, background: color(it.type) }} />
            <p style={{ margin: 0, flex: 1, fontSize: 13.5, lineHeight: 1.45, color: "var(--ink-2)" }}>{it.message}</p>
            <button onClick={() => remove(it.id)} aria-label="Dismiss" style={{ border: "none", background: "transparent", color: "var(--ink-4)", cursor: "pointer", padding: 0, fontSize: 16, lineHeight: 1 }}>×</button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within ToastProvider");
  return ctx;
}
