/* ============================================================
   KANBO — "/" for a template in Today's capture field, loaded on use.
   Safe to import from the shell (Today): this file is a few lines; the
   picker, the strip and the template code come in their own chunk the
   first time "/" is typed there. Render them inside a
   <Suspense fallback={null}>.
   ============================================================ */
import { chunk, lazyComponent, prefetch } from "../../lib/lazyLoad";
import type { CaptureTemplatePickerProps, CaptureTemplateStripProps } from "./CaptureTemplate";

export type { CaptureTemplatePickerProps, CaptureTemplateStripProps } from "./CaptureTemplate";

const capture = chunk(() => import("./CaptureTemplate"));
export const CaptureTemplatePicker = lazyComponent<typeof import("./CaptureTemplate"), CaptureTemplatePickerProps>(capture, (m) => m.CaptureTemplatePicker, "CaptureTemplatePicker");
export const CaptureTemplateStrip = lazyComponent<typeof import("./CaptureTemplate"), CaptureTemplateStripProps>(capture, (m) => m.CaptureTemplateStrip, "CaptureTemplateStrip");
/** warm the chunk (the capture field took focus: "/" may be next) */
export const prefetchCaptureTemplates = (): void => prefetch(capture);
