// ============================================================
// KANBO — AI assist Edge Function (Deno / Supabase)
// Calls Claude to prioritize the user's tasks and write a short
// rationale. The client sends its (RLS-filtered) tasks; we never read
// task data from the DB here (only the caller's profile and usage count).
// Falls back to a 400 if no key is configured, and the client then uses
// its local heuristic.
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
// ============================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { countAiCall, dayIn } from "../_shared/limits.ts";
import { cleanTasks, str } from "./tasks.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const MAX_BODY = 4_000_000; // bytes of JSON we'll read at all
const MAX_TEXT = 4_000;     // question / title / description
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
    const body = {
      mode,
      tasks: cleanTasks(b.tasks, mode),
      today: str(b.today, 40) || "today",
      title: str(b.title, MAX_TEXT),
      description: str(b.description, MAX_TEXT),
      question: str(b.question, MAX_TEXT),
    };

    // build a prompt + max_tokens per mode
    let prompt = "";
    let maxTokens = 1500;
    if (mode === "breakdown") {
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

    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] }),
    });

    if (!resp.ok) {
      const detail = await resp.text();
      console.error("anthropic error", resp.status, detail.slice(0, 2000));
      return json({ error: "anthropic_error", status: resp.status, detail: detail.slice(0, 300) }, 502);
    }

    const data = await resp.json();
    const text: string = data?.content?.[0]?.text ?? "{}";
    const jsonStr = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
    const parsed = JSON.parse(jsonStr);
    return json(parsed);
  } catch (e) {
    return json({ error: "bad_request", detail: String(e).slice(0, 300) }, 400);
  }
});
