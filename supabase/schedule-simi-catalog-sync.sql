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

-- Una actualización cada seis horas, no una consulta por cada cita o búsqueda.
select cron.schedule(
  'agenda-simi-catalog',
  '0 */6 * * *',
  $job$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'agenda_simi_sync_url' limit 1),
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-simi-sync-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'agenda_simi_sync_token' limit 1)
      ),
      body := '{"appointment_subject":"Visita comercial"}'::jsonb,
      timeout_milliseconds := 120000
    );
  $job$
);
