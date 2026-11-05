// ============================================================
// KANBO — MCP: the fixed addresses and discovery documents.
//
// Hard-coded, never derived from a request: the issuer has to be identical in
// every document and to the address clients found it at, and a Host or
// X-Forwarded-Host header must never change what a client trusts.
//
// The same JSON is served as static files from public/oauth-metadata/ through
// vercel.json's same-app rewrites (the Supabase host can't serve /.well-known
// at its root). metadata.test.ts keeps the files and this module equal, and
// the migration's mcp_oauth_resource() equal to MCP_RESOURCE.
//
// Pure module.
// ============================================================

export const MCP_ISSUER = "https://www.kanbo.co.uk";
/** The one address to paste into an AI app. kanbo.co.uk/mcp redirects to it, and a redirect drops the Authorization header. */
export const MCP_RESOURCE = `${MCP_ISSUER}/mcp`;
export const PROTECTED_RESOURCE_METADATA_URL = `${MCP_ISSUER}/.well-known/oauth-protected-resource/mcp`;

export const SCOPE_READ = "kanbo.read";
export const SCOPE_WRITE = "kanbo.write";
export const SCOPE_OFFLINE = "offline_access";
/** What a 401 asks for (and the protected resource document lists). */
export const RESOURCE_SCOPES = [SCOPE_READ, SCOPE_WRITE] as const;

/** RFC 9728 (served at /.well-known/oauth-protected-resource and …/mcp). */
export function protectedResourceMetadata() {
  return {
    resource: MCP_RESOURCE,
    authorization_servers: [MCP_ISSUER],
    scopes_supported: [...RESOURCE_SCOPES],
    bearer_methods_supported: ["header"],
    resource_name: "Kanbo",
    resource_documentation: "https://github.com/Danchappell7/Kora/blob/main/docs/integrations/mcp.md",
  };
}

/** RFC 8414 (served at /.well-known/oauth-authorization-server). */
export function authorizationServerMetadata() {
  return {
    issuer: MCP_ISSUER,
    authorization_endpoint: `${MCP_ISSUER}/oauth/authorize`,
    token_endpoint: `${MCP_ISSUER}/oauth/token`,
    registration_endpoint: `${MCP_ISSUER}/oauth/register`,
    revocation_endpoint: `${MCP_ISSUER}/oauth/revoke`,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [SCOPE_READ, SCOPE_WRITE, SCOPE_OFFLINE],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
    service_documentation: "https://github.com/Danchappell7/Kora/blob/main/docs/integrations/mcp.md",
  };
}
