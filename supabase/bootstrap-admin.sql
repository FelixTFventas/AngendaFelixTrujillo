-- Ejecuta este archivo después de crear a Yunior Lara en Authentication > Users.
insert into public.profiles (id, email, full_name, role, team, color, active, must_change_password)
select
  id,
  lower(email),
  'Yunior Lara',
  'admin',
  'sales',
  'coral',
  true,
  true
from auth.users
where lower(email) = 'asesorventasfelixtrujillo@gmail.com'
on conflict (id) do update set
  full_name = excluded.full_name,
  role = excluded.role,
  team = excluded.team,
  color = excluded.color,
  active = excluded.active,
  must_change_password = excluded.must_change_password;

do $$
begin
  if not exists (
    select 1 from public.profiles
    where email = 'asesorventasfelixtrujillo@gmail.com' and role = 'admin'
  ) then
    raise exception 'No se encontró el usuario de Yunior Lara. Créalo primero en Authentication > Users.';
  end if;
end $$;
