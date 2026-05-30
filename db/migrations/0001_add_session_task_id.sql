-- Link every agent session to the task it belongs to.
--
-- A task (Linear issue, via the Soda Straw board) can own many sessions; each
-- session points back at its task. Nullable so sessions created before this
-- migration (and any future task-less session) still load. See app/types.ts
-- (SessionMeta.taskId) and app/persistence.ts (Row.task_id).
--
-- The sessions table lives in the Supabase project rave-of-agents
-- (ref ielmaqllavpnmolnlupf). Apply via the Soda Straw `supabase` straw
-- (apply_migration / execute_sql) or the Supabase SQL editor.

alter table public.sessions
  add column if not exists task_id text;

-- Filtering sessions by task ("show all sessions for this task") is the common
-- read pattern, so index the foreign key.
create index if not exists sessions_task_id_idx
  on public.sessions (task_id);
