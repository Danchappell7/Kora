/* ============================================================
   KANBO — TaskDetail › Cover.                           [0048 stub → u8]
   Pick one of the task's image files as its board-card cover (a small
   grid of thumbnails, "None", and "Upload an image" handed back to the
   host's file input), or show that the project's cover is used when
   "Show project covers" is on. Saves tasks.cover_attachment_id (the
   database refuses a file that isn't an image on this task). Keyboard:
   the grid is a radio group with arrow keys. Read-only for guests.
   Renders nothing until package u8 builds it.
   ============================================================ */
import type { Attachment, Task } from "../../data/types";

export interface CoverPickerProps {
  task: Pick<Task, "id" | "title" | "coverAttachmentId">;
  /** the task's files (only images are offered) — with signed `url`s for thumbnails */
  attachments: Attachment[];
  /** the project shows its identity cover on cards without one */
  projectCovers?: boolean;
  readOnly?: boolean;
  /** null = no cover */
  onChange: (attachmentId: string | null) => void;
  /** "Upload an image": the host opens its file picker (the new file can then be chosen) */
  onUpload?: () => void;
}

export function CoverPicker(_props: CoverPickerProps) {
  return null;
}
