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

-- Catálogo de SIMI: búsquedas locales y sincronización de solo lectura.
alter table public.appointments add column if not exists simi_property_code text;
alter table public.appointments add column if not exists simi_property_url text;
alter table public.appointments drop constraint if exists appointments_simi_property_check;
alter table public.appointments add constraint appointments_simi_property_check check (
  (simi_property_code is null and simi_property_url is null)
  or (simi_property_code is not null and simi_property_code ~ '^[0-9]+-[0-9]+$'
    and simi_property_url is not null
    and simi_property_url ~ '^https://felixtrujillofalla[.]com/inmuebles/(arriendo|venta)/detalle/[0-9]+-[0-9]+/?$')
);

create table if not exists public.simi_property_catalog (
  code text primary key check (code ~ '^[0-9]+-[0-9]+$'),
  title text not null check (char_length(title) between 1 and 240),
  neighborhood text not null default '',
  city text not null default '',
  address text not null default '',
  rental boolean not null default false,
  sales boolean not null default false,
  url text not null check (url ~ '^https://felixtrujillofalla[.]com/inmuebles/(arriendo|venta)/detalle/[0-9]+-[0-9]+/?$'),
  active boolean not null default true,
  synced_at timestamptz not null default now(),
  check (rental or sales)
);

create table if not exists public.simi_catalog_sync_state (
  singleton boolean primary key default true check (singleton),
  lock_token uuid,
  locked_until timestamptz,
  last_attempt_at timestamptz,
  last_synced_at timestamptz
);
insert into public.simi_catalog_sync_state (singleton) values (true) on conflict do nothing;

alter table public.simi_property_catalog enable row level security;
alter table public.simi_catalog_sync_state enable row level security;
revoke all on public.simi_property_catalog, public.simi_catalog_sync_state from public, anon, authenticated;
grant all on public.simi_property_catalog, public.simi_catalog_sync_state to service_role;

create or replace function public.search_simi_properties(query_text text, target_team text, appointment_subject text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  search_text text;
  matches jsonb;
  synced timestamptz;
begin
  if not public.is_active_user() then
    raise exception 'Sesión no válida.' using errcode = '42501';
  end if;
  if appointment_subject is distinct from 'Visita comercial' then
    raise exception 'El catálogo solo se consulta para Visita comercial.' using errcode = '42501';
  end if;
  if target_team is null or target_team not in ('all', 'rental', 'sales') then
    raise exception 'Equipo no válido.' using errcode = '22023';
  end if;
  search_text := translate(lower(trim(coalesce(query_text, ''))), 'áéíóúüñ', 'aeiouun');
  if char_length(search_text) < 2 or char_length(search_text) > 120 then
    raise exception 'Escribe entre 2 y 120 caracteres para buscar.' using errcode = '22023';
  end if;

  select coalesce(jsonb_agg(to_jsonb(result) order by result.code), '[]'::jsonb)
  into matches
  from (
    select code, title, neighborhood, city, address, rental, sales, url
    from public.simi_property_catalog
    where active
      and (target_team = 'all' or (target_team = 'rental' and rental) or (target_team = 'sales' and sales))
      and strpos(translate(lower(concat_ws(' ', code, title, neighborhood, city, address)), 'áéíóúüñ', 'aeiouun'), search_text) > 0
    order by code
    limit 20
  ) result;
  select last_synced_at into synced from public.simi_catalog_sync_state where singleton;
  return jsonb_build_object('properties', matches, 'last_synced_at', synced);
end;
$$;
revoke all on function public.search_simi_properties(text, text, text) from public, anon;
grant execute on function public.search_simi_properties(text, text, text) to authenticated;

create or replace function public.begin_simi_catalog_sync()
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  token uuid := gen_random_uuid();
  acquired uuid;
begin
  update public.simi_catalog_sync_state
  set lock_token = token, locked_until = now() + interval '5 minutes', last_attempt_at = now()
  where singleton
    and (locked_until is null or locked_until < now())
    and (last_attempt_at is null or last_attempt_at < now() - interval '1 minute')
    and (last_synced_at is null or last_synced_at < now() - interval '15 minutes')
  returning lock_token into acquired;
  return acquired;
end;
$$;

create or replace function public.apply_simi_catalog(items jsonb, sync_token uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  item_count integer;
begin
  perform 1 from public.simi_catalog_sync_state
  where singleton and lock_token = sync_token and locked_until > now()
  for update;
  if not found then
    raise exception 'La sincronización expiró o fue reemplazada.' using errcode = '42501';
  end if;
  if jsonb_typeof(items) is distinct from 'array' then
    raise exception 'Catálogo no válido.' using errcode = '22023';
  end if;
  item_count := jsonb_array_length(items);
  if item_count < 1 or item_count > 10000 then
    raise exception 'El catálogo vacío o incompleto no reemplazará los datos anteriores.' using errcode = '22023';
  end if;
  if (select count(distinct item->>'code') from jsonb_array_elements(items) item) <> item_count then
    raise exception 'Hay códigos duplicados o ausentes en el catálogo.' using errcode = '22023';
  end if;

  insert into public.simi_property_catalog (code, title, neighborhood, city, address, rental, sales, url, active, synced_at)
  select code, title, coalesce(neighborhood, ''), coalesce(city, ''), coalesce(address, ''), rental, sales, url, true, now()
  from jsonb_to_recordset(items) as item(code text, title text, neighborhood text, city text, address text, rental boolean, sales boolean, url text)
  on conflict (code) do update set
    title = excluded.title, neighborhood = excluded.neighborhood, city = excluded.city,
    address = excluded.address, rental = excluded.rental, sales = excluded.sales,
    url = excluded.url, active = true, synced_at = excluded.synced_at;

  update public.simi_property_catalog set active = false
  where code not in (select item->>'code' from jsonb_array_elements(items) item);
  update public.simi_catalog_sync_state
  set last_synced_at = now(), lock_token = null, locked_until = null
  where singleton and lock_token = sync_token;
  return item_count;
end;
$$;

create or replace function public.cancel_simi_catalog_sync(sync_token uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.simi_catalog_sync_state set lock_token = null, locked_until = null
  where singleton and lock_token = sync_token;
$$;

revoke all on function public.begin_simi_catalog_sync() from public, anon, authenticated;
revoke all on function public.apply_simi_catalog(jsonb, uuid) from public, anon, authenticated;
revoke all on function public.cancel_simi_catalog_sync(uuid) from public, anon, authenticated;
grant execute on function public.begin_simi_catalog_sync() to service_role;
grant execute on function public.apply_simi_catalog(jsonb, uuid) to service_role;
grant execute on function public.cancel_simi_catalog_sync(uuid) to service_role;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'appointments'
  ) then
    alter publication supabase_realtime add table public.appointments;
  end if;
end $$;

-- Sincronización reanudable de SIMI; mismo contenido que add-simi-batch-sync.sql.
alter table public.simi_catalog_sync_state
  add column if not exists job_id uuid,
  add column if not exists job_status text not null default 'idle',
  add column if not exists job_started_at timestamptz,
  add column if not exists next_page integer not null default 1,
  add column if not exists staged_count integer not null default 0,
  add column if not exists expected_total integer,
  add column if not exists expected_pages integer,
  add column if not exists job_page_size integer,
  add column if not exists job_max_pages integer,
  add column if not exists job_agency text,
  add column if not exists job_error_code text,
  add column if not exists retry_after timestamptz;

create table if not exists public.simi_catalog_staging (
  job_id uuid not null,
  page_number integer not null check (page_number > 0),
  like public.simi_property_catalog including defaults including constraints,
  primary key (job_id, code)
);
alter table public.simi_catalog_staging enable row level security;
revoke all on public.simi_catalog_staging from public, anon, authenticated;
grant all on public.simi_catalog_staging to service_role;

create or replace function public.simi_batch_progress()
returns jsonb
language sql
volatile
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'status', job_status, 'job_id', job_id, 'next_page', next_page,
    'received', staged_count, 'total', expected_total, 'total_pages', expected_pages,
    'page_size', job_page_size, 'max_pages', job_max_pages, 'agency', job_agency,
    'error_code', job_error_code, 'restart_required', job_status = 'failed',
    'retry_after', retry_after, 'last_synced_at', last_synced_at
  )
  from public.simi_catalog_sync_state where singleton;
$$;

create or replace function public.acquire_simi_sync_batch(
  requested_page_size integer, requested_agency text, requested_max_pages integer,
  refresh_seconds integer default 900
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  state public.simi_catalog_sync_state%rowtype;
  token uuid := gen_random_uuid();
begin
  if requested_page_size is null or requested_page_size not between 1 and 100
    or requested_max_pages is null or requested_max_pages not between 1 and 200
    or requested_agency is null or requested_agency !~ '^[0-9]+$'
    or refresh_seconds is null or refresh_seconds not between 900 and 86400 then
    raise exception 'SIMI_CONFIG' using errcode = '22023';
  end if;
  select * into state from public.simi_catalog_sync_state where singleton for update;
  if state.locked_until > now() then
    return public.simi_batch_progress() || '{"status":"busy"}'::jsonb;
  end if;
  if state.retry_after > now() then
    return public.simi_batch_progress() || '{"status":"waiting"}'::jsonb;
  end if;
  if state.job_status = 'pending'
    and (state.job_started_at < now() - interval '24 hours' or state.job_agency <> requested_agency) then
    update public.simi_catalog_sync_state set job_status = 'failed', job_error_code = 'SIMI_JOB_EXPIRED'
    where singleton;
    return public.simi_batch_progress();
  end if;
  if state.job_status = 'failed' then return public.simi_batch_progress(); end if;
  if state.job_status in ('idle', 'complete') then
    if state.last_synced_at > now() - make_interval(secs => refresh_seconds) then
      return public.simi_batch_progress() || jsonb_build_object(
        'status', 'complete', 'received', (select count(*) from public.simi_property_catalog where active)
      );
    end if;
    -- Solo se limpian restos privados del trabajo anterior, ya finalizado.
    -- El filtro explícito mantiene la protección de Supabase contra DELETE sin WHERE.
    delete from public.simi_catalog_staging where job_id = state.job_id;
    update public.simi_catalog_sync_state
    set job_id = gen_random_uuid(), job_status = 'pending', job_started_at = now(),
      next_page = 1, staged_count = 0, expected_total = null, expected_pages = null,
      job_page_size = requested_page_size, job_max_pages = requested_max_pages,
      job_agency = requested_agency, job_error_code = null, retry_after = null
    where singleton;
  end if;
  update public.simi_catalog_sync_state
  set lock_token = token, locked_until = now() + interval '3 minutes', last_attempt_at = now()
  where singleton;
  return public.simi_batch_progress() || jsonb_build_object('batch_token', token);
end;
$$;

create or replace function public.save_simi_sync_page(
  batch_token uuid, sync_job uuid, requested_page integer, items jsonb,
  page_total integer default null, page_count integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  state public.simi_catalog_sync_state%rowtype;
  amount integer;
  received integer;
  total integer;
  pages integer;
  finished boolean;
begin
  select * into state from public.simi_catalog_sync_state where singleton for update;
  if state.job_id = sync_job and state.job_status = 'complete' then return public.simi_batch_progress(); end if;
  if state.job_status <> 'pending' or state.job_id is distinct from sync_job
    or state.lock_token is distinct from batch_token or batch_token is null
    or state.locked_until is null or state.locked_until <= now() then
    raise exception 'SIMI_BATCH_EXPIRED' using errcode = '42501';
  end if;
  if requested_page is null or requested_page < 1 or requested_page > state.job_max_pages then
    raise exception 'SIMI_PAGE_LIMIT' using errcode = '22023';
  end if;
  -- Repetir la confirmación de una página ya guardada es seguro e idempotente.
  if requested_page < state.next_page then return public.simi_batch_progress(); end if;
  if requested_page <> state.next_page then raise exception 'SIMI_PAGE_ORDER' using errcode = '22023'; end if;
  if jsonb_typeof(items) is distinct from 'array' then raise exception 'SIMI_FORMAT' using errcode = '22023'; end if;
  amount := jsonb_array_length(items);
  if amount > 1000 then raise exception 'SIMI_RESPONSE_SIZE' using errcode = '22023'; end if;
  if page_count = 0 and amount > 0 then raise exception 'SIMI_FORMAT' using errcode = '22023'; end if;
  if page_total < 0 or page_total > 10000 or page_count < 0 or page_count > state.job_max_pages then
    raise exception 'SIMI_PAGE_LIMIT' using errcode = '22023';
  end if;
  if (state.expected_total is not null and page_total is not null and state.expected_total <> page_total)
    or (state.expected_pages is not null and page_count is not null and state.expected_pages <> page_count) then
    raise exception 'SIMI_CHANGED' using errcode = '22023';
  end if;
  total := coalesce(state.expected_total, page_total);
  pages := coalesce(state.expected_pages, nullif(page_count, 0));
  received := state.staged_count + amount;
  if received > 10000 or (total is not null and received > total) then
    raise exception 'SIMI_INCOMPLETE' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_to_recordset(items) as item(code text)
    where code is null or split_part(code, '-', 1) <> state.job_agency
  ) then raise exception 'SIMI_PROPERTY_CODE' using errcode = '22023'; end if;
  if (select count(distinct item->>'code') from jsonb_array_elements(items) item) <> amount
    or exists (
      select 1 from jsonb_array_elements(items) item
      join public.simi_catalog_staging staged on staged.job_id = sync_job and staged.code = item->>'code'
    ) then raise exception 'SIMI_DUPLICATE' using errcode = '22023'; end if;

  finished := case when pages is not null then requested_page = pages
    when total is not null then received = total else amount = 0 end;
  if (amount = 0 and not finished) or (finished and (received = 0 or (total is not null and received <> total))) then
    raise exception 'SIMI_INCOMPLETE' using errcode = '22023';
  end if;
  if not finished and requested_page >= state.job_max_pages then
    raise exception 'SIMI_PAGE_LIMIT' using errcode = '22023';
  end if;

  insert into public.simi_catalog_staging (job_id, page_number, code, title, neighborhood, city, address, rental, sales, url)
  select sync_job, requested_page, code, title, coalesce(neighborhood, ''), coalesce(city, ''),
    coalesce(address, ''), rental, sales, url
  from jsonb_to_recordset(items) as item(code text, title text, neighborhood text, city text, address text, rental boolean, sales boolean, url text);
  update public.simi_catalog_sync_state
  set next_page = requested_page + 1, staged_count = received, expected_total = total,
    expected_pages = pages, job_error_code = null
  where singleton;

  if finished then
    -- Publicación atómica: hasta este punto las búsquedas siguen usando el catálogo anterior.
    insert into public.simi_property_catalog (code, title, neighborhood, city, address, rental, sales, url, active, synced_at)
    select code, title, neighborhood, city, address, rental, sales, url, true, now()
    from public.simi_catalog_staging where job_id = sync_job
    on conflict (code) do update set
      title = excluded.title, neighborhood = excluded.neighborhood, city = excluded.city,
      address = excluded.address, rental = excluded.rental, sales = excluded.sales,
      url = excluded.url, active = true, synced_at = excluded.synced_at;
    update public.simi_property_catalog set active = false
    where code not in (select code from public.simi_catalog_staging where job_id = sync_job);
    update public.simi_catalog_sync_state set job_status = 'complete', last_synced_at = now(),
      lock_token = null, locked_until = null, retry_after = null where singleton;
    delete from public.simi_catalog_staging where job_id = sync_job;
  end if;
  return public.simi_batch_progress();
end;
$$;

create or replace function public.release_simi_sync_batch(batch_token uuid, failure_code text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if failure_code is not null and failure_code !~ '^SIMI_[A-Z_]+$' then
    raise exception 'SIMI_CONFIG' using errcode = '22023';
  end if;
  update public.simi_catalog_sync_state
  set lock_token = null, locked_until = null, job_error_code = failure_code,
    retry_after = case when failure_code is null then null else now() + interval '1 minute' end,
    job_status = case when failure_code in (
      'SIMI_CHANGED', 'SIMI_DUPLICATE', 'SIMI_INCOMPLETE', 'SIMI_PAGE_LIMIT',
      'SIMI_PROPERTY_CODE', 'SIMI_PROPERTY_OPERATION', 'SIMI_FORMAT', 'SIMI_REJECTED', 'SIMI_PAGE_ORDER'
    ) then 'failed' else job_status end
  where singleton and lock_token = batch_token;
  return public.simi_batch_progress();
end;
$$;

create or replace function public.reset_simi_sync_job()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  state public.simi_catalog_sync_state%rowtype;
begin
  select * into state from public.simi_catalog_sync_state where singleton for update;
  if state.locked_until > now() then return public.simi_batch_progress() || '{"status":"busy"}'::jsonb; end if;
  if state.retry_after > now() then return public.simi_batch_progress() || '{"status":"waiting"}'::jsonb; end if;
  delete from public.simi_catalog_staging where job_id = state.job_id;
  update public.simi_catalog_sync_state set job_id = null, job_status = 'idle',
    job_started_at = null, next_page = 1, staged_count = 0, expected_total = null, expected_pages = null,
    job_page_size = null, job_max_pages = null, job_agency = null, job_error_code = null,
    lock_token = null, locked_until = null, retry_after = null where singleton;
  return public.simi_batch_progress();
end;
$$;

revoke all on function public.simi_batch_progress() from public, anon, authenticated;
revoke all on function public.acquire_simi_sync_batch(integer, text, integer, integer) from public, anon, authenticated;
revoke all on function public.save_simi_sync_page(uuid, uuid, integer, jsonb, integer, integer) from public, anon, authenticated;
revoke all on function public.release_simi_sync_batch(uuid, text) from public, anon, authenticated;
revoke all on function public.reset_simi_sync_job() from public, anon, authenticated;
grant execute on function public.simi_batch_progress() to service_role;
grant execute on function public.acquire_simi_sync_batch(integer, text, integer, integer) to service_role;
grant execute on function public.save_simi_sync_page(uuid, uuid, integer, jsonb, integer, integer) to service_role;
grant execute on function public.release_simi_sync_batch(uuid, text) to service_role;
grant execute on function public.reset_simi_sync_job() to service_role;

-- Evita que una función antigua publique una descarga completa mientras existe un trabajo por lotes.
revoke execute on function public.begin_simi_catalog_sync() from service_role;
revoke execute on function public.apply_simi_catalog(jsonb, uuid) from service_role;
revoke execute on function public.cancel_simi_catalog_sync(uuid) from service_role;
