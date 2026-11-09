// ============================================================
// KANBO — what an invite email says about the role it's for. One place, so
// the email and its test agree. Honest about today: until private projects
// land, a guest can see every project in the workspace (and comment), so the
// email says so rather than suggesting a guest only sees "their" project.
// Everything here is plain text: the caller HTML-escapes it.
// ============================================================

/** "an admin" · "a member" · "a guest", for "…on Kanbo as ___." */
export function roleLine(role: string): string {
  return role === "admin" ? "an admin" : role === "guest" ? "a guest" : "a member";
}

/** The extra sentence a guest's invite carries (none for other roles). */
export function guestNote(role: string, workspaceName: string): string | null {
  if (role !== "guest") return null;
  return `As a guest you can see every project in ${workspaceName} and comment on its tasks, but you can't change anything.`;
}
