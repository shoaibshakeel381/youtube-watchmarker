begin;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to service_role;

alter table public.youtube_watch_history_legacy_20260822
  set schema private;
grant select on private.youtube_watch_history_legacy_20260822 to service_role;

commit;
