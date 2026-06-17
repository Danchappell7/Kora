/* ============================================================
   KANBO — lightweight markdown-ish renderer for task descriptions
   and comments: **bold**, *italic*, `code`, [links](url), - bullets,
   line breaks, and @Name mention highlighting.
   ============================================================ */
import type { ReactNode } from "react";

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function inline(s: string, names: string[], keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  const mentionAlt = names.length ? "|@(?:" + names.map(esc).sort((a, b) => b.length - a.length).join("|") + ")" : "";
  const re = new RegExp("(\\*\\*[^*]+\\*\\*|\\*[^*\\s][^*]*\\*|`[^`]+`|\\[[^\\]]+\\]\\([^)]+\\)" + mentionAlt + ")", "g");
  let last = 0, m: RegExpExecArray | null, k = 0;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(s.slice(last, m.index));
    const tok = m[0]; const key = keyBase + "-" + k++;
    if (tok.startsWith("**")) out.push(<strong key={key}>{tok.slice(2, -2)}</strong>);
    else if (tok.startsWith("`")) out.push(<code key={key} style={{ fontFamily: "var(--font-mono)", fontSize: "0.88em", background: "var(--surface-2)", padding: "1px 5px", borderRadius: 5 }}>{tok.slice(1, -1)}</code>);
    else if (tok.startsWith("[")) { const mm = tok.match(/^\[([^\]]+)\]\(([^)]+)\)$/); if (mm) out.push(<a key={key} href={mm[2]} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} style={{ color: "var(--accent)", textDecoration: "underline" }}>{mm[1]}</a>); }
    else if (tok.startsWith("@")) out.push(<strong key={key} style={{ color: "var(--accent)", fontWeight: 600 }}>{tok}</strong>);
    else if (tok.startsWith("*")) out.push(<em key={key}>{tok.slice(1, -1)}</em>);
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
