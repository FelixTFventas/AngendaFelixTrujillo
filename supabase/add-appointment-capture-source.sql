-- Ejecutar en SQL Editor ANTES de publicar el formulario con el campo Captado.
-- Las citas existentes conservan sus datos y quedan con capture_source = null.
-- Después ejecutar require-capture-source-for-commercial-visits.sql para aplicar la regla final.
begin;

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
  if tg_op = 'INSERT' then
    if new.capture_source is null then
      raise exception 'Selecciona por dónde fue captada la cita.'
        using errcode = '23514';
    end if;
  elsif old.capture_source is not null and new.capture_source is null then
    raise exception 'El medio de captación registrado no puede quedar vacío.'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists appointments_validate_capture_source on public.appointments;
create trigger appointments_validate_capture_source
  before insert or update of capture_source on public.appointments
  for each row execute function public.validate_appointment_capture_source();

commit;
