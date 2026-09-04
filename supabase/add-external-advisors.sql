-- Ejecuta este archivo una sola vez en un proyecto que ya use supabase/schema.sql.
begin;

create table if not exists public.advisors (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid unique references public.profiles(id) on delete cascade,
  full_name text not null check (char_length(trim(full_name)) >= 1),
  team public.team_type not null,
  color text not null check (color in ('amber', 'teal', 'blue', 'violet', 'coral')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint linked_advisor_id check (profile_id is null or id = profile_id)
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

insert into public.advisors (id, profile_id, full_name, team, color, active)
select distinct on (appointment.advisor_id)
  appointment.advisor_id,
  profile.id,
  coalesce(nullif(trim(appointment.advisor_name), ''), 'Asesor sin nombre'),
  appointment.advisor_team,
  case when appointment.advisor_color in ('amber', 'teal', 'blue', 'violet', 'coral') then appointment.advisor_color else 'blue' end,
  false
from public.appointments appointment
left join public.profiles profile on profile.id = appointment.advisor_id
where not exists (
  select 1 from public.advisors advisor where advisor.id = appointment.advisor_id
)
order by appointment.advisor_id, appointment.updated_at desc;

alter table public.appointments drop constraint if exists appointments_advisor_id_fkey;
alter table public.appointments
  add constraint appointments_advisor_id_fkey foreign key (advisor_id) references public.advisors(id);

create or replace function public.list_advisors()
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
begin
  select * into assigned
  from public.advisors
  where id = new.advisor_id and active = true;

  if not found then
    raise exception 'El asesor seleccionado no está disponible.';
  end if;

  new.advisor_name = assigned.full_name;
  new.advisor_team = assigned.team;
  new.advisor_color = assigned.color;
  new.updated_at = now();
  new.updated_by = auth.uid();

  if tg_op = 'INSERT' then
    new.created_at = now();
    new.created_by = auth.uid();
  end if;

  return new;
end;
$$;

alter table public.advisors enable row level security;

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

grant select on public.advisors to authenticated;
grant insert (full_name, team, color) on public.advisors to authenticated;
grant update (active) on public.advisors to authenticated;

commit;
