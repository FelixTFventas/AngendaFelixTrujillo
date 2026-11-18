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
  color text check (color is null or color in ('amber', 'teal', 'blue', 'violet', 'coral', 'emerald', 'indigo', 'rose', 'orange', 'cyan', 'lime', 'slate')),
  active boolean not null default true,
  must_change_password boolean not null default true,
  can_manage_team_appointments boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint advisor_fields check (
    (role = 'supervisor' and team is null and color is null)
    or role <> 'supervisor'
  )
);

alter table public.profiles
  add column if not exists can_manage_team_appointments boolean not null default false;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'team_appointment_manager_fields'
      and conrelid = 'public.profiles'::regclass
  ) then
    alter table public.profiles
      add constraint team_appointment_manager_fields check (
        not can_manage_team_appointments
        or (role = 'advisor' and team is not null)
      );
  end if;
end
$$;

create table if not exists public.advisors (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid unique references public.profiles(id) on delete cascade,
  full_name text not null check (char_length(trim(full_name)) >= 1),
  team public.team_type not null,
  color text not null check (color in ('amber', 'teal', 'blue', 'violet', 'coral', 'emerald', 'indigo', 'rose', 'orange', 'cyan', 'lime', 'slate')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint linked_advisor_id check (profile_id is null or id = profile_id)
);

alter table public.profiles drop constraint if exists profiles_color_check;
alter table public.profiles add constraint profiles_color_check check (
  color is null or color in ('amber', 'teal', 'blue', 'violet', 'coral', 'emerald', 'indigo', 'rose', 'orange', 'cyan', 'lime', 'slate')
);

alter table public.advisors drop constraint if exists advisors_color_check;
alter table public.advisors add constraint advisors_color_check check (
  color in ('amber', 'teal', 'blue', 'violet', 'coral', 'emerald', 'indigo', 'rose', 'orange', 'cyan', 'lime', 'slate')
);

insert into public.advisors (id, profile_id, full_name, team, color, active)
select id, id, coalesce(nullif(trim(full_name), ''), 'Asesor sin nombre'), team, coalesce(color, 'blue'), active
from public.profiles
where team is not null
on conflict (id) do update set
  profile_id = excluded.profile_id,
  full_name = excluded.full_name,
  team = excluded.team,
  color = excluded.color,
  active = excluded.active,
  updated_at = now();

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
  advisor_id uuid not null references public.advisors(id),
  advisor_name text not null,
  advisor_team public.team_type not null,
  advisor_color text not null,
  created_by uuid not null references public.profiles(id),
  updated_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.appointments add column if not exists capture_source text;

alter table public.appointments drop constraint if exists appointments_capture_source_check;
alter table public.appointments add constraint appointments_capture_source_check check (
  capture_source is null or capture_source in (
    'WhatsApp', 'Fijo', 'Finca Raíz', 'Proppit', 'Ciencuadras', 'Facebook', 'Instagram'
  )
);

create or replace function public.validate_appointment_capture_source()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.subject = 'Visita comercial' and new.capture_source is null then
    if tg_op = 'INSERT' then
      raise exception 'Selecciona por dónde fue captada la cita.'
        using errcode = '23514';
    elsif old.subject is distinct from 'Visita comercial' or old.capture_source is not null then
      raise exception 'Selecciona por dónde fue captada la cita.'
        using errcode = '23514';
    end if;
    -- Las visitas comerciales antiguas sin medio registrado pueden conservarlo vacío.
  end if;
  return new;
end;
$$;

drop trigger if exists appointments_validate_capture_source on public.appointments;
create trigger appointments_validate_capture_source
  before insert or update of subject, capture_source on public.appointments
  for each row execute function public.validate_appointment_capture_source();

insert into public.advisors (id, profile_id, full_name, team, color, active)
select distinct on (appointment.advisor_id)
  appointment.advisor_id,
  profile.id,
  coalesce(nullif(trim(appointment.advisor_name), ''), 'Asesor sin nombre'),
  appointment.advisor_team,
  case when appointment.advisor_color in ('amber', 'teal', 'blue', 'violet', 'coral', 'emerald', 'indigo', 'rose', 'orange', 'cyan', 'lime', 'slate') then appointment.advisor_color else 'blue' end,
  false
from public.appointments appointment
left join public.profiles profile on profile.id = appointment.advisor_id
where not exists (
  select 1 from public.advisors advisor where advisor.id = appointment.advisor_id
)
order by appointment.advisor_id, appointment.updated_at desc;

do $$
begin
  if (select count(*) from public.advisors) > 12 then
    raise exception 'Hay más de 12 asesores. Amplía la paleta antes de continuar.';
  end if;
end
$$;

with palette(color, position) as (
  values
    ('amber', 1), ('teal', 2), ('blue', 3), ('violet', 4), ('coral', 5), ('emerald', 6),
    ('indigo', 7), ('rose', 8), ('orange', 9), ('cyan', 10), ('lime', 11), ('slate', 12)
), ranked_advisors as (
  select id, row_number() over (partition by color order by created_at, id) as color_rank
  from public.advisors
), advisors_to_recolor as (
  select id, row_number() over (order by id) as position
  from ranked_advisors
  where color_rank > 1
), available_colors as (
  select palette.color, row_number() over (order by palette.position) as position
  from palette
  where not exists (
    select 1 from public.advisors advisor where advisor.color = palette.color
  )
), assignments as (
  select advisor.id, available.color
  from advisors_to_recolor advisor
  join available_colors available using (position)
)
update public.advisors advisor
set color = assignment.color
from assignments assignment
where advisor.id = assignment.id;

update public.profiles profile
set color = advisor.color
from public.advisors advisor
where advisor.profile_id = profile.id
  and profile.team is not null
  and profile.color is distinct from advisor.color;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'advisors_color_unique'
      and conrelid = 'public.advisors'::regclass
  ) then
    alter table public.advisors add constraint advisors_color_unique unique (color);
  end if;
end
$$;

alter table public.appointments drop constraint if exists appointments_advisor_id_fkey;
alter table public.appointments
  add constraint appointments_advisor_id_fkey foreign key (advisor_id) references public.advisors(id);

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

create or replace function public.can_manage_appointment_team(target_team public.team_type)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists(
    select 1 from public.profiles
    where id = auth.uid()
      and active = true
      and must_change_password = false
      and role = 'advisor'
      and can_manage_team_appointments = true
      and team = target_team
  );
$$;

revoke all on function public.can_manage_appointment_team(public.team_type) from public;
grant execute on function public.can_manage_appointment_team(public.team_type) to authenticated;

drop function if exists public.list_advisors();
create function public.list_advisors()
returns table (id uuid, full_name text, team public.team_type, color text, role public.app_role)
language sql
stable
security definer
set search_path = public
as $$
  select a.id, a.full_name, a.team, a.color, coalesce(p.role, 'advisor'::public.app_role)
  from public.advisors a
  left join public.profiles p on p.id = a.profile_id
  where public.is_active_user() and a.active = true
  order by a.full_name;
$$;

grant execute on function public.list_advisors() to authenticated;

create or replace function public.appointment_dashboard(period_start date, period_end date)
returns table (
  advisor_id uuid,
  advisor_name text,
  team public.team_type,
  active boolean,
  total bigint,
  completed bigint
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not coalesce(public.current_profile_role() in ('admin', 'supervisor'), false) then
    raise exception 'Solo el administrador y la supervisora pueden consultar los indicadores.'
      using errcode = '42501';
  end if;

  -- El fin es exclusivo. Solo se permiten periodos de hasta un mes.
  if period_start is null or period_end is null
    or period_end <= period_start or period_end > period_start + 31 then
    raise exception 'Selecciona un periodo válido de hasta 31 días.'
      using errcode = '22023';
  end if;

  return query
  with counts as (
    select appointment.advisor_id, appointment.advisor_team,
      count(*) as total,
      count(*) filter (where appointment.status = 'completed') as completed
    from public.appointments appointment
    where appointment.appointment_date >= period_start
      and appointment.appointment_date < period_end
    group by appointment.advisor_id, appointment.advisor_team
  ), members as (
    -- Los activos figuran incluso con cero citas; los inactivos, si tienen historial en el periodo.
    select advisor.id, advisor.team
    from public.advisors advisor
    where advisor.active = true
    union
    select counts.advisor_id, counts.advisor_team from counts
  )
  select advisor.id, advisor.full_name, member.team, advisor.active,
    coalesce(counts.total, 0::bigint), coalesce(counts.completed, 0::bigint)
  from members member
  join public.advisors advisor on advisor.id = member.id
  left join counts on counts.advisor_id = member.id and counts.advisor_team = member.team
  order by member.team, advisor.full_name, advisor.id;
end;
$$;

revoke all on function public.appointment_dashboard(date, date) from public, anon;
grant execute on function public.appointment_dashboard(date, date) to authenticated;

drop function if exists public.list_appointment_creators();
create function public.list_appointment_creators()
returns table (id uuid, full_name text)
language sql
stable
security definer
set search_path = public
as $$
  select distinct profile.id, profile.full_name
  from public.profiles profile
  join public.appointments appointment on appointment.created_by = profile.id
  where public.is_active_user()
  order by profile.full_name;
$$;

revoke all on function public.list_appointment_creators() from public;
grant execute on function public.list_appointment_creators() to authenticated;

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

create or replace function public.sync_profile_advisor()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.team is null then
    update public.advisors set active = false
    where profile_id = new.id;
  else
    insert into public.advisors (id, profile_id, full_name, team, color, active)
    values (new.id, new.id, coalesce(nullif(trim(new.full_name), ''), 'Asesor sin nombre'), new.team, coalesce(new.color, 'blue'), new.active)
    on conflict (id) do update set
      profile_id = excluded.profile_id,
      full_name = excluded.full_name,
      team = excluded.team,
      color = excluded.color,
      active = excluded.active,
      updated_at = now();
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_updated_at on public.profiles;
create trigger profiles_updated_at before update on public.profiles
for each row execute function public.set_updated_at();

drop trigger if exists profiles_sync_advisor on public.profiles;
create trigger profiles_sync_advisor after insert or update of full_name, team, color, active on public.profiles
for each row execute function public.sync_profile_advisor();

drop trigger if exists advisors_updated_at on public.advisors;
create trigger advisors_updated_at before update on public.advisors
for each row execute function public.set_updated_at();

create or replace function public.prepare_appointment()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  assigned public.advisors%rowtype;
  allow_inactive boolean := false;
begin
  if tg_op = 'UPDATE' then
    allow_inactive := new.advisor_id = old.advisor_id;
  end if;

  select * into assigned
  from public.advisors
  where id = new.advisor_id
    and (active = true or allow_inactive);

  if not found then
    raise exception 'El asesor seleccionado no está disponible.';
  end if;

  new.advisor_name = assigned.full_name;
  new.advisor_team = assigned.team;
  new.advisor_color = coalesce(assigned.color, 'blue');
  new.updated_at = now();

  if tg_op = 'INSERT' then
    new.updated_by = auth.uid();
    new.created_at = now();
    new.created_by = auth.uid();
  else
    new.updated_by = coalesce(auth.uid(), old.updated_by);
  end if;

  return new;
end;
$$;

drop trigger if exists appointments_prepare on public.appointments;
create trigger appointments_prepare before insert or update on public.appointments
for each row execute function public.prepare_appointment();

update public.appointments appointment
set advisor_color = advisor.color
from public.advisors advisor
where advisor.id = appointment.advisor_id
  and appointment.advisor_color is distinct from advisor.color;

alter table public.profiles enable row level security;
alter table public.advisors enable row level security;
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

drop policy if exists advisors_admin_read on public.advisors;
create policy advisors_admin_read on public.advisors
for select to authenticated
using (public.current_profile_role() = 'admin');

drop policy if exists advisors_admin_create on public.advisors;
create policy advisors_admin_create on public.advisors
for insert to authenticated
with check (public.current_profile_role() = 'admin' and profile_id is null);

drop policy if exists advisors_admin_update_external on public.advisors;
create policy advisors_admin_update_external on public.advisors
for update to authenticated
using (public.current_profile_role() = 'admin' and profile_id is null)
with check (public.current_profile_role() = 'admin' and profile_id is null);

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
    or public.can_manage_appointment_team(advisor_team)
  )
);

drop policy if exists appointments_supervise on public.appointments;
create policy appointments_supervise on public.appointments
for update to authenticated
using (
  public.current_profile_role() in ('admin', 'supervisor')
  or public.can_manage_appointment_team(advisor_team)
)
with check (
  public.current_profile_role() in ('admin', 'supervisor')
  or public.can_manage_appointment_team(advisor_team)
);

drop policy if exists appointments_admin_delete on public.appointments;
create policy appointments_admin_delete on public.appointments
for delete to authenticated
using (
  public.current_profile_role() in ('admin', 'supervisor')
  or public.can_manage_appointment_team(advisor_team)
);

grant select on public.profiles to authenticated;
grant update (full_name, role, team, color, active) on public.profiles to authenticated;
grant select on public.advisors to authenticated;
grant insert (full_name, team, color) on public.advisors to authenticated;
grant update (active) on public.advisors to authenticated;
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
