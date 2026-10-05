/* ============================================================
   KANBO — Settings › Developers, as SettingsModal shows it (0046).
   API keys (DevelopersPanel), then webhooks (WebhooksPanel); "API
   reference" swaps the API reference (ApiDocs) in place. The panels stay
   mounted, hidden, underneath it, so a key or signing secret that's on
   screen only once isn't lost by a look at the docs. Opening the reference
   puts focus on its heading; Back returns focus to the link.

   Loaded on demand (React.lazy in SettingsModal): the OpenAPI document and
   the three panels stay out of the app's first download. The section
   unmounts when Settings closes or another section opens, which also
   closes the reference.
   ============================================================ */
import { useRef, useState } from "react";
import { ApiDocs } from "./ApiDocs";
import { DevelopersPanel, type DevWorkspace } from "./DevelopersPanel";
import { WebhooksPanel } from "./WebhooksPanel";
import { apiBaseUrl } from "../../lib/apiKeys";

export interface DevelopersSectionProps {
  /** every team workspace you're in, with your role there (guests too: the panels explain) */
  workspaces: DevWorkspace[];
  /** the workspace open in the app (null = Personal) */
  currentWorkspaceId: string | null;
}

export default function DevelopersSection({ workspaces, currentWorkspaceId }: DevelopersSectionProps) {
  const [docsOpen, setDocsOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const docsRef = useRef<HTMLDivElement>(null);

  const openDocs = () => {
    setDocsOpen(true);
    requestAnimationFrame(() => {
      const scroller = rootRef.current?.closest<HTMLElement>(".kset-scroll");
      if (scroller) scroller.scrollTop = 0;
      // land on the reference's heading, so it's read out (the wrapper if it has none)
      const heading = docsRef.current?.querySelector<HTMLElement>("h2") ?? docsRef.current;
      if (heading && heading !== docsRef.current) heading.tabIndex = -1;
      heading?.focus({ preventScroll: true });
    });
  };
  const closeDocs = () => {
    setDocsOpen(false);
    requestAnimationFrame(() => {
      const link = rootRef.current?.querySelector<HTMLElement>(".kdev-docs-link");
      link?.focus({ preventScroll: true });
      link?.scrollIntoView?.({ block: "nearest" });
    });
  };

  return (
    <div ref={rootRef} className="kset-dev">
      {docsOpen && (
        <div ref={docsRef} tabIndex={-1} className="kset-docs">
          <ApiDocs baseUrl={apiBaseUrl()} onClose={closeDocs} />
        </div>
      )}
      <div hidden={docsOpen}>
        <DevelopersPanel workspaces={workspaces} currentWorkspaceId={currentWorkspaceId} onOpenDocs={openDocs} />
        <WebhooksPanel workspaces={workspaces} currentWorkspaceId={currentWorkspaceId} />
      </div>
    </div>
  );
}
