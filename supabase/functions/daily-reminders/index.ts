// ============================================================
// KANBO — daily reminder emails (Deno / Supabase Edge Function)
// Finds tasks due today or overdue (not done) and emails each
// assignee a digest. Meant to be run once a day by a cron.
//
// Deploy:  supabase functions deploy daily-reminders --no-verify-jwt
// Secrets: supabase secrets set RESEND_API_KEY=re_...   (resend.com)
//          supabase secrets set REMINDER_FROM="Kanbo <no-reply@yourdomain.com>"
//          supabase secrets set APP_URL=https://your-app.vercel.app
// Schedule (Supabase Dashboard → Database → Cron, or pg_cron):
//   select cron.schedule('kanbo-daily-reminders','0 13 * * *',
//     $$ select net.http_post(
//          url := 'https://<project>.supabase.co/functions/v1/daily-reminders',
//          headers := jsonb_build_object('Authorization','Bearer <service-role-key>')) $$);
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

interface TaskRow { id: string; title: string; due_date: string; status: string; assignee_id: string; priority: string; }

Deno.serve(async () => {
  const url = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const resendKey = Deno.env.get("RESEND_API_KEY");
  const from = Deno.env.get("REMINDER_FROM") ?? "Kanbo <onboarding@resend.dev>";
  const appUrl = Deno.env.get("APP_URL") ?? "";

  if (!resendKey) return new Response(JSON.stringify({ error: "no RESEND_API_KEY" }), { status: 400 });

  const supa = createClient(url, serviceKey);
  const today = new Date().toISOString().slice(0, 10);

  // tasks due today or earlier, not done
  const { data, error } = await supa
    .from("tasks")
    .select("id,title,due_date,status,assignee_id,priority")
    .lte("due_date", today)
    .neq("status", "done");
  if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500 });

  const tasks = (data ?? []) as TaskRow[];
  if (tasks.length === 0) return new Response(JSON.stringify({ sent: 0, note: "nothing due" }), { status: 200 });

  // map assignee ids → email (auth.users via admin API)
  const byAssignee = new Map<string, TaskRow[]>();
  for (const t of tasks) {
    if (!t.assignee_id) continue;
    (byAssignee.get(t.assignee_id) ?? byAssignee.set(t.assignee_id, []).get(t.assignee_id)!).push(t);
  }

  let sent = 0;
  for (const [userId, list] of byAssignee) {
    const { data: u } = await supa.auth.admin.getUserById(userId);
    const email = u?.user?.email;
    if (!email) continue;

    const rows = list
      .sort((a, b) => a.due_date.localeCompare(b.due_date))
      .map((t) => {
        const overdue = t.due_date < today;
        return `<tr><td style="padding:8px 0;border-bottom:1px solid #eee">${t.title}</td>` +
          `<td style="padding:8px 0;border-bottom:1px solid #eee;color:${overdue ? "#c0392b" : "#555"};text-align:right">${overdue ? "Overdue" : "Today"}</td></tr>`;
      })
      .join("");

    const html =
      `<div style="font-family:-apple-system,sans-serif;max-width:520px;margin:auto">` +
      `<h2 style="font-weight:600">Your day on Kanbo</h2>` +
      `<p style="color:#555">You have <strong>${list.length}</strong> task${list.length === 1 ? "" : "s"} due today or overdue.</p>` +
      `<table style="width:100%;border-collapse:collapse;font-size:14px">${rows}</table>` +
      (appUrl ? `<p style="margin-top:20px"><a href="${appUrl}" style="background:#3b5bff;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">Open Kanbo</a></p>` : "") +
      `</div>`;

    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: email, subject: `${list.length} task${list.length === 1 ? "" : "s"} due on Kanbo`, html }),
    });
    if (r.ok) sent++;
  }

  return new Response(JSON.stringify({ sent }), { status: 200, headers: { "Content-Type": "application/json" } });
});
