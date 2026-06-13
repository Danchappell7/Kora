// ============================================================
// KORA — AI assist Edge Function (Deno / Supabase)
// Calls Claude to prioritize the user's tasks and write a short
// rationale. The client sends its (RLS-filtered) tasks; we never
// touch the DB here. Falls back to a 400 if no key is configured,
// and the client then uses its local heuristic.
//
// Deploy:  supabase functions deploy ai-assist
// Secret:  supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
// ============================================================

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

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) {
    return new Response(JSON.stringify({ error: "no_api_key" }), { status: 400, headers: { ...CORS, "Content-Type": "application/json" } });
  }

  try {
    const { tasks, today } = await req.json() as { tasks: TaskIn[]; today?: string };
    const open = (tasks ?? []).filter((t) => t.status !== "done").slice(0, 60);
    if (open.length === 0) {
      return new Response(JSON.stringify({ items: [], summary: "Nothing open to prioritize." }), { headers: { ...CORS, "Content-Type": "application/json" } });
    }

    const prompt =
      `You are Kora, a sharp productivity assistant. Today is ${today ?? "today"}.\n` +
      `Given this JSON list of the user's open tasks, return STRICT JSON (no prose, no markdown) of the form ` +
      `{"items":[{"id":"...","score":0-100,"reason":"one short sentence"}],"summary":"one sentence on how to approach the day"}. ` +
      `Score by urgency: due/overdue today, things that unblock other work, and high priority rank highest. ` +
      `Keep reasons under 12 words.\n\nTASKS:\n${JSON.stringify(open)}`;

    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1500,
        messages: [{ role: "user", content: prompt }],
      }),
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
