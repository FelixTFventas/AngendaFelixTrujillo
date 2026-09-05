-- Ejecuta este archivo una sola vez en un proyecto que ya use supabase/schema.sql.
begin;

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

commit;
