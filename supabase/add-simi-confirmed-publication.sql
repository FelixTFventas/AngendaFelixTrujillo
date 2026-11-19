-- Ejecutar después de add-simi-page-inspection.sql.
-- Solo añade funciones y auditoría: ejecutar este script NO publica ni reinicia.
-- La publicación requiere una sesión admin, un total confirmado y dos consultas de validación.
begin;

alter table public.simi_catalog_sync_state
  add column if not exists last_manual_confirmed_total integer,
  add column if not exists last_manual_confirmed_at timestamptz,
  add column if not exists last_manual_confirmed_by uuid;

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

create or replace function public.acquire_simi_confirmed_publication(
  requested_agency text, confirmed_total integer, expected_snapshot text, expected_next_page integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  state public.simi_catalog_sync_state%rowtype;
  token uuid := gen_random_uuid();
  last_items jsonb;
begin
  if confirmed_total is null or confirmed_total not between 1 and 10000
    or requested_agency is null or requested_agency !~ '^[0-9]+$'
    or expected_snapshot is null or expected_snapshot !~ '^[a-f0-9]{32}$'
    or expected_next_page is null or expected_next_page not between 2 and 200 then
    raise exception 'SIMI_PUBLICATION_CONFIRMATION' using errcode = '22023';
  end if;
  select * into state from public.simi_catalog_sync_state where singleton for update;
  if md5(state.job_id::text) is distinct from expected_snapshot
    or state.next_page <> expected_next_page or state.staged_count <> confirmed_total then
    raise exception 'SIMI_SNAPSHOT_CHANGED' using errcode = '22023';
  end if;
  -- Repetir una petición cuya publicación ya terminó no descarga ni publica otra vez.
  if state.job_status = 'complete' then return public.simi_batch_progress(); end if;
  if state.locked_until > now() then
    return public.simi_batch_progress() || '{"status":"busy"}'::jsonb;
  end if;
  if state.retry_after > now() then
    return public.simi_batch_progress() || '{"status":"waiting"}'::jsonb;
  end if;
  if state.job_status <> 'failed' or state.job_error_code is distinct from 'SIMI_FORMAT'
    or state.expected_total is not null or state.expected_pages is not null then
    raise exception 'SIMI_PUBLICATION_UNAVAILABLE' using errcode = '22023';
  end if;
  if state.job_started_at is null or state.job_started_at < now() - interval '24 hours'
    or state.job_agency is distinct from requested_agency then
    raise exception 'SIMI_JOB_EXPIRED' using errcode = '22023';
  end if;
  if state.next_page > state.job_max_pages
    or (select count(*) from public.simi_catalog_staging where job_id = state.job_id) <> confirmed_total
    or exists (
      select 1 from public.simi_catalog_staging
      where job_id = state.job_id and (page_number >= state.next_page or split_part(code, '-', 1) <> state.job_agency)
    )
    or exists (
      select 1 from generate_series(1, state.next_page - 1) as page(number)
      left join public.simi_catalog_staging staged on staged.job_id = state.job_id and staged.page_number = page.number
      group by page.number
      having count(staged.code) < 1 or count(staged.code) > state.job_page_size
        or (page.number < state.next_page - 1 and count(staged.code) <> state.job_page_size)
    ) then
    raise exception 'SIMI_INCOMPLETE' using errcode = '22023';
  end if;
  select jsonb_agg(jsonb_build_object(
    'code', code, 'title', title, 'neighborhood', neighborhood, 'city', city,
    'address', address, 'rental', rental, 'sales', sales, 'url', url
  ) order by code) into last_items
  from public.simi_catalog_staging where job_id = state.job_id and page_number = state.next_page - 1;
  update public.simi_catalog_sync_state
  set lock_token = token, locked_until = now() + interval '3 minutes',
    retry_after = now() + interval '1 minute', last_attempt_at = now()
  where singleton;
  return public.simi_batch_progress() || jsonb_build_object('batch_token', token, 'last_page_items', last_items);
end;
$$;

create or replace function public.finish_simi_confirmed_publication(
  batch_token uuid, sync_job uuid, confirmed_total integer, last_page_items jsonb,
  terminal_kind text, confirmed_by uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  state public.simi_catalog_sync_state%rowtype;
  saved_items jsonb;
  checked_items jsonb;
begin
  select * into state from public.simi_catalog_sync_state where singleton for update;
  if state.job_id = sync_job and state.job_status = 'complete'
    and state.last_manual_confirmed_total = confirmed_total then return public.simi_batch_progress(); end if;
  if batch_token is null or sync_job is null or state.job_id is distinct from sync_job
    or state.lock_token is distinct from batch_token or state.locked_until is null or state.locked_until <= now()
    or state.job_status <> 'failed' or state.job_error_code is distinct from 'SIMI_FORMAT' then
    raise exception 'SIMI_BATCH_EXPIRED' using errcode = '42501';
  end if;
  if confirmed_total is null or confirmed_total not between 1 and 10000 or confirmed_by is null
    or terminal_kind is null or terminal_kind not in ('no_results_notice', 'empty_list')
    or jsonb_typeof(last_page_items) is distinct from 'array' then
    raise exception 'SIMI_PUBLICATION_CONFIRMATION' using errcode = '22023';
  end if;
  if state.job_started_at is null or state.job_started_at < now() - interval '24 hours' then
    raise exception 'SIMI_JOB_EXPIRED' using errcode = '22023';
  end if;
  if state.staged_count <> confirmed_total or state.expected_total is not null or state.expected_pages is not null
    or (select count(*) from public.simi_catalog_staging where job_id = sync_job) <> confirmed_total
    or exists (
      select 1 from public.simi_catalog_staging
      where job_id = sync_job and (page_number >= state.next_page or split_part(code, '-', 1) <> state.job_agency)
    )
    or exists (
      select 1 from generate_series(1, state.next_page - 1) as page(number)
      left join public.simi_catalog_staging staged on staged.job_id = sync_job and staged.page_number = page.number
      group by page.number
      having count(staged.code) < 1 or count(staged.code) > state.job_page_size
        or (page.number < state.next_page - 1 and count(staged.code) <> state.job_page_size)
    ) then
    raise exception 'SIMI_INCOMPLETE' using errcode = '22023';
  end if;
  select jsonb_agg(jsonb_build_object(
    'code', code, 'title', title, 'neighborhood', neighborhood, 'city', city,
    'address', address, 'rental', rental, 'sales', sales, 'url', url
  ) order by code) into saved_items
  from public.simi_catalog_staging where job_id = sync_job and page_number = state.next_page - 1;
  select jsonb_agg(to_jsonb(item) order by code) into checked_items
  from jsonb_to_recordset(last_page_items) as item(
    code text, title text, neighborhood text, city text, address text, rental boolean, sales boolean, url text
  );
  if saved_items is null or saved_items is distinct from checked_items then
    raise exception 'SIMI_CHANGED' using errcode = '22023';
  end if;
  -- Publicación atómica. Un fallo revierte TODO y conserva la descarga y el catálogo anterior.
  insert into public.simi_property_catalog (code, title, neighborhood, city, address, rental, sales, url, active, synced_at)
  select code, title, neighborhood, city, address, rental, sales, url, true, now()
  from public.simi_catalog_staging where job_id = sync_job
  on conflict (code) do update set
    title = excluded.title, neighborhood = excluded.neighborhood, city = excluded.city,
    address = excluded.address, rental = excluded.rental, sales = excluded.sales,
    url = excluded.url, active = true, synced_at = excluded.synced_at;
  update public.simi_property_catalog set active = false
  where code not in (select code from public.simi_catalog_staging where job_id = sync_job);
  update public.simi_catalog_sync_state
  set job_status = 'complete', expected_total = confirmed_total, expected_pages = next_page - 1,
    last_synced_at = now(), job_error_code = null, lock_token = null, locked_until = null, retry_after = null,
    last_manual_confirmed_total = confirmed_total, last_manual_confirmed_at = now(), last_manual_confirmed_by = confirmed_by
  where singleton;
  delete from public.simi_catalog_staging where job_id = sync_job;
  return public.simi_batch_progress();
end;
$$;

revoke all on function public.simi_batch_progress() from public, anon, authenticated;
revoke all on function public.acquire_simi_confirmed_publication(text, integer, text, integer) from public, anon, authenticated;
revoke all on function public.finish_simi_confirmed_publication(uuid, uuid, integer, jsonb, text, uuid) from public, anon, authenticated;
grant execute on function public.simi_batch_progress() to service_role;
grant execute on function public.acquire_simi_confirmed_publication(text, integer, text, integer) to service_role;
grant execute on function public.finish_simi_confirmed_publication(uuid, uuid, integer, jsonb, text, uuid) to service_role;

commit;
