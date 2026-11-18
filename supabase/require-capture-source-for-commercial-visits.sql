-- Ejecutar después de add-appointment-capture-source.sql.
-- Ajusta la regla anterior sin modificar las citas existentes.
begin;

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

commit;
