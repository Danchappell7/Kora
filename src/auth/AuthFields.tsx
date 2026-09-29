/* ============================================================
   KANBO — form fields for sign-in, sign-up and onboarding.
   A visible field in both themes (the porcelain card is near-white,
   so a surface-coloured input with a hairline border all but
   disappears), a clear focus ring, and a password field with a
   show/hide toggle. Global --field-* tokens win when defined.
   ============================================================ */
import { forwardRef, useId, useState, type CSSProperties, type InputHTMLAttributes } from "react";

export const FIELD_BG = "var(--field-bg, color-mix(in oklch, var(--bg) 50%, var(--surface-solid)))";
export const FIELD_BORDER = "var(--field-border, color-mix(in oklch, var(--ink-4) 50%, transparent))";

export function fieldStyle(focused: boolean, invalid?: boolean): CSSProperties {
  return {
    width: "100%", height: 44, padding: "0 14px", borderRadius: 11,
    border: `1px solid ${invalid ? "var(--prio-urgent)" : focused ? "var(--accent)" : FIELD_BORDER}`,
    boxShadow: focused ? `0 0 0 3px color-mix(in oklch, ${invalid ? "var(--prio-urgent)" : "var(--accent)"} 26%, transparent)` : "none",
    background: FIELD_BG, color: "var(--ink)", fontFamily: "var(--font-display)", fontSize: 14,
    // the ring above is the focus indicator, so the UA outline is redundant
    outline: "none",
    transition: "border-color .15s var(--ease), box-shadow .15s var(--ease)",
  };
}

type FieldProps = InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean };

export const TextField = forwardRef<HTMLInputElement, FieldProps>(function TextField({ style, onFocus, onBlur, invalid, ...rest }, ref) {
  const [focused, setFocused] = useState(false);
  return (
    <input
      ref={ref}
      {...rest}
      aria-invalid={invalid || undefined}
      onFocus={(e) => { setFocused(true); onFocus?.(e); }}
      onBlur={(e) => { setFocused(false); onBlur?.(e); }}
      style={{ ...fieldStyle(focused, invalid), ...style }}
    />
  );
});

/** Password input with a show/hide toggle. Pass `revealed` + `onToggleReveal`
 *  to drive several fields from one toggle (new + confirm password). */
export const PasswordField = forwardRef<HTMLInputElement, Omit<FieldProps, "type"> & {
  revealed?: boolean;
  onToggleReveal?: () => void;
  /** hide this field's own toggle (e.g. the confirm field follows the first one) */
  hideToggle?: boolean;
}>(function PasswordField({ revealed, onToggleReveal, hideToggle, style, id, ...rest }, ref) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const [own, setOwn] = useState(false);
  const shown = revealed ?? own;
  const toggle = onToggleReveal ?? (() => setOwn((v) => !v));
  return (
    <div style={{ position: "relative" }}>
      <TextField ref={ref} id={inputId} {...rest} type={shown ? "text" : "password"} style={{ paddingRight: hideToggle ? 14 : 46, ...style }} />
      {!hideToggle && (
        <button
          type="button"
          onClick={toggle}
          aria-label={shown ? "Hide password" : "Show password"}
          aria-pressed={shown}
          aria-controls={inputId}
          title={shown ? "Hide password" : "Show password"}
          style={{ position: "absolute", top: 4, right: 4, width: 36, height: 36, display: "grid", placeItems: "center", border: "none", borderRadius: 9, background: "transparent", color: "var(--ink-3)", cursor: "pointer" }}
        >
          <EyeIcon off={shown} />
        </button>
      )}
    </div>
  );
});

function EyeIcon({ off }: { off: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.5 12S6 5 12 5s9.5 7 9.5 7-3.5 7-9.5 7S2.5 12 2.5 12z" />
      <circle cx="12" cy="12" r="3" />
      {off && <path d="M4 20 20 4" />}
    </svg>
  );
}
