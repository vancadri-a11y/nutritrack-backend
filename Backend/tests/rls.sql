-- Run only in a disposable PostgreSQL database, not in your Supabase project.
\set ON_ERROR_STOP on
create role anon nologin;
create role authenticated nologin;
create schema auth;
create table auth.users(id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
grant usage on schema auth, public to authenticated, anon;
grant execute on function auth.uid() to authenticated;
\ir ../migrations/001_users_meals.sql
insert into auth.users values ('11111111-1111-4111-8111-111111111111'), ('22222222-2222-4222-8222-222222222222');
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';
insert into public.profiles(user_id,name) values (auth.uid(),'Ana');
insert into public.meals(id,user_id,recorded_at,title,meal_type,origin,calories,protein,carbs,fat)
values ('33333333-3333-4333-8333-333333333333',auth.uid(),now(),'Pollo','comida','manual',500,35,50,15);
set request.jwt.claim.sub = '22222222-2222-4222-8222-222222222222';
do $$ begin
  if (select count(*) from public.profiles) <> 0 or (select count(*) from public.meals) <> 0 then raise exception 'Data leaked'; end if;
  update public.meals set title = 'Hacked';
  if found then raise exception 'Cross-user update allowed'; end if;
  delete from public.meals;
  if found then raise exception 'Cross-user deletion allowed'; end if;
  begin
    insert into public.profiles(user_id,name) values ('11111111-1111-4111-8111-111111111111','Hacked');
    raise exception 'Cross-user insert allowed';
  exception when insufficient_privilege then null; end;
  begin
    insert into public.meals(id,user_id,recorded_at,title,meal_type,origin,calories,protein,carbs,fat)
    values ('44444444-4444-4444-8444-444444444444','11111111-1111-4111-8111-111111111111',now(),'Hacked','comida','manual',1,1,1,1);
    raise exception 'Cross-user meal insert allowed';
  exception when insufficient_privilege then null; end;
end $$;
set request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';
do $$ begin
  if (select title from public.meals limit 1) <> 'Pollo' then raise exception 'Original meal changed'; end if;
end $$;
reset role;
set role anon;
do $$ begin
  begin perform * from public.meals; raise exception 'Anonymous read allowed';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
select 'RLS isolation verified' as result;
