// @vitest-environment node
// The discovery documents, the hosting rules in vercel.json, and the things that
// have to stay the same in more than one file.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  authorizationServerMetadata, MCP_ISSUER, MCP_RESOURCE, PROTECTED_RESOURCE_METADATA_URL, protectedResourceMetadata,
} from "./metadata.ts";

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), "utf8");
const vercel = JSON.parse(read("vercel.json")) as { rewrites: { source: string; destination: string }[]; headers: { source: string; headers: { key: string; value: string }[] }[] };
const FN = "https://htnchiljplrnjkwimgla.supabase.co/functions/v1/mcp";

describe("discovery documents", () => {
  const as = authorizationServerMetadata();
  const pr = protectedResourceMetadata();

  it("are what the research settled on", () => {
    expect(as.issuer).toBe("https://www.kanbo.co.uk");
    expect(pr.resource).toBe("https://www.kanbo.co.uk/mcp");
    expect(pr.authorization_servers).toEqual([as.issuer]);
    expect(as.scopes_supported).toEqual(["kanbo.read", "kanbo.write", "offline_access"]);
    expect(pr.scopes_supported).toEqual(["kanbo.read", "kanbo.write"]);
    expect(as.token_endpoint_auth_methods_supported).toEqual(["none"]);
    expect(as.code_challenge_methods_supported).toEqual(["S256"]);
    expect(as.client_id_metadata_document_supported).toBe(true);
    expect(as.authorization_response_iss_parameter_supported).toBe(true);
    expect(as.registration_endpoint).toBe("https://www.kanbo.co.uk/oauth/register");
    expect(as.grant_types_supported).toEqual(["authorization_code", "refresh_token"]);
  });

  it("match the static files the website serves, exactly", () => {
    expect(JSON.parse(read("public/oauth-metadata/protected-resource.json"))).toEqual(pr);
    expect(JSON.parse(read("public/oauth-metadata/authorization-server.json"))).toEqual(as);
  });

  it("never read a request: there's nothing here that could derive them from one", () => {
    const code = read("supabase/functions/_shared/mcp/metadata.ts").split("\n").filter((l) => !l.startsWith("//") && !l.trim().startsWith("/**")).join("\n");
    expect(code).not.toMatch(/\breq\b|request|headers|forwarded/i);
  });

  it("the migration's resource is the same address", () => {
    expect(read("supabase/migrations/0050_mcp_oauth.sql")).toContain(`select '${MCP_RESOURCE}'::text`);
  });
});

describe("vercel.json", () => {
  const indexOf = (source: string) => vercel.rewrites.findIndex((r) => r.source === source);
  const catchAll = vercel.rewrites.length - 1;

  it("the SPA catch-all is last, and leaves unknown /.well-known paths to 404", () => {
    expect(vercel.rewrites[catchAll].destination).toBe("/index.html");
    const re = new RegExp(`^${vercel.rewrites[catchAll].source}$`);
    expect(re.test("/today")).toBe(true);
    expect(re.test("/oauth/authorize")).toBe(true);
    expect(re.test("/.well-known/openid-configuration")).toBe(false);
    expect(re.test("/.well-known/anything")).toBe(false);
  });

  it("proxies /mcp and the OAuth endpoints to the function, ahead of the catch-all", () => {
    for (const [source, dest] of [
      ["/mcp", FN],
      ["/oauth/register", `${FN}/oauth/register`],
      ["/oauth/token", `${FN}/oauth/token`],
      ["/oauth/revoke", `${FN}/oauth/revoke`],
      ["/oauth/prepare", `${FN}/oauth/prepare`],
    ]) {
      const i = indexOf(source);
      expect(i, source).toBeGreaterThanOrEqual(0);
      expect(i, source).toBeLessThan(catchAll);
      expect(vercel.rewrites[i].destination).toBe(dest);
    }
  });

  it("serves discovery as static files through same-app rewrites, ahead of the catch-all", () => {
    for (const [source, dest] of [
      ["/.well-known/oauth-protected-resource/mcp", "/oauth-metadata/protected-resource.json"],
      ["/.well-known/oauth-protected-resource", "/oauth-metadata/protected-resource.json"],
      ["/.well-known/oauth-authorization-server", "/oauth-metadata/authorization-server.json"],
    ]) {
      const i = indexOf(source);
      expect(i, source).toBeGreaterThanOrEqual(0);
      expect(i, source).toBeLessThan(catchAll);
      expect(vercel.rewrites[i].destination).toBe(dest);
    }
    expect(indexOf("/.well-known/openid-configuration")).toBe(-1);
  });

  it("/oauth/authorize stays the app", () => {
    expect(indexOf("/oauth/authorize")).toBe(-1);
  });

  it("turns off rewrite caching on what's proxied, and lets browsers read discovery", () => {
    for (const source of ["/mcp", "/oauth/(register|token|revoke|prepare)"]) {
      const rule = vercel.headers.find((h) => h.source === source)!;
      expect(rule.headers, source).toContainEqual({ key: "x-vercel-enable-rewrite-caching", value: "0" });
    }
    const disc = vercel.headers.find((h) => h.source.startsWith("/.well-known"))!;
    expect(disc.headers).toContainEqual({ key: "Access-Control-Allow-Origin", value: "*" });
    expect(disc.headers.find((h) => h.key === "Content-Type")?.value).toMatch(/application\/json/);
  });

  it("keeps its security headers", () => {
    const all = vercel.headers.find((h) => h.source === "/(.*)")!;
    expect(all.headers.find((h) => h.key === "Content-Security-Policy")?.value).toContain("frame-ancestors 'none'");
    expect(all.headers.find((h) => h.key === "X-Frame-Options")?.value).toBe("DENY");
  });
});

describe("the service worker", () => {
  const sw = read("public/sw.js");
  const line = /test\(url\.pathname\)\) return;/;
  it("leaves the MCP paths alone, before anything is cached", () => {
    expect(sw).toMatch(line);
    expect(sw.indexOf("test(url.pathname)) return;")).toBeLessThan(sw.indexOf('req.mode === "navigate"'));
    const m = /if \((\/\^.*\/)\.test\(url\.pathname\)\) return;/.exec(sw);
    const re = new RegExp(m![1].slice(1, -1));
    for (const p of ["/mcp", "/.well-known/oauth-protected-resource", "/.well-known/oauth-authorization-server", "/oauth/register", "/oauth/token", "/oauth/revoke", "/oauth/prepare", "/oauth-metadata/authorization-server.json"]) {
      expect(re.test(p), p).toBe(true);
    }
    for (const p of ["/oauth/authorize", "/today", "/mcpx", "/assets/index.js"]) expect(re.test(p), p).toBe(false);
  });
});

describe("addresses", () => {
  it("point at www, which the bare domain redirects to", () => {
    expect(MCP_ISSUER).toBe("https://www.kanbo.co.uk");
    expect(PROTECTED_RESOURCE_METADATA_URL).toBe("https://www.kanbo.co.uk/.well-known/oauth-protected-resource/mcp");
  });
});

describe("the live check in DEPLOYMENT.md", () => {
  const check = /grep -qE '([^']+)'/.exec(read("DEPLOYMENT.md"))![1];
  const re = new RegExp(check);
  it("matches the discovery documents", () => {
    expect(read("public/oauth-metadata/protected-resource.json")).toMatch(re);
    expect(read("public/oauth-metadata/authorization-server.json")).toMatch(re);
  });
  it("doesn't match the app's own page, which is what an address gets when it's not set up", () => {
    expect(read("index.html")).toContain("https://www.kanbo.co.uk");
    expect(read("index.html")).not.toMatch(re);
  });
  it("makes one real round trip, and the owner's guide says so", () => {
    expect(read("DEPLOYMENT.md")).toMatch(/oauth\/register" -H 'Content-Type: application\/json'/);
    expect(read("DEPLOYMENT.md")).toMatch(/register 201/);
  });
  it("runs steps 1 and 2 only from a folder with the new code, before asking for the token", () => {
    const step = read("DEPLOYMENT.md").split("### Step 16")[1].split("\n---")[0];
    const commands = step.split("\n").filter((l) => /read -s .*supabase (db query|functions deploy)/.test(l));
    expect(commands).toHaveLength(2);
    for (const c of commands) {
      for (const file of ["supabase/migrations/0050_mcp_oauth.sql", "supabase/functions/mcp/index.ts"]) {
        expect(c, file).toContain(`[ -f ${file} ]`);
        expect(read(file).length, file).toBeGreaterThan(0);
      }
      expect(c.indexOf("isn't in this folder yet")).toBeGreaterThan(-1);
      expect(c.indexOf("isn't in this folder yet")).toBeLessThan(c.indexOf("read -s"));
    }
    expect(step).toMatch(/branch `mcp` merged/);
  });
  it("says db.ts's other functions need deploying too", () => {
    const step = read("DEPLOYMENT.md").split("### Step 16")[1];
    for (const fn of ["mcp", "api", "webhook-dispatch", "notion", "slack-app"]) expect(step, fn).toContain(`supabase functions deploy ${fn}`);
    expect(step).not.toMatch(/No other function needs deploying/);
  });
});

describe("the PGlite harness", () => {
  it("opens transactions exactly as the live db.ts does", () => {
    const live = /WITH_USER_SQL =\s*("[^;]+);/.exec(read("supabase/functions/_shared/api/db.ts"))![1];
    const harness = /WITH_USER_SQL =\s*("[^;]+);/.exec(read("supabase/tests/pglite/harness.ts"))![1];
    expect(harness).toBe(live);
  });
});

describe("config.toml", () => {
  it("has the gateway's JWT check off for mcp: it checks its own bearers", () => {
    expect(read("supabase/config.toml")).toMatch(/\[functions\.mcp\]\nverify_jwt = false/);
  });
});

describe("0050", () => {
  const sql = read("supabase/migrations/0050_mcp_oauth.sql");
  it("is recorded, and needs only 0046", () => {
    expect(sql).toContain("insert into public.schema_migrations (version) values ('0050') on conflict (version) do nothing");
    expect(sql).toMatch(/version = '0046'/);
    expect(sql).not.toMatch(/version = '004[789]'/);
  });
  it("clears its own rate-limit rows, and what a stranger can store stays small", () => {
    expect(sql).toMatch(/delete from public\.rate_limits l where l\.ctid in/);
    expect(sql).toMatch(/x\.key like 'kanbo:mcp:%'/);
    expect(sql).toMatch(/not between 1 and 8/);
    expect(sql).toMatch(/length\(u\) > 512/);
  });
  it("doesn't touch anything from 0047, 0048 or 0049", () => {
    // ignore comments: the header says what it doesn't depend on
    const code = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    for (const name of ["search_all", "slack_", "approvals", "trash", "kudos", "saved_views", "audit_events", "project_docs"]) {
      expect(code, name).not.toContain(name);
    }
  });
});
