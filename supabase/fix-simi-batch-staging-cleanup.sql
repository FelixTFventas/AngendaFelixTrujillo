-- Para proyectos que ya ejecutaron add-simi-batch-sync.sql.
-- Corrige "DELETE requires a WHERE clause" sin desactivar la protección de Supabase.
-- Solo reemplaza la función de reserva: no ejecuta descargas, no reinicia trabajos
-- y no modifica las citas, el catálogo publicado ni el avance guardado.
begin;

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

revoke all on function public.acquire_simi_sync_batch(integer, text, integer, integer) from public, anon, authenticated;
grant execute on function public.acquire_simi_sync_batch(integer, text, integer, integer) to service_role;

commit;
