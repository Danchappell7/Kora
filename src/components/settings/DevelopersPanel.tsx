/* ============================================================
   KANBO — Settings › Developers: API keys.           [0046 stub → a1]
   Create a key (name; personal or team — team keys only in workspaces
   where you're an owner/admin; read-only or read & write; optional
   expiry), show the full key ONCE (copy + warning), list keys (name,
   prefix, scope, created, last used, expiry, status) and revoke.
   Links to the API reference (ApiDocs). Data: lib/apiKeys.
   Renders nothing until package a1 builds it.
   ============================================================ */
import type { Role } from "../../data/types";

/** A team workspace you're in, with your role there. */
export interface DevWorkspace {
  id: string;
  name: string;
  role: Role;
}

export interface DevelopersPanelProps {
  /** the team workspaces you belong to (team keys: where role is owner/admin) */
  workspaces: DevWorkspace[];
  /** the workspace open in the app (null = Personal): preselects the key's scope */
  currentWorkspaceId: string | null;
  /** open the API reference (the panel shows a link when given) */
  onOpenDocs?: () => void;
}

export function DevelopersPanel(_props: DevelopersPanelProps) {
  return null;
}
