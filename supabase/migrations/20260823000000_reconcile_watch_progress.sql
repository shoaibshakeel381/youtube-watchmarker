begin;

-- Upserts from an older browser must never move watch progress backwards.
create or replace function public.preserve_watch_history_progress()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    new.int_timestamp := greatest(old.int_timestamp, new.int_timestamp);
    new.int_count := greatest(
      coalesce(old.int_count, 1),
      coalesce(new.int_count, 1)
    );

    if nullif(btrim(new.str_title), '') is null then
      new.str_title := old.str_title;
    end if;
  end if;

  return new;
end;
$$;

revoke execute on function public.preserve_watch_history_progress()
  from public, anon;

drop trigger if exists preserve_watch_history_progress
  on public.youtube_watch_history;
create trigger preserve_watch_history_progress
before update on public.youtube_watch_history
for each row execute function public.preserve_watch_history_progress();

-- There was no Auth owner before the RLS migration. Reconcile the preserved
-- rows only when the project has exactly one user, deriving that ID at runtime.
do $$
declare
  target_user_id uuid;
begin
  if (select count(*) from auth.users) <> 1 then
    raise exception
      'Expected exactly one Auth user before reconciling legacy watch history';
  end if;

  select id into target_user_id from auth.users;

  insert into public.youtube_watch_history (
    user_id,
    str_ident,
    int_timestamp,
    str_title,
    int_count,
    created_at,
    updated_at
  )
  select
    target_user_id,
    legacy.str_ident,
    legacy.int_timestamp,
    legacy.str_title,
    coalesce(legacy.int_count, 1),
    legacy.created_at,
    legacy.updated_at
  from private.youtube_watch_history_legacy_20260822 legacy
  on conflict (user_id, str_ident) do update
  set
    int_timestamp = greatest(
      youtube_watch_history.int_timestamp,
      excluded.int_timestamp
    ),
    int_count = greatest(
      coalesce(youtube_watch_history.int_count, 1),
      coalesce(excluded.int_count, 1)
    ),
    str_title = case
      when nullif(btrim(youtube_watch_history.str_title), '') is null
        then excluded.str_title
      else youtube_watch_history.str_title
    end,
    created_at = least(
      youtube_watch_history.created_at,
      excluded.created_at
    ),
    updated_at = greatest(
      youtube_watch_history.updated_at,
      excluded.updated_at
    );
end;
$$;

commit;
