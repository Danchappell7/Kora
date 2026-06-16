-- ============================================================
-- KANBO — initial schema (tasks, subtasks, dependencies) + RLS
-- + per-user demo-data seed on signup.
--
-- Slice 1: tasks are persisted per user. Projects, workspaces,
-- and teammates remain front-end reference data (data/data.ts);
-- the seed references them by their stable string ids
-- ("p-launch", "m-1", …). The signed-in user owns their tasks
-- and is the "self" assignee (assignee_id = their auth uid).
--
-- Apply with the Supabase CLI:  supabase db push
-- or paste into the SQL editor in the Supabase dashboard.
-- ============================================================

-- ---------- tables ----------
create table if not exists public.tasks (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users (id) on delete cascade,
  title             text not null,
  description       text default '',
  status            text not null default 'todo'
                      check (status in ('todo','progress','review','blocked','done')),
  priority          text not null default 'medium'
                      check (priority in ('low','medium','high','urgent')),
  project_id        text not null,
  assignee_id       text not null,
  due_date          date,
  original_due_date date,
  completed_at      date,
  tags              text[] not null default '{}',
  focus_min         integer not null default 30,
  comments          integer not null default 0,
  ai_score          integer not null default 0,
  ai_reason         text,
  energy            text check (energy in ('deep','create','collab','admin')),
  dur               integer,
  scheduled         integer,
  plan_today        boolean not null default false,
  created_at        timestamptz not null default now()
);
create index if not exists tasks_user_id_idx on public.tasks (user_id);

create table if not exists public.subtasks (
  id        uuid primary key default gen_random_uuid(),
  task_id   uuid not null references public.tasks (id) on delete cascade,
  title     text not null,
  done      boolean not null default false,
  position  integer not null default 0
);
create index if not exists subtasks_task_id_idx on public.subtasks (task_id);

create table if not exists public.task_dependencies (
  task_id     uuid not null references public.tasks (id) on delete cascade,
  depends_on  uuid not null references public.tasks (id) on delete cascade,
  primary key (task_id, depends_on)
);

-- ---------- row-level security ----------
alter table public.tasks enable row level security;
alter table public.subtasks enable row level security;
alter table public.task_dependencies enable row level security;

create policy "own tasks" on public.tasks
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "own subtasks" on public.subtasks
  for all using (exists (select 1 from public.tasks t where t.id = task_id and t.user_id = auth.uid()))
  with check (exists (select 1 from public.tasks t where t.id = task_id and t.user_id = auth.uid()));

create policy "own dependencies" on public.task_dependencies
  for all using (exists (select 1 from public.tasks t where t.id = task_id and t.user_id = auth.uid()))
  with check (exists (select 1 from public.tasks t where t.id = task_id and t.user_id = auth.uid()));

-- ============================================================
-- Demo-data seed — gives every new account a populated workspace.
-- Dates are relative to signup day. Remove the trigger at the
-- bottom once you don't want auto-seeded demo data.
-- ============================================================
create or replace function public.seed_demo_data(uid uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  t1 uuid; t2 uuid; t4 uuid; t6 uuid; t9 uuid;
begin
  insert into tasks (user_id,title,status,priority,project_id,assignee_id,due_date,original_due_date,tags,ai_score,ai_reason,focus_min,comments,energy,dur,plan_today,description)
    values (uid,'Finalize Q3 launch narrative deck','progress','urgent','p-launch',uid::text,current_date,current_date+2,array['writing'],96,'Blocks 3 downstream tasks and is due today.',90,4,'deep',90,true,'Tighten the story arc, land the ''why now'', and cut to 14 slides.')
    returning id into t1;
  insert into tasks (user_id,title,status,priority,project_id,assignee_id,due_date,tags,ai_score,ai_reason,focus_min,comments,energy,dur,plan_today)
    values (uid,'Ship onboarding redesign to staging','blocked','high','p-launch','m-1',current_date+1,array['eng','design'],88,'Waiting on design tokens — nudge Sana to unblock.',120,2,'create',120,false)
    returning id into t2;
  insert into tasks (user_id,title,status,priority,project_id,assignee_id,due_date,tags,ai_score,ai_reason,focus_min,comments,energy,dur,plan_today)
    values (uid,'Run pricing-page A/B test','todo','high','p-growth','m-2',current_date+3,array['research','eng'],74,'High expected lift; start once deck is out.',60,1,'collab',60,true);
  insert into tasks (user_id,title,status,priority,project_id,assignee_id,due_date,tags,ai_score,ai_reason,focus_min,comments,energy,dur,plan_today,description)
    values (uid,'Define design tokens v2','review','high','p-brand','m-3',current_date,array['design'],81,'In review — unblocks onboarding redesign.',45,6,'create',45,false,'Color, type scale, spacing, and motion primitives.')
    returning id into t4;
  insert into tasks (user_id,title,status,priority,project_id,assignee_id,due_date,tags,ai_score,ai_reason,focus_min,comments,energy,dur,plan_today)
    values (uid,'Draft investor update — May','todo','medium','p-personal',uid::text,current_date+2,array['writing'],58,'Recurring; batch with deck writing.',40,0,'deep',40,true);
  insert into tasks (user_id,title,status,priority,project_id,assignee_id,due_date,tags,ai_score,ai_reason,focus_min,comments,energy,dur,plan_today)
    values (uid,'Migrate auth to edge sessions','progress','urgent','p-infra','m-1',current_date+1,array['eng'],91,'Security-sensitive and time-boxed this sprint.',150,3,'deep',150,true)
    returning id into t6;
  insert into tasks (user_id,title,status,priority,project_id,assignee_id,due_date,tags,ai_score,ai_reason,focus_min,comments,energy,dur,plan_today)
    values (uid,'Interview 5 churned users','todo','medium','p-growth','m-4',current_date+4,array['research'],49,'Schedule mornings — your focus peaks then.',60,0,'collab',60,false);
  insert into tasks (user_id,title,status,priority,project_id,assignee_id,due_date,tags,ai_score,ai_reason,focus_min,comments,energy,dur,plan_today)
    values (uid,'Fix flaky CI on macOS runners','todo','low','p-infra','m-2',current_date+6,array['bug','eng'],33,'Low urgency; good filler for fragmented time.',30,1,'deep',30,false);
  insert into tasks (user_id,title,status,priority,project_id,assignee_id,due_date,tags,ai_score,ai_reason,focus_min,comments,energy,dur,plan_today)
    values (uid,'Set up usage analytics events','review','medium','p-launch','m-1',current_date+2,array['eng'],61,'Needs edge sessions merged first.',45,0,'deep',45,true)
    returning id into t9;
  insert into tasks (user_id,title,status,priority,project_id,assignee_id,due_date,tags,ai_score,ai_reason,focus_min,comments,energy,dur,plan_today)
    values (uid,'Weekly review & plan','todo','low','p-personal',uid::text,current_date,array['ops'],40,'Anchor habit — keep the Friday slot.',25,0,'admin',25,true);
  insert into tasks (user_id,title,status,priority,project_id,assignee_id,due_date,completed_at,tags,ai_score,focus_min,energy,dur)
    values (uid,'Approve Q3 launch budget','done','high','p-launch',uid::text,current_date-1,current_date-1,array['ops'],70,20,'admin',20);
  insert into tasks (user_id,title,status,priority,project_id,assignee_id,due_date,completed_at,tags,ai_score,focus_min,energy,dur)
    values (uid,'Pick launch date with leadership','done','high','p-launch',uid::text,current_date-2,current_date-2,array['ops'],65,30,'admin',30);
  insert into tasks (user_id,title,status,priority,project_id,assignee_id,due_date,completed_at,tags,ai_score,focus_min,energy,dur)
    values (uid,'Audit landing-page performance','done','medium','p-growth','m-2',current_date-3,current_date-3,array['eng'],44,40,'deep',40);
  insert into tasks (user_id,title,status,priority,project_id,assignee_id,due_date,completed_at,tags,ai_score,focus_min,energy,dur)
    values (uid,'Competitor teardown — 3 tools','done','low','p-growth','m-4',current_date-2,current_date-2,array['research'],38,60,'collab',60);
  insert into tasks (user_id,title,status,priority,project_id,assignee_id,due_date,completed_at,tags,ai_score,focus_min,energy,dur)
    values (uid,'Refresh brand color palette','done','medium','p-brand','m-3',current_date-4,current_date-1,array['design'],50,50,'create',50);

  insert into subtasks (task_id,title,done,position) values
    (t1,'Rewrite opening hook',true,0),
    (t1,'Add traction chart',true,1),
    (t1,'Trim to 14 slides',false,2),
    (t6,'Spike: token rotation',true,0),
    (t6,'Rollout behind flag',false,1);

  insert into task_dependencies (task_id,depends_on) values (t2,t4),(t9,t6);
end;
$$;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.seed_demo_data(new.id);
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
