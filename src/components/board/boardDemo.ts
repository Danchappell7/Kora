/* ============================================================
   KANBO — the board's demo world (no backend): a few image files on
   seeded tasks, used as their card covers, and board settings for two
   demo projects (WIP limits on the launch board, project covers on the
   brand board). Kept out of the shell: only the board and the cover
   picker (both lazy) import it. Read-only seed: nothing here is ever
   written to; choosing "None" on a seeded cover saves
   coverAttachmentId: null on the task, which wins over the default.
   ============================================================ */
import { isSupabaseConfigured } from "../../lib/backend";
import { getProject } from "../../data/data";
import { applyBoardSettingsChange, type BoardSettingsChange } from "../tasks/otherViewsLogic";
import type { Attachment, BoardSettings, Task } from "../../data/types";

const svg = (body: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 320" preserveAspectRatio="xMidYMid slice">${body}</svg>`)}`;

/* hand-drawn, text-free covers in the demo projects' hues (Sky for the launch, Orchid for the brand) */
const DECK = svg(`
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1c2f5e"/><stop offset="1" stop-color="#3f7fd8"/></linearGradient></defs>
<rect width="640" height="320" fill="url(#g)"/>
<rect x="250" y="70" width="300" height="180" rx="10" fill="#ffffff" opacity=".16"/>
<rect x="210" y="52" width="300" height="180" rx="10" fill="#ffffff" opacity=".24"/>
<rect x="170" y="34" width="300" height="180" rx="10" fill="#f5f8ff"/>
<rect x="196" y="62" width="150" height="14" rx="7" fill="#1c2f5e" opacity=".85"/>
<rect x="196" y="86" width="96" height="10" rx="5" fill="#1c2f5e" opacity=".35"/>
<rect x="206" y="166" width="28" height="30" rx="4" fill="#7fb0f0"/>
<rect x="246" y="146" width="28" height="50" rx="4" fill="#5a93e6"/>
<rect x="286" y="124" width="28" height="72" rx="4" fill="#3f7fd8"/>
<rect x="326" y="98" width="28" height="98" rx="4" fill="#1f5fc0"/>
<path d="M206 150 L260 132 L300 112 L352 84" fill="none" stroke="#ff9f6b" stroke-width="5" stroke-linecap="round"/>
<circle cx="352" cy="84" r="8" fill="#ff9f6b"/>`);

const TRACTION = svg(`
<rect width="640" height="320" fill="#eef4fc"/>
<g stroke="#c9d8ee" stroke-width="2"><path d="M60 260H600M60 200H600M60 140H600M60 80H600"/></g>
<path d="M60 250 C140 240 180 220 240 200 S360 150 420 120 S540 70 600 52 L600 260 L60 260Z" fill="#3f7fd8" opacity=".18"/>
<path d="M60 250 C140 240 180 220 240 200 S360 150 420 120 S540 70 600 52" fill="none" stroke="#2c6bd0" stroke-width="6" stroke-linecap="round"/>
<circle cx="600" cy="52" r="10" fill="#2c6bd0"/><circle cx="600" cy="52" r="20" fill="#2c6bd0" opacity=".18"/>`);

const VIDEO = svg(`
<defs><radialGradient id="r" cx=".3" cy=".2" r="1"><stop offset="0" stop-color="#4d8ee8"/><stop offset="1" stop-color="#14254d"/></radialGradient></defs>
<rect width="640" height="320" fill="url(#r)"/>
<rect x="150" y="48" width="340" height="212" rx="14" fill="#0d1a38" opacity=".55"/>
<rect x="164" y="62" width="312" height="184" rx="8" fill="#dfeaff" opacity=".1"/>
<circle cx="320" cy="154" r="44" fill="#ffffff" opacity=".92"/>
<path d="M306 132 L342 154 L306 176 Z" fill="#14254d"/>
<rect x="164" y="270" width="312" height="6" rx="3" fill="#ffffff" opacity=".2"/>
<rect x="164" y="270" width="118" height="6" rx="3" fill="#ff9f6b"/>`);

const TOKENS = svg(`
<rect width="640" height="320" fill="#f6f0fb"/>
<g transform="translate(70 62)">
<rect width="88" height="88" rx="16" fill="#7a3fb8"/><rect x="104" width="88" height="88" rx="16" fill="#a46be0"/>
<rect x="208" width="88" height="88" rx="16" fill="#cfa8f2"/><rect x="312" width="88" height="88" rx="16" fill="#efe1fb" stroke="#d9c2f1" stroke-width="2"/>
<rect y="108" width="88" height="88" rx="16" fill="#2c6bd0"/><rect x="104" y="108" width="88" height="88" rx="16" fill="#e45c8a"/>
<rect x="208" y="108" width="88" height="88" rx="16" fill="#f2a541"/><rect x="312" y="108" width="88" height="88" rx="16" fill="#2fa585"/>
</g>
<g fill="#7a3fb8"><rect x="500" y="72" width="80" height="14" rx="7"/><rect x="500" y="100" width="58" height="10" rx="5" opacity=".6"/><rect x="500" y="122" width="70" height="8" rx="4" opacity=".4"/><rect x="500" y="142" width="44" height="6" rx="3" opacity=".3"/></g>`);

const HERO = svg(`
<defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffd9c2"/><stop offset="1" stop-color="#f4b8d8"/></linearGradient></defs>
<rect width="640" height="320" fill="url(#s)"/>
<circle cx="452" cy="118" r="54" fill="#fff4e6"/>
<path d="M0 230 C90 170 170 168 250 206 S420 250 520 196 S610 170 640 178 V320 H0Z" fill="#b986dd"/>
<path d="M0 262 C120 222 210 236 300 258 S470 290 640 236 V320 H0Z" fill="#8a52c0"/>
<path d="M0 296 C140 270 300 276 420 292 S580 306 640 296 V320 H0Z" fill="#5d2f93"/>`);

const at = "2026-10-05T09:30:00.000Z";
const file = (id: string, taskId: string, name: string, url: string, size: number): Attachment =>
  ({ id, taskId, name, size, mime: "image/svg+xml", path: "demo", url, createdAt: at, userId: "m-self" });

/** Image files on seeded demo tasks (t-1 has two, so the cover picker has a choice). */
export const DEMO_COVER_ATTACHMENTS: readonly Attachment[] = Object.freeze([
  file("demo-cover-deck", "t-1", "launch-deck-cover.svg", DECK, 2140),
  file("demo-cover-traction", "t-1", "traction-chart.svg", TRACTION, 1210),
  file("demo-cover-tokens", "t-4", "tokens-v2-palette.svg", TOKENS, 1630),
  file("demo-cover-hero", "t-9", "hero-sketch.svg", HERO, 980),
  file("demo-cover-video", "t-24", "demo-video-still.svg", VIDEO, 1320),
]);

/** Each seeded task's default cover (until someone picks another, or None). */
const DEFAULT_COVER: Record<string, string> = {
  "t-1": "demo-cover-deck", "t-4": "demo-cover-tokens", "t-9": "demo-cover-hero", "t-24": "demo-cover-video",
};

/** Seeded board settings for demo projects (the launch board has WIP limits, the brand board shows covers). */
export const DEMO_BOARD_SETTINGS: Readonly<Record<string, BoardSettings>> = Object.freeze({
  "p-launch": { wip: { progress: 3, review: 2 } },
  "p-brand": { covers: true },
});

/** Is this the demo (no backend)? */
export const isDemoBoard = (): boolean => !isSupabaseConfigured;

/** A task's demo files (only in the demo). */
export function demoCoverAttachments(taskId: string): Attachment[] {
  return isDemoBoard() ? DEMO_COVER_ATTACHMENTS.filter((a) => a.taskId === taskId) : [];
}

/** The cover a card shows: the task's own choice (null = none), else — in the demo — its seeded default. */
export function effectiveCoverId(task: Pick<Task, "id" | "coverAttachmentId">): string | null {
  if (task.coverAttachmentId !== undefined) return task.coverAttachmentId ?? null;
  return isDemoBoard() ? DEFAULT_COVER[task.id] ?? null : null;
}

/** Demo signed URLs by attachment id. */
export function demoCoverUrls(): Record<string, string> {
  if (!isDemoBoard()) return {};
  const out: Record<string, string> = {};
  for (const a of DEMO_COVER_ATTACHMENTS) if (a.url) out[a.id] = a.url;
  return out;
}

/* boards whose settings someone has changed this session (the seed stops applying to them) */
const touched = new Set<string>();
export function markBoardSettingsTouched(projectId: string | null | undefined): void { if (projectId) touched.add(projectId); }

/** A project's board settings, with the demo seed standing in until they're changed. */
export function demoAwareBoardSettings(projectId: string | null | undefined, settings: BoardSettings | undefined): BoardSettings | undefined {
  const has = !!settings && (Object.keys(settings).length > 0);
  if (has || !projectId || !isDemoBoard() || touched.has(projectId)) return settings;
  return DEMO_BOARD_SETTINGS[projectId] ?? settings;
}

/**
 * The project's board settings once a change is made, built from the freshest
 * copy there is when the change is made (the app's own project list, which
 * live updates and optimistic saves keep current), not from what a screen
 * rendered earlier; `fallback` only for a project that list doesn't hold.
 * Marks the board changed, so the demo seed stops standing in. Save it with
 * the change itself, which the database merges one level deep
 * (merge_board_settings), so a teammate's edit made meanwhile survives.
 */
export function nextBoardSettings(projectId: string | null | undefined, fallback: BoardSettings | undefined, change: BoardSettingsChange): BoardSettings {
  const base = currentBoardSettings(projectId, fallback);
  markBoardSettingsTouched(projectId);
  return applyBoardSettingsChange(base, change);
}

/** The project's board settings right now (the freshest copy; see nextBoardSettings), demo seed included. */
export function currentBoardSettings(projectId: string | null | undefined, fallback: BoardSettings | undefined): BoardSettings | undefined {
  const live = projectId ? getProject(projectId) : undefined;
  return demoAwareBoardSettings(projectId, live ? live.boardSettings : fallback);
}
