// ============================================================
// KANBO — AI assist Edge Function (Deno / Supabase)
// Calls Claude for the app's AI features. The client sends its
// (RLS-filtered) tasks; we never read task data from the DB here (only the
// caller's profile and usage count). Falls back to a 400 if no key is
// configured, and the client then uses its on-device rules.
//
// Modes: prioritize (default), breakdown, summary, ask — and, for the
// redesign, command (Ask Kanbo), extract (notes → tasks), standup (Team
// Pulse) and status (a project's drafted update), whose prompts and reply
// checks live in prompts.ts. Every reply must be one strict JSON object
// (else 502 { error: "bad_output" }), and every 200 carries
// usage: { used, limit } once the daily count is being kept.
//
// Guard rails (every call is billed to our Anthropic key):
//   • signed-in, approved, not-suspended accounts only (401 / 403)
//   • request body ≤ 4 MB (413 only for payloads no real workspace sends —
//     the app posts every task in view, ~250 bytes each); question/title/
//     description capped at 4,000 characters, every task field trimmed, and
//     only the 120 most relevant tasks reach the prompt (see tasks.ts)
//   • AI_DAILY_LIMIT calls per person per UK day (default 200) → 429
//     { error: "daily_limit" }. Counted in ai_usage (migration 0042); until
//     that table exists the limit is skipped with a warning (fails open).
//
// Deploy:  supabase functions deploy ai-assist        (Verify JWT: ON)
// Secret:  supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
//          optional: AI_DAILY_LIMIT (default 200)
//          optional: AI_MODEL (default DEFAULT_MODEL below)
// ============================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { countAiCall, dayIn } from "../_shared/limits.ts";
import { cleanTasks, str } from "./tasks.ts";
import { firstJsonObject, modeRequest } from "./prompts.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const MAX_BODY = 4_000_000; // bytes of JSON we'll read at all
const MAX_TEXT = 4_000;     // question / title / description (extract's notes: MAX_TEXT_EXTRACT)
const DEFAULT_MODEL = "claude-sonnet-4-6";
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } });

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  // Require a real signed-in user — NOT just the public anon key (which is
  // a valid JWT and so passes Supabase's platform verify_jwt). Without this,
  // anyone who knows the URL could burn our Anthropic credits as a free proxy.
  const authHeader = req.headers.get("Authorization") ?? "";
  const supa = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: ures } = await supa.auth.getUser();
  const user = ures?.user;
  if (!user) return json({ error: "unauthorized" }, 401);

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return json({ error: "no_api_key" }, 400);

  // pending-approval and suspended accounts can't spend AI credits
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: prof } = await admin.from("profiles").select("approved,suspended").eq("id", user.id).maybeSingle();
  if (prof && (prof.suspended || prof.approved === false)) return json({ error: "not_allowed" }, 403);

  try {
    if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY) return json({ error: "payload_too_large" }, 413);
    const raw = await req.text();
    if (raw.length > MAX_BODY) return json({ error: "payload_too_large" }, 413);
    const b = (JSON.parse(raw || "{}") ?? {}) as Record<string, unknown>;
    const mode = str(b.mode, 20) || "prioritize";
    // the redesign's modes: prompt + reply check from prompts.ts
    const planned = modeRequest(mode, b);
    if (planned && "error" in planned) return json(planned, 400);
    const body = {
      mode,
      tasks: cleanTasks(b.tasks, mode),
      today: str(b.today, 40) || "today",
      title: str(b.title, MAX_TEXT),
      description: str(b.description, MAX_TEXT),
      question: str(b.question, MAX_TEXT),
    };

    // build a prompt + max_tokens per mode, and how the reply is checked
    let prompt = "";
    let system: string | undefined;
    let maxTokens = 1500;
    let finish: (parsed: Record<string, unknown>) => object | null = (parsed) => parsed;
    if (planned) {
      ({ system, user: prompt, maxTokens, finish } = planned);
    } else if (mode === "breakdown") {
      // split a task into concrete subtasks
      prompt =
        `You are Kanbo, a productivity assistant. Break the following task into 3–7 concrete, actionable subtasks. ` +
        `Return STRICT JSON (no prose, no markdown): {"subtasks":["...","..."]}. Each subtask is a short imperative phrase under 10 words.\n\n` +
        `TASK: ${body.title ?? ""}\nDETAILS: ${body.description ?? ""}`;
      maxTokens = 600;
    } else if (mode === "summary") {
      // weekly summary / standup from the user's tasks
      const list = (body.tasks ?? []).slice(0, 120);
      prompt =
        `You are Kanbo. Write a concise weekly status summary from this JSON of the user's tasks (note completedAt, status, dueDate). ` +
        `Return STRICT JSON: {"summary":"..."} where summary is 3–6 short markdown bullet lines covering: what was completed, what's in progress, what's blocked or overdue, and the focus for next week. Use "- " bullets.\n\n` +
        `TODAY: ${body.today ?? "today"}\nTASKS:\n${JSON.stringify(list)}`;
      maxTokens = 700;
    } else if (mode === "ask") {
      // answer a question about the user's tasks (read-only; no actions)
      const list = (body.tasks ?? []).slice(0, 120);
      prompt =
        `You are Kanbo, a helpful assistant with access to the user's task list (JSON below). ` +
        `Answer their question concisely and specifically, citing task titles where useful. Do not invent tasks. ` +
        `Return STRICT JSON: {"answer":"..."} (markdown allowed in answer).\n\n` +
        `QUESTION: ${body.question ?? ""}\nTODAY: ${body.today ?? "today"}\nTASKS:\n${JSON.stringify(list)}`;
      maxTokens = 800;
    } else {
      // default: prioritize (existing behaviour)
      const open = (body.tasks ?? []).filter((t) => t.status !== "done").slice(0, 60);
      if (open.length === 0) {
        return json({ items: [], summary: "Nothing open to prioritize." });
      }
      prompt =
        `You are Kanbo, a sharp productivity assistant. Today is ${body.today ?? "today"}.\n` +
        `Given this JSON list of the user's open tasks, return STRICT JSON (no prose, no markdown) of the form ` +
        `{"items":[{"id":"...","score":0-100,"reason":"one short sentence"}],"summary":"one sentence on how to approach the day"}. ` +
        `Score by urgency: due/overdue today, things that unblock other work, and high priority rank highest. ` +
        `Keep reasons under 12 words.\n\nTASKS:\n${JSON.stringify(open)}`;
    }

    // ---- per-person daily limit (only calls that reach Claude count) ----
    const limit = Math.max(1, Number(Deno.env.get("AI_DAILY_LIMIT") ?? "") || 200);
    const usage = await countAiCall(admin, user.id, dayIn("Europe/London"), limit);
    if (!usage.allowed) {
      return json({ error: "daily_limit", limit, detail: `You've used today's ${limit} AI requests. They reset at midnight (UK time).` }, 429);
    }

    const model = Deno.env.get("AI_MODEL") || DEFAULT_MODEL;
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model, max_tokens: maxTokens, ...(system ? { system } : {}), messages: [{ role: "user", content: prompt }] }),
    });

    if (!resp.ok) {
      const detail = await resp.text();
      console.error("anthropic error", resp.status, detail.slice(0, 2000));
      return json({ error: "anthropic_error", status: resp.status, detail: detail.slice(0, 300) }, 502);
    }

    // the first text block (a model that thinks puts its thinking first), then
    // its first JSON object, checked for this mode — never a best guess
    const data = await resp.json();
    const blocks: { type?: string; text?: string }[] = Array.isArray(data?.content) ? data.content : [];
    const text = blocks.find((c) => c?.type === "text")?.text ?? "";
    const parsed = firstJsonObject(text);
    const out = parsed && finish(parsed);
    if (!out) {
      // shape only: the reply may quote people's tasks, which never go in logs
      console.error("ai-assist bad_output", mode, data?.stop_reason, text.length);
      return json({ error: "bad_output" }, 502);
    }
    // until migration 0042's ai_usage exists nothing is counted (used 0): say nothing then
    return json(usage.used > 0 ? { ...out, usage: { used: usage.used, limit: usage.limit } } : out);
  } catch (e) {
    return json({ error: "bad_request", detail: String(e).slice(0, 300) }, 400);
  }
});
