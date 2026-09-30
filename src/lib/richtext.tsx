/* ============================================================
   KANBO — lightweight markdown-ish renderer for task descriptions
   and comments: **bold**, *italic*, `code`, [links](url), bare
   http(s):// and www. autolinks, - bullets, line breaks, and @Name
   mention highlighting.
   ============================================================ */
import type { CSSProperties, ReactNode } from "react";

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// C0/C1 controls, DEL and invisible format characters (soft hyphen,
// zero-width spaces/joiners, bidi overrides, word joiners, BOM). Browsers drop
// tabs/newlines inside URLs, so "java\tscript:" would otherwise slip past a
// scheme test; the invisible ones let a link look different from where it goes.
// eslint-disable-next-line no-control-regex
const INVISIBLE = /[\u0000-\u001F\u007F-\u009F­​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;
// "acme.com/spec", "www.acme.com", "docs.acme.co.uk:8443/x" — a scheme-less host
const HOST = /^(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?\.)+\p{L}{2,63}(?::\d{1,5})?(?:[/?#]|$)/iu;
const EMAIL = /^[^\s@/:?#]+@(?:[\p{L}\p{N}-]+\.)+\p{L}{2,63}$/iu;

/**
 * Turn a user-authored link target into a safe href, or null when it isn't
 * one. Descriptions and comments are shared with the whole team, so this is a
 * stored-XSS guard as well as a "make the link go where the author meant" fix:
 *  - C0/C1 controls and invisible characters are stripped and the ends trimmed
 *    BEFORE the scheme test (so "java\u0000script:" can't sneak through);
 *  - only http, https, mailto and tel schemes are allowed — everything else
 *    (javascript:, data:, vbscript:, file:, …) is rejected;
 *  - scheme-less hosts ("www.acme.com/spec", "acme.com:8080") get https:// so
 *    they don't resolve as a path inside Kanbo; bare emails get mailto:;
 *  - explicit same-origin paths ("/…", "#…", "?…") are kept — they can't carry
 *    a scheme ("/\\host", which browsers read as "//host", is not one).
 */
export function safeHref(raw: string): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw.replace(INVISIBLE, "").trim();
  // inner spaces: dropped from phone numbers, encoded everywhere else
  const u = /^tel:/i.test(cleaned) ? cleaned.replace(/\s+/g, "") : cleaned.replace(/\s+/g, "%20");
  if (!u) return null;
  const scheme = u.match(/^([a-z][a-z0-9+.-]*):/i);
  if (scheme) {
    const s = scheme[1].toLowerCase();
    if (s === "http" || s === "https") return /^https?:\/\/[^/?#\\]/i.test(u) ? u : null; // must name a host
    if (s === "mailto" || s === "tel") return u.length > s.length + 1 ? u : null;
    // "acme.com:8080/x" parses as scheme "acme.com" — it's really host:port
    if (HOST.test(u)) return "https://" + u;
    return null;
  }
  if (u.startsWith("//")) return /^\/\/[^/?#\\]/.test(u) ? "https:" + u : null; // protocol-relative
  if (/^(?:\/(?![/\\])|[#?])/.test(u)) return u; // "/path", "#anchor", "?q" — but not "/\\host"
  if (HOST.test(u)) return "https://" + u;
  if (EMAIL.test(u)) return "mailto:" + u;
  return null; // "spec", "my notes" — not a destination, render the label as text
}

/** Trim sentence punctuation (and unbalanced closing brackets) off the end of
 *  an autolinked URL: "see https://x.com/a." → "https://x.com/a", but
 *  "https://en.wikipedia.org/wiki/Foo_(bar)" keeps its closing paren. */
function trimAutolink(u: string): string {
  let s = u;
  const pairs: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
  for (;;) {
    const last = s[s.length - 1];
    if (!last) break;
    if (/[.,;:!?'"*_~`>]/.test(last)) { s = s.slice(0, -1); continue; }
    const open = pairs[last];
    if (open) {
      const opens = s.split(open).length - 1, closes = s.split(last).length - 1;
      if (closes > opens) { s = s.slice(0, -1); continue; }
    }
    break;
  }
  return s;
}

const LINK_STYLE: CSSProperties = { color: "var(--accent)", textDecoration: "underline", textUnderlineOffset: 2, overflowWrap: "anywhere" };

function link(key: string, href: string, label: ReactNode, title?: string): ReactNode {
  return (
    <a key={key} href={href} target="_blank" rel="noopener noreferrer" title={title}
      onClick={(e) => e.stopPropagation()} style={LINK_STYLE}>{label}</a>
  );
}

function inline(s: string, names: string[], keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  const mentionAlt = names.length ? "|@(?:" + names.map(esc).sort((a, b) => b.length - a.length).join("|") + ")" : "";
  const re = new RegExp(
    "(\\*\\*[^*]+\\*\\*|\\*[^*\\s][^*]*\\*|`[^`]+`" +
    "|\\[[^\\]]+\\]\\((?:[^()]|\\([^()]*\\))+\\)" + // [label](url) — one level of (parens) in the url
    "|(?:[hH][tT][tT][pP][sS]?:\\/\\/|[wW]{3}\\.)[^\\s<>]+" + // bare URL (trimmed below)
    mentionAlt + ")", "g");
  let last = 0, m: RegExpExecArray | null, k = 0;
  while ((m = re.exec(s))) {
    let tok = m[0];
    const key = keyBase + "-" + k++;
    if (/^(?:https?:\/\/|www\.)/i.test(tok)) {
      // bare URL: only when it starts a word ("foo.www.x" / "a@www.x" stay text)
      const prev = m.index > 0 ? s[m.index - 1] : "";
      tok = trimAutolink(tok);
      const href = prev && /[\p{L}\p{N}_.@/\\-]/u.test(prev) ? null : safeHref(tok);
      if (!href || /^(?:https?:\/\/|www\.)$/i.test(tok)) continue; // not a link — leave it in the plain-text run
      if (m.index > last) out.push(s.slice(last, m.index));
      out.push(link(key, href, tok));
      last = m.index + tok.length;
      re.lastIndex = last;
      continue;
    }
    if (m.index > last) out.push(s.slice(last, m.index));
    if (tok.startsWith("**")) out.push(<strong key={key}>{inline(tok.slice(2, -2), names, key)}</strong>);
    else if (tok.startsWith("`")) out.push(<code key={key} style={{ fontFamily: "var(--font-mono)", fontSize: "0.88em", background: "var(--surface-2)", padding: "1px 5px", borderRadius: 5 }}>{tok.slice(1, -1)}</code>);
    else if (tok.startsWith("[")) {
      const mm = tok.match(/^\[([^\]]+)\]\(((?:[^()]|\([^()]*\))+)\)$/);
      const href = mm ? safeHref(mm[2]) : null;
      if (mm && href) out.push(link(key, href, mm[1], href));
      else out.push(<span key={key}>{mm ? mm[1] : tok}</span>);
    }
    else if (tok.startsWith("@")) out.push(<strong key={key} style={{ color: "var(--accent)", fontWeight: 600 }}>{tok}</strong>);
    else if (tok.startsWith("*")) out.push(<em key={key}>{inline(tok.slice(1, -1), names, key)}</em>);
    last = m.index + tok.length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}

export function renderRich(text: string, mentionNames: string[] = []): ReactNode {
  if (!text) return null;
  const lines = text.split("\n");
  const blocks: ReactNode[] = [];
  let listBuf: ReactNode[] = [];
  const flush = (key: string) => { if (listBuf.length) { blocks.push(<ul key={"ul-" + key} style={{ margin: "4px 0", paddingLeft: 20 }}>{listBuf}</ul>); listBuf = []; } };
  lines.forEach((line, i) => {
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    if (bullet) { listBuf.push(<li key={"li-" + i} style={{ marginBottom: 2 }}>{inline(bullet[1], mentionNames, "li" + i)}</li>); return; }
    flush(String(i));
    if (line.trim() === "") blocks.push(<div key={"sp-" + i} style={{ height: 7 }} />);
    else blocks.push(<p key={"p-" + i} style={{ margin: 0, lineHeight: 1.55 }}>{inline(line, mentionNames, "p" + i)}</p>);
  });
  flush("end");
  return blocks;
}
