-- Ejecuta este archivo después de supabase/add-external-advisors.sql.
begin;

alter table public.profiles drop constraint if exists profiles_color_check;
alter table public.profiles add constraint profiles_color_check check (
  color is null or color in ('amber', 'teal', 'blue', 'violet', 'coral', 'emerald', 'indigo', 'rose', 'orange', 'cyan', 'lime', 'slate')
);

alter table public.advisors drop constraint if exists advisors_color_check;
alter table public.advisors add constraint advisors_color_check check (
  color in ('amber', 'teal', 'blue', 'violet', 'coral', 'emerald', 'indigo', 'rose', 'orange', 'cyan', 'lime', 'slate')
);

do $$
begin
  if (select count(*) from public.advisors) > 12 then
    raise exception 'Hay más de 12 asesores. Amplía la paleta antes de ejecutar esta migración.';
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

alter table public.advisors drop constraint if exists advisors_color_unique;
alter table public.advisors add constraint advisors_color_unique unique (color);

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
  new.advisor_color = assigned.color;
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

update public.appointments appointment
set advisor_color = advisor.color
from public.advisors advisor
where advisor.id = appointment.advisor_id
  and appointment.advisor_color is distinct from advisor.color;

commit;
