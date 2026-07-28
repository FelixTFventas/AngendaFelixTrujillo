begin;

alter table public.profiles
  add column if not exists can_manage_team_appointments boolean;

update public.profiles
set can_manage_team_appointments = false
where can_manage_team_appointments is null;

alter table public.profiles
  alter column can_manage_team_appointments set default false,
  alter column can_manage_team_appointments set not null;

do $$
declare
  target_count integer;
  distinct_target_count integer;
  invalid_count integer;
begin
  select count(*), count(distinct lower(email))
  into target_count, distinct_target_count
  from public.profiles
  where lower(email) in (
    'atencionalcliente@felixtrujillofalla.com',
    'comercial@felixtrujillofalla.com'
  );

  if target_count <> 2 or distinct_target_count <> 2 then
    raise exception 'Se esperaban exactamente 2 perfiles objetivo; se encontraron %.', target_count;
  end if;

  select count(*)
  into invalid_count
  from public.profiles
  where lower(email) in (
    'atencionalcliente@felixtrujillofalla.com',
    'comercial@felixtrujillofalla.com'
  )
    and (role <> 'advisor' or team <> 'sales' or team is null);

  if invalid_count <> 0 then
    raise exception 'Paola y Patricia deben conservar el rol advisor y el equipo sales.';
  end if;
end
$$;

update public.profiles
set can_manage_team_appointments = lower(email) in (
  'atencionalcliente@felixtrujillofalla.com',
  'comercial@felixtrujillofalla.com'
);

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

commit;

select email, role, team, can_manage_team_appointments
from public.profiles
where lower(email) in (
  'atencionalcliente@felixtrujillofalla.com',
  'comercial@felixtrujillofalla.com'
)
order by email;
