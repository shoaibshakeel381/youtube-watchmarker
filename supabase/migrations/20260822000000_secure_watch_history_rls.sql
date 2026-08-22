begin;

-- Preserve the pre-Auth rows for an administrator-assisted recovery. They are
-- deliberately not exposed to browser clients because they have no owner.
create table public.youtube_watch_history_legacy_20260822
  (like public.youtube_watch_history including all);
insert into public.youtube_watch_history_legacy_20260822
select * from public.youtube_watch_history;
comment on table public.youtube_watch_history_legacy_20260822 is
  'Pre-Auth watch history archived before owner-scoped RLS was enabled.';
alter table public.youtube_watch_history_legacy_20260822
  enable row level security;
revoke all on public.youtube_watch_history_legacy_20260822
  from public, anon, authenticated;
grant select on public.youtube_watch_history_legacy_20260822 to service_role;

truncate table public.youtube_watch_history;
alter table public.youtube_watch_history
  drop constraint youtube_watch_history_pkey;
alter table public.youtube_watch_history
  add column user_id uuid not null default auth.uid()
  references auth.users(id) on delete cascade;
alter table public.youtube_watch_history
  add primary key (user_id, str_ident);
create index idx_youtube_watch_history_user_timestamp
  on public.youtube_watch_history (user_id, int_timestamp desc);

drop policy if exists "Allow authenticated users to view watch history"
  on public.youtube_watch_history;
drop policy if exists "Allow authenticated users to insert watch history"
  on public.youtube_watch_history;
drop policy if exists "Allow authenticated users to update watch history"
  on public.youtube_watch_history;
drop policy if exists "Allow authenticated users to delete watch history"
  on public.youtube_watch_history;

alter table public.youtube_watch_history enable row level security;

create policy "Users can view their watch history"
  on public.youtube_watch_history for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "Users can insert their watch history"
  on public.youtube_watch_history for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy "Users can update their watch history"
  on public.youtube_watch_history for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
create policy "Users can delete their watch history"
  on public.youtube_watch_history for delete to authenticated
  using ((select auth.uid()) = user_id);

revoke all on public.youtube_watch_history from anon;
grant select, insert, update, delete
  on public.youtube_watch_history to authenticated;

-- These SECURITY DEFINER helpers were previously callable through the public
-- Data API. Keep them available only to the server-side service role.
revoke execute on function public.audit_youtube_watch_history()
  from public, anon, authenticated;
revoke execute on function public.cleanup_old_watch_history(integer)
  from public, anon, authenticated;
revoke execute on function public.get_rls_status()
  from public, anon, authenticated;
revoke execute on function public.get_user_watch_count()
  from public, anon, authenticated;
grant execute on function public.audit_youtube_watch_history() to service_role;
grant execute on function public.cleanup_old_watch_history(integer)
  to service_role;
grant execute on function public.get_rls_status() to service_role;
grant execute on function public.get_user_watch_count() to service_role;

notify pgrst, 'reload schema';

commit;
