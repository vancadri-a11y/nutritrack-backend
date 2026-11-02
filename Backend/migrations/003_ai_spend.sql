begin;
alter table public.ai_quota_settings
  add column daily_budget_microusd bigint not null default 1000000 check (daily_budget_microusd >= 0),
  add column monthly_budget_microusd bigint not null default 8000000 check (monthly_budget_microusd >= 0),
  add column max_input_tokens integer not null default 40000 check (max_input_tokens between 1 and 1000000),
  add column max_output_tokens integer not null default 7000 check (max_output_tokens between 1 and 100000);
-- Integer micro-USD per million tokens. Unknown models fail closed.
create table public.ai_model_rates (
  model text primary key,
  input_rate bigint not null check (input_rate>=0),
  cached_rate bigint not null check (cached_rate>=0 and cached_rate<=input_rate),
  output_rate bigint not null check (output_rate>=0)
);
insert into public.ai_model_rates values ('gpt-4o-mini',150000,75000,600000), ('gpt-4o-mini-2024-07-18',150000,75000,600000);
create table public.ai_spend_totals (
  period text not null check (period in ('day','month')),
  starts_on date not null,
  charged_microusd bigint not null default 0 check (charged_microusd>=0),
  primary key(period, starts_on)
);
create table public.ai_spend_attempts (
  id uuid primary key default gen_random_uuid(),
  reservation_id uuid references public.ai_reservations(id) on delete set null,
  -- Spend survives deletion of an account; user identifiers are removed.
  user_id uuid references auth.users(id) on delete set null,
  day date not null, month date not null, model text not null,
  input_rate bigint not null, cached_rate bigint not null, output_rate bigint not null,
  reserved_input integer not null, reserved_output integer not null,
  reserved_microusd bigint not null, charged_microusd bigint not null,
  input_tokens integer, output_tokens integer, cached_tokens integer,
  response_id text, state text not null default 'uncertain' check (state in ('uncertain','settled')),
  created_at timestamptz not null default now()
);
alter table public.ai_model_rates enable row level security;
alter table public.ai_spend_totals enable row level security;
alter table public.ai_spend_attempts enable row level security;
revoke all on public.ai_model_rates, public.ai_spend_totals, public.ai_spend_attempts from anon,authenticated;
grant all on public.ai_model_rates, public.ai_spend_totals, public.ai_spend_attempts to service_role;

create function public.nutritrack_reserve_spend(p_user_id uuid,p_reservation_id uuid,p_model text,p_input_tokens integer,p_output_tokens integer) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s public.ai_quota_settings; rates public.ai_model_rates; d date; m date; day_spend bigint; month_spend bigint; amount bigint; attempt uuid;
begin
  select * into strict s from public.ai_quota_settings where singleton for share;
  if p_input_tokens is null or p_output_tokens is null or p_input_tokens<0 or p_input_tokens>s.max_input_tokens or p_output_tokens<1 or p_output_tokens>s.max_output_tokens then
    return jsonb_build_object('allowed',false,'reason','token_limit');
  end if;
  if not exists(select 1 from public.ai_reservations where id=p_reservation_id and user_id=p_user_id and state='reserved') then raise exception 'Invalid reservation'; end if;
  select * into rates from public.ai_model_rates where model=p_model;
  if not found then return jsonb_build_object('allowed',false,'reason','model_rate_missing'); end if;
  d := (statement_timestamp() at time zone s.timezone)::date;
  m := date_trunc('month', d)::date;
  amount := ceil((p_input_tokens::numeric*rates.input_rate+p_output_tokens::numeric*rates.output_rate)/1000000)::bigint;
  insert into public.ai_spend_totals(period,starts_on) values('month',m),('day',d) on conflict do nothing;
  -- Consistent lock order across all replicas and settlement calls.
  select charged_microusd into month_spend from public.ai_spend_totals where period='month' and starts_on=m for update;
  select charged_microusd into day_spend from public.ai_spend_totals where period='day' and starts_on=d for update;
  if day_spend+amount>s.daily_budget_microusd or month_spend+amount>s.monthly_budget_microusd then
    return jsonb_build_object('allowed',false,'reason','budget_exhausted');
  end if;
  update public.ai_spend_totals set charged_microusd=charged_microusd+amount where (period='month' and starts_on=m) or (period='day' and starts_on=d);
  insert into public.ai_spend_attempts(reservation_id,user_id,day,month,model,input_rate,cached_rate,output_rate,reserved_input,reserved_output,reserved_microusd,charged_microusd)
    values(p_reservation_id,p_user_id,d,m,p_model,rates.input_rate,rates.cached_rate,rates.output_rate,p_input_tokens,p_output_tokens,amount,amount) returning id into attempt;
  return jsonb_build_object('allowed',true,'spend_id',attempt);
end $$;

create function public.nutritrack_finish_spend(p_user_id uuid,p_spend_id uuid,p_input_tokens integer,p_output_tokens integer,p_cached_tokens integer,p_response_id text) returns void
language plpgsql security definer set search_path='' as $$
declare a public.ai_spend_attempts; amount bigint;
begin
  select * into strict a from public.ai_spend_attempts where id=p_spend_id and user_id=p_user_id for update;
  if a.state='settled' then return; end if;
  if p_input_tokens is null or p_output_tokens is null or p_cached_tokens is null or p_input_tokens<0 or p_output_tokens<0 or p_cached_tokens<0 or p_cached_tokens>p_input_tokens then raise exception 'Invalid usage'; end if;
  amount := ceil(((p_input_tokens-p_cached_tokens)::numeric*a.input_rate+p_cached_tokens::numeric*a.cached_rate+p_output_tokens::numeric*a.output_rate)/1000000)::bigint;
  perform 1 from public.ai_spend_totals where period='month' and starts_on=a.month for update;
  perform 1 from public.ai_spend_totals where period='day' and starts_on=a.day for update;
  update public.ai_spend_totals set charged_microusd=charged_microusd+amount-a.charged_microusd
    where (period='month' and starts_on=a.month) or (period='day' and starts_on=a.day);
  update public.ai_spend_attempts set state='settled',charged_microusd=amount,input_tokens=p_input_tokens,output_tokens=p_output_tokens,cached_tokens=p_cached_tokens,response_id=left(p_response_id,200) where id=a.id;
end $$;
revoke all on function public.nutritrack_reserve_spend(uuid,uuid,text,integer,integer),public.nutritrack_finish_spend(uuid,uuid,integer,integer,integer,text) from public,anon,authenticated;
grant execute on function public.nutritrack_reserve_spend(uuid,uuid,text,integer,integer),public.nutritrack_finish_spend(uuid,uuid,integer,integer,integer,text) to service_role;

-- Existing account usage contract plus an availability flag. Do not disclose global billing to clients.
create or replace function public.nutritrack_usage(p_user_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s public.ai_quota_settings; d date; u integer; g integer; reset_at timestamptz; spend_day bigint; spend_month bigint;
begin
  select * into strict s from public.ai_quota_settings where singleton;
  d := (statement_timestamp() at time zone s.timezone)::date;
  reset_at := (d+1)::timestamp at time zone s.timezone;
  select used into u from public.ai_user_usage where user_id=p_user_id and day=d;
  select used into g from public.ai_global_usage where day=d;
  select charged_microusd into spend_day from public.ai_spend_totals where period='day' and starts_on=d;
  select charged_microusd into spend_month from public.ai_spend_totals where period='month' and starts_on=date_trunc('month',d)::date;
  return jsonb_build_object('limit',s.user_daily_limit,'used',coalesce(u,0),'remaining',greatest(0,s.user_daily_limit-coalesce(u,0)),
    'global_remaining',greatest(0,s.global_daily_limit-coalesce(g,0)),
    'budget_available',coalesce(spend_day,0)<s.daily_budget_microusd and coalesce(spend_month,0)<s.monthly_budget_microusd,
    'resets_at',to_char(reset_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'));
end $$;
commit;
