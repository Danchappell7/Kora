/* ============================================================
   KANBO — drag to plan: the menus, loaded on first use.
   Safe to import from the shell (Today, lists, the sidebar): this
   file is a few lines; ScheduleMenu and MoveToMenu come in their
   own chunk when one first opens (prefetchPlanMenus warms it on a
   hover or focus of the button that opens one). Render them inside
   a <Suspense fallback={null}>.
   ============================================================ */
import { chunk, lazyComponent, prefetch } from "../../lib/lazyLoad";
import type { ScheduleMenuProps, MoveToMenuProps } from "./PlanMenus";

export type { ScheduleMenuProps, MoveToMenuProps, ScheduleBusy, ScheduleDay, SchedulePick } from "./PlanMenus";

const menus = chunk(() => import("./PlanMenus"));
export const ScheduleMenu = lazyComponent<typeof import("./PlanMenus"), ScheduleMenuProps>(menus, (m) => m.ScheduleMenu, "ScheduleMenu");
export const MoveToMenu = lazyComponent<typeof import("./PlanMenus"), MoveToMenuProps>(menus, (m) => m.MoveToMenu, "MoveToMenu");
/** warm the menus' chunk (hover / focus on a "Schedule…" or "Move to…" button) */
export const prefetchPlanMenus = (): void => prefetch(menus);
