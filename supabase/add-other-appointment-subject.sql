-- Ejecutar en SQL Editor antes de publicar el formulario con el asunto Otros.
-- No modifica citas, resultados, permisos ni el catálogo SIMI.
begin;

alter table public.appointments drop constraint if exists appointments_client_check;
alter table public.appointments add constraint appointments_client_check check (
  char_length(trim(client)) <= 160
  and (subject = 'Otros' or char_length(trim(client)) >= 1)
);

alter table public.appointments drop constraint if exists appointments_other_notes_check;
-- NOT VALID conserva posibles registros históricos Otros sin notas.
-- La regla se exige en las nuevas citas y al guardar cambios en cualquier cita.
alter table public.appointments add constraint appointments_other_notes_check check (
  subject <> 'Otros' or char_length(btrim(notes, E' \t\n\r')) > 0
) not valid;

commit;
