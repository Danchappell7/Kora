/* ============================================================
   KANBO — Settings › Developers › Webhooks.          [0046 stub → a2]
   Add an endpoint (https URL, events checklist, personal or a team
   workspace where you can edit), show the signing secret ONCE, send a
   test, recent deliveries (event, status, response time, attempts, next
   retry, redeliver), switch on/off, rotate the secret, delete.
   Data: lib/webhooks. Renders nothing until package a2 builds it.
   ============================================================ */
import type { DevWorkspace } from "./DevelopersPanel";

export interface WebhooksPanelProps {
  /** the team workspaces you belong to (team endpoints: owners, admins and members — never guests) */
  workspaces: DevWorkspace[];
  /** the workspace open in the app (null = Personal): preselects the endpoint's scope */
  currentWorkspaceId: string | null;
}

export function WebhooksPanel(_props: WebhooksPanelProps) {
  return null;
}
