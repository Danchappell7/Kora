/* 0049 (Kanbo for Slack): the contract between the migration, the app, the
   edge function, the Slack app manifest and the deploy settings. The SQL itself
   is attacked and exercised in the PGlite replay (scratchpad/pgtest-slack). */
import { describe, it, expect } from "vitest";
import { MODAL_CALLBACK, SHORTCUT_CALLBACK, ACTIONS } from "../../supabase/functions/_shared/slackAppBlocks.ts";
import { SLACK_METHODS } from "../../supabase/functions/_shared/slackAppApi.ts";

const nodeFs = "node:fs";
const { readFileSync } = (await import(/* @vite-ignore */ nodeFs)) as { readFileSync: (p: string, enc: string) => string };
const { cwd } = (globalThis as unknown as { process: { cwd(): string } }).process;
const read = (p: string) => readFileSync(`${cwd()}/${p}`, "utf8");
const strip = (sql: string) => sql.split("\n").filter((l) => !/^\s*--/.test(l)).join("\n");

const M49 = read("supabase/migrations/0049_slack_app.sql");
const M48 = read("supabase/migrations/0048_ux_wave.sql");
const LIB = read("src/lib/slackApp.ts");
const MANIFEST = JSON.parse(read("docs/integrations/slack-app-manifest.json"));
const FN_URL = "https://htnchiljplrnjkwimgla.supabase.co/functions/v1/slack-app";

describe("migration 0049", () => {
  it("needs 0043, records 0049, and touches nothing 0048 made (production may not have 0048)", () => {
    expect(M49).toMatch(/version = '0043'/);
    expect(M49).toMatch(/insert into public\.schema_migrations \(version\) values \('0049'\)/);
    const made = new Set<string>();
    for (const m of M48.matchAll(/create (?:table|index|unique index)(?: if not exists)? (?:public\.)?([a-z0-9_]+)/gi)) made.add(m[1]);
    for (const m of M48.matchAll(/create or replace function public\.([a-z0-9_]+)/gi)) made.add(m[1]);
    for (const m of M48.matchAll(/add column if not exists ([a-z0-9_]+)/gi)) made.add(m[1]);
    expect(made.size).toBeGreaterThan(10);
    const body = strip(M49).toLowerCase();
    const used = [...made].filter((name) => new RegExp(`\\b${name}\\b`).test(body));
    expect(used).toEqual([]);
  });
  it("every RPC the app calls is a definer function granted to signed-in people (never anon)", () => {
    const rpcs = [...LIB.matchAll(/rpc\("([a-z_]+)"/g)].map((m) => m[1]);
    expect(new Set(rpcs)).toEqual(new Set(["slack_app_status", "slack_app_set_default", "slack_link_preview", "claim_slack_link"]));
    for (const fn of rpcs) {
      expect(M49).toMatch(new RegExp(`create or replace function public\\.${fn}\\([^)]*\\)[\\s\\S]*?security definer`));
      expect(M49).toMatch(new RegExp(`revoke execute on function public\\.${fn}\\([^)]*\\) from public, anon;`));
      expect(M49).toMatch(new RegExp(`grant execute on function public\\.${fn}\\([^)]*\\) to authenticated;`));
    }
  });
  it("the server-only tables grant clients nothing; links: read and delete your own only", () => {
    for (const t of ["slack_teams", "slack_link_requests"]) {
      expect(M49).toContain(`revoke all on public.${t} from anon, authenticated;`);
      expect(M49).not.toMatch(new RegExp(`grant [a-z, ]+ on public\\.${t}[^;]* to (anon|authenticated)`));
    }
    expect(M49).toContain("grant select, delete on public.slack_user_links to authenticated;");
    expect(M49).toMatch(/for select to authenticated using \(user_id = auth\.uid\(\)\)/);
    expect(M49).toMatch(/for delete to authenticated using \(user_id = auth\.uid\(\)\)/);
  });
  it("a Slack owner/admin's say-so is only as good as Slack's last word on it: 24 hours, checked server-side", () => {
    expect(M49).toMatch(/add column if not exists slack_admin_checked_at timestamptz/);
    expect(M49).toMatch(/create or replace function public\.slack_admin_state\(p_team text, p_user uuid\)[\s\S]*?slack_admin_checked_at > now\(\) - interval '24 hours'/);
    expect(M49).toContain("revoke execute on function public.slack_admin_state(text, uuid) from public, anon, authenticated;");
    expect(M49).not.toMatch(/grant execute on function public\.slack_admin_state/);
    const setDefault = /create or replace function public\.slack_app_set_default[\s\S]*?end; \$\$;/.exec(M49)![0];
    expect(setDefault).toMatch(/slack_admin_state\(p_team, me\)/);
    expect(setDefault).toMatch(/raise exception 'slack admin check needed'/);
    expect(setDefault).not.toMatch(/bool_or\(l\.slack_admin\)/);
    // linking records when Slack said it (the link request's time: users.info was asked then)
    expect(M49).toMatch(/slack_admin_checked_at\)\s*values \(r\.team_id, r\.slack_user_id, me, r\.slack_user_name, at, r\.slack_admin, r\.created_at\)/);
    expect(LIB).toMatch(/slack admin check needed/);
  });
  it("the one-time link: hashed, 15 minutes, single use", () => {
    expect(M49).toMatch(/token_hash ~ '\^\[0-9a-f\]\{64\}\$'/);
    expect(M49).toMatch(/expires_at <= created_at \+ interval '15 minutes'/);
    expect(M49).toMatch(/raise exception 'link already used'/);
    expect(M49).toMatch(/raise exception 'link expired'/);
    expect(M49).toMatch(/sha256\(convert_to/);
  });
});

describe("the Slack app manifest", () => {
  it("points everything at the slack-app function", () => {
    expect(MANIFEST.features.slash_commands).toEqual([expect.objectContaining({ command: "/kanbo", url: FN_URL, should_escape: true })]);
    expect(MANIFEST.settings.interactivity).toEqual({ is_enabled: true, request_url: FN_URL, message_menu_options_url: FN_URL });
    expect(MANIFEST.settings.event_subscriptions.request_url).toBe(FN_URL);
  });
  it("the message shortcut, events, unfurl domain and Home tab the function handles", () => {
    expect(MANIFEST.features.shortcuts).toEqual([expect.objectContaining({ type: "message", callback_id: SHORTCUT_CALLBACK })]);
    expect(MODAL_CALLBACK).toBe("create_kanbo_task");
    expect(MANIFEST.features.shortcuts[0].name.length).toBeLessThanOrEqual(24);
    // user_change: Slack tells Kanbo at once when it demotes or deactivates an owner/admin (users:read covers it)
    expect(new Set(MANIFEST.settings.event_subscriptions.bot_events)).toEqual(new Set(["link_shared", "app_home_opened", "user_change"]));
    expect(MANIFEST.features.unfurl_domains).toEqual(["www.kanbo.co.uk"]);
    expect(MANIFEST.features.app_home.home_tab_enabled).toBe(true);
    expect(Object.values(ACTIONS)).toContain("complete_task");
  });
  it("asks for the narrowest scopes: no message history, no posting to channels it isn't in", () => {
    const scopes: string[] = MANIFEST.oauth_config.scopes.bot;
    expect(new Set(scopes)).toEqual(new Set(["commands", "chat:write", "links:read", "links:write", "users:read", "users:read.email"]));
    expect(MANIFEST.oauth_config.scopes.user).toBeUndefined();
    for (const broad of ["channels:history", "groups:history", "im:history", "chat:write.public", "channels:read", "admin"]) expect(scopes).not.toContain(broad);
    // every Web API method the function may call needs only these
    expect([...SLACK_METHODS].sort()).toEqual(["chat.getPermalink", "chat.postEphemeral", "chat.unfurl", "users.info", "views.open", "views.publish", "views.update"]);
  });
});

describe("deploy settings", () => {
  it("slack-app has no Supabase JWT to verify (Slack signs its requests)", () => {
    expect(read("supabase/config.toml")).toMatch(/\[functions\.slack-app\]\nverify_jwt = false/);
  });
  it("the function reads its secrets from the environment, never logs them", () => {
    const fn = read("supabase/functions/slack-app/index.ts");
    expect(fn).toContain('Deno.env.get("SLACK_SIGNING_SECRET")');
    expect(fn).toContain('Deno.env.get("SLACK_BOT_TOKEN")');
    expect(fn).not.toMatch(/console\.\w+\([^)]*(BOT_TOKEN|SIGNING_SECRET)/);
  });
  it("the owner steps use hidden prompts, never secrets on the command line or in chat", () => {
    const doc = read("docs/integrations/slack-app.md");
    expect(doc).toMatch(/read -s "SLACK_BOT\?/);
    expect(doc).toMatch(/read -s "SLACK_SIGN\?/);
    expect(doc).toMatch(/--env-file <\(printf/);
    expect(doc).toMatch(/R=htnchiljplrnjkwimgla && supabase functions deploy slack-app --no-verify-jwt --project-ref \$R --use-api/);
    expect(doc).toContain("supabase db query --linked -f supabase/migrations/0049_slack_app.sql");
    expect(doc).not.toMatch(/xoxb-[0-9]/);
  });
});
