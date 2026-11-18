-- Ejecutar antes de publicar el buscador de inmuebles. No modifica SIMI ni las citas existentes.
begin;

alter table public.appointments add column if not exists simi_property_code text;
alter table public.appointments add column if not exists simi_property_url text;
alter table public.appointments drop constraint if exists appointments_simi_property_check;
alter table public.appointments add constraint appointments_simi_property_check check (
  (simi_property_code is null and simi_property_url is null)
  or (simi_property_code is not null and simi_property_code ~ '^[0-9]+-[0-9]+$'
    and simi_property_url is not null
    and simi_property_url ~ '^https://felixtrujillofalla[.]com/inmuebles/(arriendo|venta)/detalle/[0-9]+-[0-9]+/?$')
);

create table if not exists public.simi_property_catalog (
  code text primary key check (code ~ '^[0-9]+-[0-9]+$'),
  title text not null check (char_length(title) between 1 and 240),
  neighborhood text not null default '',
  city text not null default '',
  address text not null default '',
  rental boolean not null default false,
  sales boolean not null default false,
  url text not null check (url ~ '^https://felixtrujillofalla[.]com/inmuebles/(arriendo|venta)/detalle/[0-9]+-[0-9]+/?$'),
  active boolean not null default true,
  synced_at timestamptz not null default now(),
  check (rental or sales)
);

create table if not exists public.simi_catalog_sync_state (
  singleton boolean primary key default true check (singleton),
  lock_token uuid,
  locked_until timestamptz,
  last_attempt_at timestamptz,
  last_synced_at timestamptz
);
insert into public.simi_catalog_sync_state (singleton) values (true) on conflict do nothing;

alter table public.simi_property_catalog enable row level security;
alter table public.simi_catalog_sync_state enable row level security;
revoke all on public.simi_property_catalog, public.simi_catalog_sync_state from public, anon, authenticated;
grant all on public.simi_property_catalog, public.simi_catalog_sync_state to service_role;

create or replace function public.search_simi_properties(query_text text, target_team text, appointment_subject text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  search_text text;
  matches jsonb;
  synced timestamptz;
begin
  if not public.is_active_user() then
    raise exception 'Sesión no válida.' using errcode = '42501';
  end if;
  if appointment_subject is distinct from 'Visita comercial' then
    raise exception 'El catálogo solo se consulta para Visita comercial.' using errcode = '42501';
  end if;
  if target_team is null or target_team not in ('all', 'rental', 'sales') then
    raise exception 'Equipo no válido.' using errcode = '22023';
  end if;
  search_text := translate(lower(trim(coalesce(query_text, ''))), 'áéíóúüñ', 'aeiouun');
  if char_length(search_text) < 2 or char_length(search_text) > 120 then
    raise exception 'Escribe entre 2 y 120 caracteres para buscar.' using errcode = '22023';
  end if;

  select coalesce(jsonb_agg(to_jsonb(result) order by result.code), '[]'::jsonb)
  into matches
  from (
    select code, title, neighborhood, city, address, rental, sales, url
    from public.simi_property_catalog
    where active
      and (target_team = 'all' or (target_team = 'rental' and rental) or (target_team = 'sales' and sales))
      and strpos(translate(lower(concat_ws(' ', code, title, neighborhood, city, address)), 'áéíóúüñ', 'aeiouun'), search_text) > 0
    order by code
    limit 20
  ) result;
  select last_synced_at into synced from public.simi_catalog_sync_state where singleton;
  return jsonb_build_object('properties', matches, 'last_synced_at', synced);
end;
$$;
revoke all on function public.search_simi_properties(text, text, text) from public, anon;
grant execute on function public.search_simi_properties(text, text, text) to authenticated;

create or replace function public.begin_simi_catalog_sync()
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  token uuid := gen_random_uuid();
  acquired uuid;
begin
  update public.simi_catalog_sync_state
  set lock_token = token, locked_until = now() + interval '5 minutes', last_attempt_at = now()
  where singleton
    and (locked_until is null or locked_until < now())
    and (last_attempt_at is null or last_attempt_at < now() - interval '1 minute')
    and (last_synced_at is null or last_synced_at < now() - interval '15 minutes')
  returning lock_token into acquired;
  return acquired;
end;
$$;

create or replace function public.apply_simi_catalog(items jsonb, sync_token uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  item_count integer;
begin
  perform 1 from public.simi_catalog_sync_state
  where singleton and lock_token = sync_token and locked_until > now()
  for update;
  if not found then
    raise exception 'La sincronización expiró o fue reemplazada.' using errcode = '42501';
  end if;
  if jsonb_typeof(items) is distinct from 'array' then
    raise exception 'Catálogo no válido.' using errcode = '22023';
  end if;
  item_count := jsonb_array_length(items);
  if item_count < 1 or item_count > 10000 then
    raise exception 'El catálogo vacío o incompleto no reemplazará los datos anteriores.' using errcode = '22023';
  end if;
  if (select count(distinct item->>'code') from jsonb_array_elements(items) item) <> item_count then
    raise exception 'Hay códigos duplicados o ausentes en el catálogo.' using errcode = '22023';
  end if;

  insert into public.simi_property_catalog (code, title, neighborhood, city, address, rental, sales, url, active, synced_at)
  select code, title, coalesce(neighborhood, ''), coalesce(city, ''), coalesce(address, ''), rental, sales, url, true, now()
  from jsonb_to_recordset(items) as item(code text, title text, neighborhood text, city text, address text, rental boolean, sales boolean, url text)
  on conflict (code) do update set
    title = excluded.title, neighborhood = excluded.neighborhood, city = excluded.city,
    address = excluded.address, rental = excluded.rental, sales = excluded.sales,
    url = excluded.url, active = true, synced_at = excluded.synced_at;

  update public.simi_property_catalog set active = false
  where code not in (select item->>'code' from jsonb_array_elements(items) item);
  update public.simi_catalog_sync_state
  set last_synced_at = now(), lock_token = null, locked_until = null
  where singleton and lock_token = sync_token;
  return item_count;
end;
$$;

create or replace function public.cancel_simi_catalog_sync(sync_token uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.simi_catalog_sync_state set lock_token = null, locked_until = null
  where singleton and lock_token = sync_token;
$$;

revoke all on function public.begin_simi_catalog_sync() from public, anon, authenticated;
revoke all on function public.apply_simi_catalog(jsonb, uuid) from public, anon, authenticated;
revoke all on function public.cancel_simi_catalog_sync(uuid) from public, anon, authenticated;
grant execute on function public.begin_simi_catalog_sync() to service_role;
grant execute on function public.apply_simi_catalog(jsonb, uuid) to service_role;
grant execute on function public.cancel_simi_catalog_sync(uuid) to service_role;

commit;
