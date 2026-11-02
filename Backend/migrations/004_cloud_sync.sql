begin;
create table public.sync_records (
  user_id uuid not null references auth.users(id) on delete cascade,
  key text not null check (key = 'profile' or key ~ '^(meal|water|workout|log):[0-9a-fA-F-]{36}$'),
  revision bigint not null,
  version bigint not null default 1 check (version > 0),
  deleted boolean not null default false,
  payload jsonb,
  updated_at timestamptz not null default now(),
  primary key (user_id, key),
  check ((deleted and payload is null) or (not deleted and payload is not null and jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 100000))
);
create index sync_revision on public.sync_records(user_id, revision);
create table public.sync_heads (
  user_id uuid primary key references auth.users(id) on delete cascade,
  revision bigint not null default 0
);
alter table public.sync_heads enable row level security;
revoke all on public.sync_heads from anon, authenticated;
alter table public.sync_records enable row level security;
revoke all on public.sync_records from anon, authenticated;
grant select on public.sync_records to authenticated;
create policy sync_read_own on public.sync_records for select to authenticated using ((select auth.uid()) = user_id);
-- Mutations are compare-and-swap operations. Clients cannot edit ownership or versions.
create function public.nutritrack_sync(p_items jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare u uuid := auth.uid(); i jsonb; r public.sync_records; output jsonb := '[]'::jsonb; expected bigint; rev bigint;
begin
  if u is null then raise exception 'Authentication required'; end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items)>50 or octet_length(p_items::text)>512000 then raise exception 'Invalid batch'; end if;
  -- Serialize a user's batches, including concurrent first inserts.
  perform pg_advisory_xact_lock(hashtextextended(u::text, 58));
  insert into public.sync_heads(user_id) values(u) on conflict do nothing;
  for i in select value from jsonb_array_elements(p_items) loop
    if not (i ?& array['key','base_version','deleted','payload']) or (i->>'base_version')::bigint < 0
      or jsonb_typeof(i->'deleted') <> 'boolean' then raise exception 'Invalid record'; end if;
    expected := (i->>'base_version')::bigint;
    select * into r from public.sync_records where user_id=u and key=i->>'key' for update;
    if (found and r.version<>expected) or (not found and expected<>0) then
      output := output || jsonb_build_array(jsonb_build_object('conflict',true,'item',case when r.key is null then null else jsonb_build_object('key',r.key,'version',r.version,'deleted',r.deleted,'payload',r.payload) end));
      continue;
    end if;
    update public.sync_heads set revision=revision+1 where user_id=u returning revision into rev;
    insert into public.sync_records(user_id,key,revision,version,deleted,payload)
      values(u,i->>'key',rev,expected+1,(i->>'deleted')::boolean,nullif(i->'payload','null'::jsonb))
      on conflict(user_id,key) do update set revision=excluded.revision,version=excluded.version,deleted=excluded.deleted,payload=excluded.payload,updated_at=now()
      returning * into r;
    output := output || jsonb_build_array(jsonb_build_object('conflict',false,'item',jsonb_build_object('key',r.key,'version',r.version,'deleted',r.deleted,'payload',r.payload)));
  end loop;
  return jsonb_build_object('results',output);
end $$;
revoke all on function public.nutritrack_sync(jsonb) from public, anon;
grant execute on function public.nutritrack_sync(jsonb) to authenticated;
-- A committed per-account clock avoids gaps from out-of-order sequence commits.
-- Pagination uses a fixed upper bound. A row edited while paging is picked up
-- by the next cycle with its newer revision; tombstones are never removed.
create function public.nutritrack_pull_sync(p_after bigint default 0,p_until bigint default null,p_limit integer default 50) returns jsonb
language plpgsql security definer set search_path='' as $$
declare u uuid := auth.uid(); head bigint; upper_bound bigint; items jsonb; next_cursor bigint; more boolean;
begin
  if u is null then raise exception 'Authentication required'; end if;
  if p_after<0 or p_limit<1 or p_limit>50 then raise exception 'Invalid cursor'; end if;
  select revision into head from public.sync_heads where user_id=u;
  head := coalesce(head,0);
  upper_bound := coalesce(p_until,head);
  if upper_bound>head or upper_bound<p_after then raise exception 'Invalid snapshot'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('key',r.key,'version',r.version,'deleted',r.deleted,'payload',r.payload) order by r.revision),'[]'::jsonb),max(r.revision)
    into items,next_cursor from (select * from public.sync_records where user_id=u and revision>p_after and revision<=upper_bound order by revision limit p_limit) r;
  next_cursor := coalesce(next_cursor,p_after);
  select exists(select 1 from public.sync_records where user_id=u and revision>next_cursor and revision<=upper_bound) into more;
  if not more then next_cursor := upper_bound; end if;
  return jsonb_build_object('items',items,'next_cursor',next_cursor,'until',upper_bound,'has_more',more);
end $$;
revoke all on function public.nutritrack_pull_sync(bigint,bigint,integer) from public,anon;
grant execute on function public.nutritrack_pull_sync(bigint,bigint,integer) to authenticated;
commit;
