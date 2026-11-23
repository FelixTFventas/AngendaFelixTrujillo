-- Ejecutar en SQL Editor antes de publicar el formulario y el dashboard actualizados.
-- No reclasifica citas antiguas ni modifica permisos de la agenda o datos de SIMI.
alter type public.appointment_status add value if not exists 'rented';

begin;

create or replace function public.validate_appointment_outcome()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  -- Permite editar otros datos sin perder el estado histórico.
  if tg_op = 'UPDATE' and new.status is not distinct from old.status then return new; end if;
  if new.status::text in ('completed', 'rented', 'cancelled') then return new; end if;
  -- Una cita nueva puede no tener resultado todavía. No se convierte en realizada.
  if tg_op = 'INSERT' and new.status::text = 'pending' then return new; end if;
  raise exception 'Selecciona Realizada, Arrendado o Cancelado. Los resultados existentes no se borran.'
    using errcode = '23514';
end;
$$;

drop trigger if exists appointments_validate_outcome on public.appointments;
create trigger appointments_validate_outcome
  before insert or update of status on public.appointments
  for each row execute function public.validate_appointment_outcome();
revoke all on function public.validate_appointment_outcome() from public, anon, authenticated;

create or replace function public.appointment_outcome_dashboard(period_start date, period_end date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  result jsonb;
begin
  if not coalesce(public.current_profile_role() in ('admin', 'supervisor'), false) then
    raise exception 'Solo el administrador y la supervisora pueden consultar los indicadores.'
      using errcode = '42501';
  end if;
  if period_start is null or period_end is null
    or period_end <= period_start or period_end > period_start + 31 then
    raise exception 'Selecciona un periodo válido de hasta 31 días.' using errcode = '22023';
  end if;

  -- Solo agregados: no devuelve clientes, teléfonos, direcciones, notas ni inmuebles.
  with scoped as (
    select advisor_id, advisor_team as team, status::text as outcome,
      subject, capture_source
    from public.appointments
    where appointment_date >= period_start and appointment_date < period_end
  ), counts as (
    select advisor_id, team, count(*) as total,
      count(*) filter (where outcome = 'completed') as completed,
      count(*) filter (where outcome = 'rented') as rented,
      count(*) filter (where outcome = 'cancelled') as cancelled,
      count(*) filter (where outcome not in ('completed', 'rented', 'cancelled')) as unresolved
    from scoped group by advisor_id, team
  ), members as (
    select id, team from public.advisors where active
    union select advisor_id, team from counts
  ), advisor_metrics as (
    select advisor.id as advisor_id, advisor.full_name as advisor_name, member.team, advisor.active,
      coalesce(counts.total, 0) as total, coalesce(counts.completed, 0) as completed,
      coalesce(counts.rented, 0) as rented, coalesce(counts.cancelled, 0) as cancelled,
      coalesce(counts.unresolved, 0) as unresolved
    from members member
    join public.advisors advisor on advisor.id = member.id
    left join counts on counts.advisor_id = member.id and counts.team = member.team
  ), subject_metrics as (
    select advisor_id, team, subject as label, count(*) as total,
      count(*) filter (where outcome = 'completed') as completed,
      count(*) filter (where outcome = 'rented') as rented,
      count(*) filter (where outcome = 'cancelled') as cancelled,
      count(*) filter (where outcome not in ('completed', 'rented', 'cancelled')) as unresolved
    from scoped group by advisor_id, team, subject
  ), source_metrics as (
    select advisor_id, team, coalesce(capture_source, 'Sin registrar') as label, count(*) as total,
      count(*) filter (where outcome = 'completed') as completed,
      count(*) filter (where outcome = 'rented') as rented,
      count(*) filter (where outcome = 'cancelled') as cancelled,
      count(*) filter (where outcome not in ('completed', 'rented', 'cancelled')) as unresolved
    from scoped group by advisor_id, team, capture_source
  )
  select jsonb_build_object(
    'protocol', 'outcomes-v1',
    'advisors', coalesce((select jsonb_agg(to_jsonb(metric) order by team, advisor_name, advisor_id) from advisor_metrics metric), '[]'::jsonb),
    'subjects', coalesce((select jsonb_agg(to_jsonb(metric) order by team, advisor_id, label) from subject_metrics metric), '[]'::jsonb),
    'sources', coalesce((select jsonb_agg(to_jsonb(metric) order by team, advisor_id, label) from source_metrics metric), '[]'::jsonb)
  ) into result;
  -- Un solo objeto evita truncar las agrupaciones con el límite REST de 1.000 filas.
  return result;
end;
$$;

revoke all on function public.appointment_outcome_dashboard(date, date) from public, anon;
grant execute on function public.appointment_outcome_dashboard(date, date) to authenticated;

commit;
