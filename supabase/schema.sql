create extension if not exists pgcrypto;

do $$ begin
  create type public.app_role as enum ('admin', 'supervisor', 'advisor');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.team_type as enum ('rental', 'sales');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.appointment_status as enum ('pending', 'confirmed', 'completed', 'cancelled');
exception when duplicate_object then null;
end $$;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null unique,
  full_name text not null,
  role public.app_role not null default 'advisor',
  team public.team_type,
  color text check (color is null or color in ('amber', 'teal', 'blue', 'violet', 'coral')),
  active boolean not null default true,
  must_change_password boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint advisor_fields check (
    (role = 'supervisor' and team is null and color is null)
    or role <> 'supervisor'
  )
);

create table if not exists public.appointments (
  id uuid primary key default gen_random_uuid(),
  appointment_date date not null,
  appointment_time time not null,
  subject text not null check (char_length(trim(subject)) between 1 and 160),
  client text not null check (char_length(trim(client)) between 1 and 160),
  phone text not null default '',
  property text not null default '',
  status public.appointment_status not null default 'pending',
  notes text not null default '',
  advisor_id uuid not null references public.profiles(id),
  advisor_name text not null,
  advisor_team public.team_type not null,
  advisor_color text not null,
  created_by uuid not null references public.profiles(id),
  updated_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists appointments_date_idx on public.appointments(appointment_date, appointment_time);
create index if not exists appointments_advisor_idx on public.appointments(advisor_id);

create or replace function public.current_profile_role()
returns public.app_role
language sql
stable
security definer
set search_path = public
as $$
  select role from public.profiles
  where id = auth.uid() and active = true and must_change_password = false;
$$;

create or replace function public.is_active_user()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists(
    select 1 from public.profiles
    where id = auth.uid() and active = true and must_change_password = false
  );
$$;

drop function if exists public.list_advisors();
create function public.list_advisors()
returns table (id uuid, full_name text, team public.team_type, color text, role public.app_role)
language sql
stable
security definer
set search_path = public
as $$
  select p.id, p.full_name, p.team, p.color, p.role
  from public.profiles p
  where public.is_active_user() and p.active = true and p.team is not null
  order by p.full_name;
$$;

grant execute on function public.list_advisors() to authenticated;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name)
  values (
    new.id,
    lower(new.email),
    coalesce(nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''), split_part(new.email, '@', 1))
  );
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists profiles_updated_at on public.profiles;
create trigger profiles_updated_at before update on public.profiles
for each row execute function public.set_updated_at();

create or replace function public.prepare_appointment()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  assigned public.profiles%rowtype;
begin
  select * into assigned
  from public.profiles
  where id = new.advisor_id and active = true and team is not null;

  if not found then
    raise exception 'El asesor seleccionado no está disponible.';
  end if;

  new.advisor_name = assigned.full_name;
  new.advisor_team = assigned.team;
  new.advisor_color = coalesce(assigned.color, 'blue');
  new.updated_at = now();
  new.updated_by = auth.uid();

  if tg_op = 'INSERT' then
    new.created_at = now();
    new.created_by = auth.uid();
  end if;

  return new;
end;
$$;

drop trigger if exists appointments_prepare on public.appointments;
create trigger appointments_prepare before insert or update on public.appointments
for each row execute function public.prepare_appointment();

alter table public.profiles enable row level security;
alter table public.appointments enable row level security;

drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles
for select to authenticated
using (id = auth.uid() or public.current_profile_role() = 'admin');

drop policy if exists profiles_admin_update on public.profiles;
create policy profiles_admin_update on public.profiles
for update to authenticated
using (public.current_profile_role() = 'admin')
with check (public.current_profile_role() = 'admin');

drop policy if exists appointments_read on public.appointments;
create policy appointments_read on public.appointments
for select to authenticated
using (public.is_active_user());

drop policy if exists appointments_create on public.appointments;
create policy appointments_create on public.appointments
for insert to authenticated
with check (
  public.is_active_user()
  and (
    public.current_profile_role() in ('admin', 'supervisor')
    or (public.current_profile_role() = 'advisor' and advisor_id = auth.uid())
  )
);

drop policy if exists appointments_supervise on public.appointments;
create policy appointments_supervise on public.appointments
for update to authenticated
using (public.current_profile_role() in ('admin', 'supervisor'))
with check (public.current_profile_role() in ('admin', 'supervisor'));

drop policy if exists appointments_admin_delete on public.appointments;
create policy appointments_admin_delete on public.appointments
for delete to authenticated
using (public.current_profile_role() = 'admin');

grant select on public.profiles to authenticated;
grant update (full_name, role, team, color, active) on public.profiles to authenticated;
grant select, insert, update, delete on public.appointments to authenticated;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'appointments'
  ) then
    alter publication supabase_realtime add table public.appointments;
  end if;
end $$;
