begin;

-- Only the backend's administrative key can call these functions. Never grant
-- them to authenticated/anon: p_user_id is supplied by verified server identity.
create table public.ai_quota_settings (
  singleton boolean primary key default true check (singleton),
  user_daily_limit integer not null default 5 check (user_daily_limit between 0 and 10000),
  global_daily_limit integer not null default 200 check (global_daily_limit between 0 and 1000000),
  timezone text not null default 'America/Mazatlan'
);
insert into public.ai_quota_settings(singleton) values (true);
create table public.ai_global_usage (
  day date primary key,
  used integer not null default 0 check (used >= 0)
);
create table public.ai_user_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  day date not null,
  used integer not null default 0 check (used >= 0),
  primary key(user_id, day)
);
create table public.ai_reservations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  day date not null,
  request_key text not null check (length(request_key) = 64),
  fingerprint text not null check (length(fingerprint) = 64),
  state text not null default 'reserved' check (state in ('reserved','completed','failed')),
  result jsonb,
  created_at timestamptz not null default now(),
  unique(user_id, day, request_key)
);
alter table public.ai_quota_settings enable row level security;
alter table public.ai_global_usage enable row level security;
alter table public.ai_user_usage enable row level security;
alter table public.ai_reservations enable row level security;
revoke all on public.ai_quota_settings, public.ai_global_usage, public.ai_user_usage, public.ai_reservations from anon, authenticated;
grant all on public.ai_quota_settings, public.ai_global_usage, public.ai_user_usage, public.ai_reservations to service_role;

create function public.nutritrack_usage(p_user_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.ai_quota_settings; d date; u integer; g integer; reset_at timestamptz;
begin
  select * into strict s from public.ai_quota_settings where singleton;
  d := (statement_timestamp() at time zone s.timezone)::date;
  reset_at := (d + 1)::timestamp at time zone s.timezone;
  select used into u from public.ai_user_usage where user_id=p_user_id and day=d;
  select used into g from public.ai_global_usage where day=d;
  return jsonb_build_object('limit',s.user_daily_limit,'used',coalesce(u,0),
    'remaining',greatest(0,s.user_daily_limit-coalesce(u,0)),
    'global_remaining',greatest(0,s.global_daily_limit-coalesce(g,0)),
    'resets_at',to_char(reset_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'));
end $$;

create function public.nutritrack_reserve_ai(p_user_id uuid, p_request_key text, p_fingerprint text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.ai_quota_settings; d date; g integer; u integer; r public.ai_reservations;
begin
  if length(p_request_key) <> 64 or length(p_fingerprint) <> 64 then raise exception 'Invalid fingerprint'; end if;
  if not exists(select 1 from auth.users where id=p_user_id) then raise exception 'Unknown account'; end if;
  select * into strict s from public.ai_quota_settings where singleton for share;
  d := (statement_timestamp() at time zone s.timezone)::date;
  insert into public.ai_global_usage(day) values(d) on conflict do nothing;
  -- Every request locks global first, then user. One transaction reserves both.
  select used into g from public.ai_global_usage where day=d for update;
  insert into public.ai_user_usage(user_id,day) values(p_user_id,d) on conflict do nothing;
  select used into u from public.ai_user_usage where user_id=p_user_id and day=d for update;
  select * into r from public.ai_reservations where user_id=p_user_id and day=d and request_key=p_request_key;
  if found then
    return jsonb_build_object('allowed',false,'reason',case when r.fingerprint<>p_fingerprint then 'conflict' else 'duplicate' end,
      'state',r.state,'result',r.result,'usage',public.nutritrack_usage(p_user_id));
  end if;
  if u>=s.user_daily_limit or g>=s.global_daily_limit then
    return jsonb_build_object('allowed',false,'reason',case when u>=s.user_daily_limit then 'user_quota' else 'global_quota' end,
      'usage',public.nutritrack_usage(p_user_id));
  end if;
  update public.ai_global_usage set used=used+1 where day=d;
  update public.ai_user_usage set used=used+1 where user_id=p_user_id and day=d;
  insert into public.ai_reservations(user_id,day,request_key,fingerprint) values(p_user_id,d,p_request_key,p_fingerprint) returning * into r;
  return jsonb_build_object('allowed',true,'reservation_id',r.id,'usage',public.nutritrack_usage(p_user_id));
end $$;

create function public.nutritrack_finish_ai(p_user_id uuid, p_reservation_id uuid, p_result jsonb) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_result is not null and octet_length(p_result::text)>100000 then raise exception 'Result too large'; end if;
  update public.ai_reservations set state=case when p_result is null then 'failed' else 'completed' end, result=p_result
    where id=p_reservation_id and user_id=p_user_id and state='reserved';
end $$;

-- List metadata only; actual file deletion must use Storage API (not SQL).
create function public.nutritrack_owned_objects(p_user_id uuid) returns jsonb
language sql security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('bucket',o.bucket_id,'name',o.name)), '[]'::jsonb)
  from storage.objects o
  where coalesce(to_jsonb(o)->>'owner_id',to_jsonb(o)->>'owner')=p_user_id::text;
$$;

revoke all on function public.nutritrack_usage(uuid), public.nutritrack_reserve_ai(uuid,text,text),
  public.nutritrack_finish_ai(uuid,uuid,jsonb), public.nutritrack_owned_objects(uuid) from public, anon, authenticated;
grant execute on function public.nutritrack_usage(uuid), public.nutritrack_reserve_ai(uuid,text,text),
  public.nutritrack_finish_ai(uuid,uuid,jsonb), public.nutritrack_owned_objects(uuid) to service_role;
-- Global aggregates survive account deletion; the deleted user's data cascades.
commit;
