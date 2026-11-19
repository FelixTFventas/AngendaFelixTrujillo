-- Ejecutar después de add-simi-property-catalog.sql, antes de desplegar la función por lotes.
-- Conserva el catálogo publicado y las citas. Solo añade estado de trabajo y almacenamiento temporal.
begin;

alter table public.simi_catalog_sync_state
  add column if not exists job_id uuid,
  add column if not exists job_status text not null default 'idle',
  add column if not exists job_started_at timestamptz,
  add column if not exists next_page integer not null default 1,
  add column if not exists staged_count integer not null default 0,
  add column if not exists expected_total integer,
  add column if not exists expected_pages integer,
  add column if not exists job_page_size integer,
  add column if not exists job_max_pages integer,
  add column if not exists job_agency text,
  add column if not exists job_error_code text,
  add column if not exists retry_after timestamptz;

create table if not exists public.simi_catalog_staging (
  job_id uuid not null,
  page_number integer not null check (page_number > 0),
  like public.simi_property_catalog including defaults including constraints,
  primary key (job_id, code)
);
alter table public.simi_catalog_staging enable row level security;
revoke all on public.simi_catalog_staging from public, anon, authenticated;
grant all on public.simi_catalog_staging to service_role;

create or replace function public.simi_batch_progress()
returns jsonb
language sql
volatile
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'status', job_status, 'job_id', job_id, 'next_page', next_page,
    'received', staged_count, 'total', expected_total, 'total_pages', expected_pages,
    'page_size', job_page_size, 'max_pages', job_max_pages, 'agency', job_agency,
    'error_code', job_error_code, 'restart_required', job_status = 'failed',
    'snapshot_ref', md5(job_id::text),
    'retry_after', retry_after, 'last_synced_at', last_synced_at
  )
  from public.simi_catalog_sync_state where singleton;
$$;

create or replace function public.acquire_simi_sync_batch(
  requested_page_size integer, requested_agency text, requested_max_pages integer,
  refresh_seconds integer default 900
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  state public.simi_catalog_sync_state%rowtype;
  token uuid := gen_random_uuid();
begin
  if requested_page_size is null or requested_page_size not between 1 and 100
    or requested_max_pages is null or requested_max_pages not between 1 and 200
    or requested_agency is null or requested_agency !~ '^[0-9]+$'
    or refresh_seconds is null or refresh_seconds not between 900 and 86400 then
    raise exception 'SIMI_CONFIG' using errcode = '22023';
  end if;
  select * into state from public.simi_catalog_sync_state where singleton for update;
  if state.locked_until > now() then
    return public.simi_batch_progress() || '{"status":"busy"}'::jsonb;
  end if;
  if state.retry_after > now() then
    return public.simi_batch_progress() || '{"status":"waiting"}'::jsonb;
  end if;
  if state.job_status = 'pending'
    and (state.job_started_at < now() - interval '24 hours' or state.job_agency <> requested_agency) then
    update public.simi_catalog_sync_state set job_status = 'failed', job_error_code = 'SIMI_JOB_EXPIRED'
    where singleton;
    return public.simi_batch_progress();
  end if;
  if state.job_status = 'failed' then return public.simi_batch_progress(); end if;
  if state.job_status in ('idle', 'complete') then
    if state.last_synced_at > now() - make_interval(secs => refresh_seconds) then
      return public.simi_batch_progress() || jsonb_build_object(
        'status', 'complete', 'received', (select count(*) from public.simi_property_catalog where active)
      );
    end if;
    -- Solo se limpian restos privados del trabajo anterior, ya finalizado.
    -- El filtro explícito mantiene la protección de Supabase contra DELETE sin WHERE.
    delete from public.simi_catalog_staging where job_id = state.job_id;
    update public.simi_catalog_sync_state
    set job_id = gen_random_uuid(), job_status = 'pending', job_started_at = now(),
      next_page = 1, staged_count = 0, expected_total = null, expected_pages = null,
      job_page_size = requested_page_size, job_max_pages = requested_max_pages,
      job_agency = requested_agency, job_error_code = null, retry_after = null
    where singleton;
  end if;
  update public.simi_catalog_sync_state
  set lock_token = token, locked_until = now() + interval '3 minutes', last_attempt_at = now()
  where singleton;
  return public.simi_batch_progress() || jsonb_build_object('batch_token', token);
end;
$$;

create or replace function public.save_simi_sync_page(
  batch_token uuid, sync_job uuid, requested_page integer, items jsonb,
  page_total integer default null, page_count integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  state public.simi_catalog_sync_state%rowtype;
  amount integer;
  received integer;
  total integer;
  pages integer;
  finished boolean;
begin
  select * into state from public.simi_catalog_sync_state where singleton for update;
  if state.job_id = sync_job and state.job_status = 'complete' then return public.simi_batch_progress(); end if;
  if state.job_status <> 'pending' or state.job_id is distinct from sync_job
    or state.lock_token is distinct from batch_token or batch_token is null
    or state.locked_until is null or state.locked_until <= now() then
    raise exception 'SIMI_BATCH_EXPIRED' using errcode = '42501';
  end if;
  if requested_page is null or requested_page < 1 or requested_page > state.job_max_pages then
    raise exception 'SIMI_PAGE_LIMIT' using errcode = '22023';
  end if;
  -- Repetir la confirmación de una página ya guardada es seguro e idempotente.
  if requested_page < state.next_page then return public.simi_batch_progress(); end if;
  if requested_page <> state.next_page then raise exception 'SIMI_PAGE_ORDER' using errcode = '22023'; end if;
  if jsonb_typeof(items) is distinct from 'array' then raise exception 'SIMI_FORMAT' using errcode = '22023'; end if;
  amount := jsonb_array_length(items);
  if amount > 1000 then raise exception 'SIMI_RESPONSE_SIZE' using errcode = '22023'; end if;
  if page_count = 0 and amount > 0 then raise exception 'SIMI_FORMAT' using errcode = '22023'; end if;
  if page_total < 0 or page_total > 10000 or page_count < 0 or page_count > state.job_max_pages then
    raise exception 'SIMI_PAGE_LIMIT' using errcode = '22023';
  end if;
  if (state.expected_total is not null and page_total is not null and state.expected_total <> page_total)
    or (state.expected_pages is not null and page_count is not null and state.expected_pages <> page_count) then
    raise exception 'SIMI_CHANGED' using errcode = '22023';
  end if;
  total := coalesce(state.expected_total, page_total);
  pages := coalesce(state.expected_pages, nullif(page_count, 0));
  received := state.staged_count + amount;
  if received > 10000 or (total is not null and received > total) then
    raise exception 'SIMI_INCOMPLETE' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_to_recordset(items) as item(code text)
    where code is null or split_part(code, '-', 1) <> state.job_agency
  ) then raise exception 'SIMI_PROPERTY_CODE' using errcode = '22023'; end if;
  if (select count(distinct item->>'code') from jsonb_array_elements(items) item) <> amount
    or exists (
      select 1 from jsonb_array_elements(items) item
      join public.simi_catalog_staging staged on staged.job_id = sync_job and staged.code = item->>'code'
    ) then raise exception 'SIMI_DUPLICATE' using errcode = '22023'; end if;

  finished := case when pages is not null then requested_page = pages
    when total is not null then received = total else amount = 0 end;
  if (amount = 0 and not finished) or (finished and (received = 0 or (total is not null and received <> total))) then
    raise exception 'SIMI_INCOMPLETE' using errcode = '22023';
  end if;
  if not finished and requested_page >= state.job_max_pages then
    raise exception 'SIMI_PAGE_LIMIT' using errcode = '22023';
  end if;

  insert into public.simi_catalog_staging (job_id, page_number, code, title, neighborhood, city, address, rental, sales, url)
  select sync_job, requested_page, code, title, coalesce(neighborhood, ''), coalesce(city, ''),
    coalesce(address, ''), rental, sales, url
  from jsonb_to_recordset(items) as item(code text, title text, neighborhood text, city text, address text, rental boolean, sales boolean, url text);
  update public.simi_catalog_sync_state
  set next_page = requested_page + 1, staged_count = received, expected_total = total,
    expected_pages = pages, job_error_code = null
  where singleton;

  if finished then
    -- Publicación atómica: hasta este punto las búsquedas siguen usando el catálogo anterior.
    insert into public.simi_property_catalog (code, title, neighborhood, city, address, rental, sales, url, active, synced_at)
    select code, title, neighborhood, city, address, rental, sales, url, true, now()
    from public.simi_catalog_staging where job_id = sync_job
    on conflict (code) do update set
      title = excluded.title, neighborhood = excluded.neighborhood, city = excluded.city,
      address = excluded.address, rental = excluded.rental, sales = excluded.sales,
      url = excluded.url, active = true, synced_at = excluded.synced_at;
    update public.simi_property_catalog set active = false
    where code not in (select code from public.simi_catalog_staging where job_id = sync_job);
    update public.simi_catalog_sync_state set job_status = 'complete', last_synced_at = now(),
      lock_token = null, locked_until = null, retry_after = null where singleton;
    delete from public.simi_catalog_staging where job_id = sync_job;
  end if;
  return public.simi_batch_progress();
end;
$$;

create or replace function public.release_simi_sync_batch(batch_token uuid, failure_code text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if failure_code is not null and failure_code !~ '^SIMI_[A-Z_]+$' then
    raise exception 'SIMI_CONFIG' using errcode = '22023';
  end if;
  update public.simi_catalog_sync_state
  set lock_token = null, locked_until = null, job_error_code = failure_code,
    retry_after = case when failure_code is null then null else now() + interval '1 minute' end,
    job_status = case when failure_code in (
      'SIMI_CHANGED', 'SIMI_DUPLICATE', 'SIMI_INCOMPLETE', 'SIMI_PAGE_LIMIT',
      'SIMI_PROPERTY_CODE', 'SIMI_PROPERTY_OPERATION', 'SIMI_FORMAT', 'SIMI_REJECTED', 'SIMI_PAGE_ORDER'
    ) then 'failed' else job_status end
  where singleton and lock_token = batch_token;
  return public.simi_batch_progress();
end;
$$;

create or replace function public.reset_simi_sync_job()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  state public.simi_catalog_sync_state%rowtype;
begin
  select * into state from public.simi_catalog_sync_state where singleton for update;
  if state.locked_until > now() then return public.simi_batch_progress() || '{"status":"busy"}'::jsonb; end if;
  if state.retry_after > now() then return public.simi_batch_progress() || '{"status":"waiting"}'::jsonb; end if;
  delete from public.simi_catalog_staging where job_id = state.job_id;
  update public.simi_catalog_sync_state set job_id = null, job_status = 'idle',
    job_started_at = null, next_page = 1, staged_count = 0, expected_total = null, expected_pages = null,
    job_page_size = null, job_max_pages = null, job_agency = null, job_error_code = null,
    lock_token = null, locked_until = null, retry_after = null where singleton;
  return public.simi_batch_progress();
end;
$$;

revoke all on function public.simi_batch_progress() from public, anon, authenticated;
revoke all on function public.acquire_simi_sync_batch(integer, text, integer, integer) from public, anon, authenticated;
revoke all on function public.save_simi_sync_page(uuid, uuid, integer, jsonb, integer, integer) from public, anon, authenticated;
revoke all on function public.release_simi_sync_batch(uuid, text) from public, anon, authenticated;
revoke all on function public.reset_simi_sync_job() from public, anon, authenticated;
grant execute on function public.simi_batch_progress() to service_role;
grant execute on function public.acquire_simi_sync_batch(integer, text, integer, integer) to service_role;
grant execute on function public.save_simi_sync_page(uuid, uuid, integer, jsonb, integer, integer) to service_role;
grant execute on function public.release_simi_sync_batch(uuid, text) to service_role;
grant execute on function public.reset_simi_sync_job() to service_role;

-- Evita que una función antigua publique una descarga completa mientras existe un trabajo por lotes.
revoke execute on function public.begin_simi_catalog_sync() from service_role;
revoke execute on function public.apply_simi_catalog(jsonb, uuid) from service_role;
revoke execute on function public.cancel_simi_catalog_sync(uuid) from service_role;

-- Diagnóstico manual; mismo contenido que add-simi-page-inspection.sql.
create or replace function public.acquire_simi_page_inspection(requested_agency text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  state public.simi_catalog_sync_state%rowtype;
  token uuid := gen_random_uuid();
begin
  if requested_agency is null or requested_agency !~ '^[0-9]+$' then
    raise exception 'SIMI_CONFIG' using errcode = '22023';
  end if;
  select * into state from public.simi_catalog_sync_state where singleton for update;
  if state.locked_until > now() then
    return public.simi_batch_progress() || '{"status":"busy"}'::jsonb;
  end if;
  if state.retry_after > now() then
    return public.simi_batch_progress() || '{"status":"waiting"}'::jsonb;
  end if;
  if state.job_id is null or state.job_status <> 'failed'
    or state.job_error_code is distinct from 'SIMI_FORMAT' then
    raise exception 'SIMI_INSPECTION_UNAVAILABLE' using errcode = '22023';
  end if;
  if state.job_started_at is null or state.job_started_at < now() - interval '24 hours'
    or state.job_agency is distinct from requested_agency then
    raise exception 'SIMI_JOB_EXPIRED' using errcode = '22023';
  end if;
  -- Comparte el bloqueo con sincronización y reinicio. Un diagnóstico por minuto.
  -- El estado sigue siendo failed y el cursor nunca cambia.
  update public.simi_catalog_sync_state
  set lock_token = token, locked_until = now() + interval '3 minutes',
    retry_after = now() + interval '1 minute', last_attempt_at = now()
  where singleton;
  return public.simi_batch_progress() || jsonb_build_object('batch_token', token);
end;
$$;

revoke all on function public.acquire_simi_page_inspection(text) from public, anon, authenticated;
grant execute on function public.acquire_simi_page_inspection(text) to service_role;

commit;
