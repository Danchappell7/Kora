-- ============================================================
-- KANBO — richer recurrence (2026-06-21)
--   Add "weekdays" (Mon–Fri) and "biweekly" (every 2 weeks) to the allowed
--   recurrence values. Idempotent.
-- ============================================================

alter table public.tasks drop constraint if exists tasks_recurrence_check;
alter table public.tasks
  add constraint tasks_recurrence_check
  check (recurrence in ('none','daily','weekdays','weekly','biweekly','monthly'));
