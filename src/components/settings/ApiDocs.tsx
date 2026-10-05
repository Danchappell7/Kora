/* ============================================================
   KANBO — the API reference, rendered from the OpenAPI document.
                                                      [0046 stub → a1]
   Endpoint list grouped by tag, parameters, request / response examples,
   a copyable curl per endpoint with `baseUrl` filled in, errors, rate
   limits, pagination, idempotency, and a pointer to webhooks. Reads
   buildOpenApi(baseUrl) from supabase/functions/_shared/api/openapi.ts
   (no fetch, no new dependencies). No live "Try it" (keys never belong
   in a browser); demo mode shows the same reference.
   Renders nothing until package a1 builds it.
   ============================================================ */

export interface ApiDocsProps {
  /** e.g. https://<ref>.supabase.co/functions/v1/api/v1 — lib/apiKeys apiBaseUrl() */
  baseUrl: string;
  /** a key prefix for the examples ("kanbo_sk_Ab3x…"); never a full key */
  keyHint?: string;
  /** shown as a Back / Close control when the reference opens on its own */
  onClose?: () => void;
}

export function ApiDocs(_props: ApiDocsProps) {
  return null;
}
