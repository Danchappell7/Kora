// ============================================================
// KANBO — AI assist Edge Function (Deno / Supabase)
// Calls Claude to prioritize the user's tasks and write a short
// rationale. The client sends its (RLS-filtered) tasks; we never
// touch the DB here. Falls back to a 400 if no key is configured,
// and the client then uses its local heuristic.
//
// Deploy:  supabase functions deploy ai-assist
// Secret:  supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
// ============================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface TaskIn {
  id: string;
  title: string;
  status: string;
  priority: string;
  dueDate?: string | null;
  tags?: string[];
  focusMin?: number;
  blockedBy?: string[];
}

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
  if (!ures?.user) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { ...CORS, "Content-Type": "application/json" } });
  }

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) {
    return new Response(JSON.stringify({ error: "no_api_key" }), { status: 400, headers: { ...CORS, "Content-Type": "application/json" } });
  }

  try {
    const body = await req.json() as { mode?: string; tasks?: TaskIn[]; today?: string; title?: string; description?: string; question?: string };
    const mode = body.mode ?? "prioritize";

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
        return new Response(JSON.stringify({ items: [], summary: "Nothing open to prioritize." }), { headers: { ...CORS, "Content-Type": "application/json" } });
      }
      prompt =
        `You are Kanbo, a sharp productivity assistant. Today is ${body.today ?? "today"}.\n` +
        `Given this JSON list of the user's open tasks, return STRICT JSON (no prose, no markdown) of the form ` +
        `{"items":[{"id":"...","score":0-100,"reason":"one short sentence"}],"summary":"one sentence on how to approach the day"}. ` +
        `Score by urgency: due/overdue today, things that unblock other work, and high priority rank highest. ` +
        `Keep reasons under 12 words.\n\nTASKS:\n${JSON.stringify(open)}`;
    }

    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] }),
    });

    if (!resp.ok) {
      const detail = await resp.text();
      return new Response(JSON.stringify({ error: "anthropic_error", detail }), { status: 502, headers: { ...CORS, "Content-Type": "application/json" } });
    }

    const data = await resp.json();
    const text: string = data?.content?.[0]?.text ?? "{}";
    const jsonStr = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
    const parsed = JSON.parse(jsonStr);
    return new Response(JSON.stringify(parsed), { headers: { ...CORS, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: "bad_request", detail: String(e) }), { status: 400, headers: { ...CORS, "Content-Type": "application/json" } });
  }
});
