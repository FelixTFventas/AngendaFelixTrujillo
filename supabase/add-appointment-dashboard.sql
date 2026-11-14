-- Ejecutar una sola vez en SQL Editor para activar el dashboard.
begin;

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

commit;
