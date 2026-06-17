import { useEffect, useRef } from "react";

/**
 * Traps Tab focus within the returned ref'd element while `active`, and
 * restores focus to the previously-focused element on close. Does NOT set
 * initial focus — components keep their own autofocus.
 */
export function useFocusTrap<T extends HTMLElement>(active: boolean, onEscape?: () => void) {
  const ref = useRef<T>(null);
  // keep the latest onEscape without making it an effect dependency — callers
  // usually pass an inline arrow, which would otherwise re-run the effect every
  // render and steal focus back to the previously-focused element.
  const escRef = useRef(onEscape);
  escRef.current = onEscape;
  useEffect(() => {
    if (!active) return;
    const el = ref.current;
    if (!el) return;
    const prev = document.activeElement as HTMLElement | null;
    const focusable = () =>
      Array.from(
        el.querySelectorAll<HTMLElement>(
          'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])',
        ),
      ).filter((e) => e.offsetParent !== null);

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { escRef.current?.(); return; }
      if (e.key !== "Tab") return;
      const items = focusable();
      if (!items.length) return;
      const first = items[0], last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    el.addEventListener("keydown", onKey);
    return () => { el.removeEventListener("keydown", onKey); prev?.focus?.(); };
  }, [active]);
  return ref;
}
