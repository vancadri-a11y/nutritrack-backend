-- Run as the database owner after migrations 001–004. Only service_role can
-- bind an Apple purchase; an authenticated client cannot edit entitlements.
begin;
create table if not exists public.apple_subscriptions (
  environment text not null check(environment in ('Production','Sandbox')),
  original_transaction_id text not null check(original_transaction_id ~ '^[0-9]{1,40}$'),
  user_id uuid not null references auth.users(id) on delete cascade,
  product_id text not null,
  expires_at timestamptz,
  status integer not null,
  checked_at timestamptz not null default now(),
  primary key(environment,original_transaction_id)
);
create index if not exists apple_subscriptions_user on public.apple_subscriptions(user_id);
create table if not exists public.apple_notification_events (
  notification_id uuid primary key,
  processed_at timestamptz not null default now()
);
alter table public.apple_subscriptions enable row level security;
alter table public.apple_notification_events enable row level security;
revoke all on public.apple_subscriptions,public.apple_notification_events from public,anon,authenticated;

create or replace function public.nutritrack_billing_list(p_user_id uuid)
returns jsonb language sql security definer set search_path=public,pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('original_transaction_id',original_transaction_id,'environment',environment)),'[]'::jsonb)
  from public.apple_subscriptions where user_id=p_user_id;
$$;
create or replace function public.nutritrack_billing_seen(p_notification_id uuid)
returns boolean language sql security definer set search_path=public,pg_temp as $$
  select exists(select 1 from public.apple_notification_events where notification_id=p_notification_id);
$$;
create or replace function public.nutritrack_billing_record(
  p_user_id uuid, p_original_transaction_id text, p_environment text,
  p_product_id text, p_expires_at timestamptz, p_status integer, p_notification_id uuid default null
) returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare existing_user uuid;
begin
  if p_notification_id is not null then
    perform pg_advisory_xact_lock(hashtextextended('apple_notification:'||p_notification_id::text,0));
    if exists(select 1 from public.apple_notification_events where notification_id=p_notification_id) then return false; end if;
  end if;
  if p_user_id is not null and exists(select 1 from auth.users where id=p_user_id) then
    if p_original_transaction_id !~ '^[0-9]{1,40}$' or p_environment not in ('Production','Sandbox')
       or p_product_id !~ '^[-A-Za-z0-9._]{1,200}$' or p_status not between 0 and 5 then raise exception 'Invalid billing record'; end if;
    perform pg_advisory_xact_lock(hashtextextended('apple_transaction:'||p_environment||':'||p_original_transaction_id,0));
    select user_id into existing_user from public.apple_subscriptions
      where environment=p_environment and original_transaction_id=p_original_transaction_id;
    if existing_user is not null and existing_user<>p_user_id then raise exception 'Purchase belongs to another account'; end if;
    insert into public.apple_subscriptions(environment,original_transaction_id,user_id,product_id,expires_at,status,checked_at)
    values(p_environment,p_original_transaction_id,p_user_id,p_product_id,p_expires_at,p_status,now())
    on conflict(environment,original_transaction_id) do update set
      product_id=excluded.product_id,expires_at=excluded.expires_at,status=excluded.status,checked_at=now();
  end if;
  -- Deleting an account never recreates it when delayed Apple events arrive.
  if p_notification_id is not null then insert into public.apple_notification_events(notification_id)values(p_notification_id); end if;
  return true;
end;
$$;
revoke all on function public.nutritrack_billing_list(uuid),public.nutritrack_billing_seen(uuid),
  public.nutritrack_billing_record(uuid,text,text,text,timestamptz,integer,uuid) from public,anon,authenticated;
grant execute on function public.nutritrack_billing_list(uuid),public.nutritrack_billing_seen(uuid),
  public.nutritrack_billing_record(uuid,text,text,text,timestamptz,integer,uuid) to service_role;
commit;
