-- OPCIONAL: ejecutar solo después de confirmar con SIMI los límites de consultas.
-- Requiere las extensiones pg_cron y pg_net, y dos secretos creados en Supabase Vault:
-- agenda_simi_sync_url: https://TU-PROYECTO.supabase.co/functions/v1/simi-catalog-sync
-- agenda_simi_sync_token: mismo valor privado de SIMI_SYNC_SECRET en Edge Function Secrets.
-- Nunca escribir claves en este archivo ni subirlas al repositorio.
do $$
begin
  if not exists (select 1 from vault.decrypted_secrets where name = 'agenda_simi_sync_url')
    or not exists (select 1 from vault.decrypted_secrets where name = 'agenda_simi_sync_token') then
    raise exception 'Crea primero los dos secretos del programador en Supabase Vault.';
  end if;
end;
$$;

select cron.unschedule(jobid) from cron.job where jobname = 'agenda-simi-catalog';

-- Ejecuta un lote por minuto solo si hay trabajo pendiente.
-- La función no inicia un catálogo nuevo hasta seis horas después del último completado.
select cron.schedule(
  'agenda-simi-catalog',
  '* * * * *',
  $job$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'agenda_simi_sync_url' limit 1),
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-simi-sync-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'agenda_simi_sync_token' limit 1)
      ),
      body := '{"appointment_subject":"Visita comercial","sync_protocol":"batch-v1"}'::jsonb,
      timeout_milliseconds := 120000
    )
    from public.simi_catalog_sync_state
    where singleton
      and (locked_until is null or locked_until <= now())
      and (retry_after is null or retry_after <= now())
      and (
        job_status = 'pending'
        or (job_status in ('idle', 'complete')
          and (last_synced_at is null or last_synced_at <= now() - interval '6 hours'))
      );
  $job$
);
