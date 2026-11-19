-- Ejecutar después de add-simi-batch-sync.sql.
-- Añade un diagnóstico manual de la página fallida, sin reiniciar ni publicar.
-- Ejecutar este archivo solo crea la función; no consulta SIMI ni cambia el avance.
begin;

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
