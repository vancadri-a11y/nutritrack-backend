begin;
create table public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  name text not null default '' check (length(name) <= 100),
  height_cm numeric check (height_cm between 30 and 300),
  weight_kg numeric check (weight_kg between 1 and 700),
  age integer check (age between 1 and 120),
  goal text check (length(goal) <= 80),
  activity text check (length(activity) <= 80),
  timezone text not null default 'America/Mazatlan' check (length(timezone) <= 80),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table public.meals (
  id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  recorded_at timestamptz not null,
  title text not null check (length(title) between 1 and 200),
  meal_type text not null check (meal_type in ('desayuno','comida','cena','colacion')),
  origin text not null check (origin in ('manual','photo','recipe')),
  calories numeric not null check (calories between 0 and 50000),
  protein numeric not null check (protein between 0 and 10000),
  carbs numeric not null check (carbs between 0 and 10000),
  fat numeric not null check (fat between 0 and 10000),
  notes text not null default '' check (length(notes) <= 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);
create index meals_history on public.meals(user_id, recorded_at desc, id desc);
create function public.nutritrack_updated_at() returns trigger language plpgsql
set search_path = '' as $$ begin new.updated_at = now(); return new; end $$;
create trigger profiles_updated before update on public.profiles for each row execute function public.nutritrack_updated_at();
create trigger meals_updated before update on public.meals for each row execute function public.nutritrack_updated_at();
alter table public.profiles enable row level security;
alter table public.meals enable row level security;
revoke all on public.profiles, public.meals from anon, authenticated;
grant select, insert, update, delete on public.profiles, public.meals to authenticated;
create policy profiles_owner on public.profiles for all to authenticated
using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy meals_owner on public.meals for all to authenticated
using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
commit;
