// ============================================================
// KANBO — what an invite email says about the role it's for. One place, so
// the email and its test agree. Honest about what the guest will see: in a
// workspace with Project access switched on (0058) only the projects they're
// added to (to view, or to comment too, as each one says); otherwise every
// project in the workspace (and they can comment),
// so the email says so rather than suggesting a guest only sees "their" project.
// Everything here is plain text: the caller HTML-escapes it.
// ============================================================

/** "an admin" · "a member" · "a guest", for "…on Kanbo as ___." */
export function roleLine(role: string): string {
  return role === "admin" ? "an admin" : role === "guest" ? "a guest" : "a member";
}

/** The extra sentence a guest's invite carries (none for other roles). `projectAccess`: the workspace's switch is on. */
export function guestNote(role: string, workspaceName: string, projectAccess = false): string | null {
  if (role !== "guest") return null;
  // (a guest is added to each project to view it or to comment on it: the email can't promise either)
  if (projectAccess) return "As a guest you'll see only the projects you're added to. On each one you can read its tasks, or comment on them too, depending on how you were added.";
  return `As a guest you can see every project in ${workspaceName} and comment on its tasks, but you can't change anything.`;
}
