import { createClient } from 'npm:@supabase/supabase-js@2'
import { downloadBatch, inspectPage, validateCatalogEnd, probeConnection, safeDiagnostic, SimiError } from './simi.mjs'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info, x-simi-sync-secret, x-simi-appointment-subject',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
}

async function validScheduleSecret(value: string | null) {
  const expected = Deno.env.get('SIMI_SYNC_SECRET')
  if (!expected || expected.length < 32 || !value || value.length > 256) return false
  const encoder = new TextEncoder()
  const [a, b] = await Promise.all([expected, value].map(secret =>
    crypto.subtle.digest('SHA-256', encoder.encode(secret))))
  const first = new Uint8Array(a)
  const second = new Uint8Array(b)
  return first.reduce((difference, byte, index) => difference | (byte ^ second[index]), 0) === 0
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (!['GET', 'POST'].includes(request.method)) return json({ error: 'Método no permitido.' }, 405)
  let batchToken: string | null = null
  let progress: Record<string, unknown> | null = null
  let action = 'sync'
  let callerId: string | null = null
  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  )
  try {
    const scheduled = await validScheduleSecret(request.headers.get('x-simi-sync-secret'))
    if (!scheduled) {
      const token = request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '')
      if (!token) return json({ error: 'Sesión no válida.' }, 401)
      const { data, error } = await admin.auth.getUser(token)
      if (error || !data.user) return json({ error: 'Sesión no válida.' }, 401)
      callerId = data.user.id
      const { data: caller } = await admin.from('profiles')
        .select('role, active, must_change_password').eq('id', data.user.id).single()
      if (!caller?.active || caller.must_change_password || caller.role !== 'admin') {
        return json({ error: 'Solo el administrador puede actualizar el catálogo.' }, 403)
      }
    }
    const body = request.method === 'GET'
      ? { appointment_subject: request.headers.get('x-simi-appointment-subject'), action: 'probe' }
      : await request.json()
    if (body.appointment_subject !== 'Visita comercial') {
      return json({ error: 'El catálogo solo se consulta para Visita comercial.' }, 400)
    }
    if (body.action != null && !['sync', 'probe', 'restart', 'status', 'inspect', 'publish'].includes(body.action)) {
      return json({ error: 'Acción no válida.' }, 400)
    }
    action = body.action || 'sync'
    if (['sync', 'restart', 'inspect', 'publish'].includes(action) && body.sync_protocol !== 'batch-v1') {
      return json({ error: 'Recarga la agenda actualizada para usar la carga por lotes.', code: 'SIMI_CLIENT_UPDATE' }, 409)
    }
    if (scheduled && ['restart', 'inspect', 'publish'].includes(action)) return json({ error: 'Esta acción requiere una sesión de administrador.' }, 403)
    if (action === 'publish' && (body.confirmed !== true || !Number.isSafeInteger(body.confirmed_total)
      || body.confirmed_total < 1 || body.confirmed_total > 10000
      || typeof body.expected_snapshot !== 'string' || !/^[a-f0-9]{32}$/.test(body.expected_snapshot)
      || !Number.isSafeInteger(body.expected_next_page) || body.expected_next_page < 2 || body.expected_next_page > 200)) {
      return json({ code: 'SIMI_PUBLICATION_CONFIRMATION', error: 'Confirma el total verificado en SIMI y el estado actual antes de publicar.' }, 400)
    }
    if (action === 'status') {
      const { data, error } = await admin.rpc('simi_batch_progress')
      if (error) return migrationRequired()
      return json(clientProgress(data))
    }
    const apiKey = Deno.env.get('SIMI_API_KEY')
    if (!apiKey) return json({ error: 'Falta configurar el secreto SIMI_API_KEY en Supabase.' }, 503)
    const settings = {
      apiKey, agency: Deno.env.get('SIMI_AGENCY_ID') || '459',
      pageSize: Number(Deno.env.get('SIMI_PAGE_SIZE') || 20),
      maxPages: Number(Deno.env.get('SIMI_MAX_PAGES') || 100),
      requestTimeoutMs: Number(Deno.env.get('SIMI_REQUEST_TIMEOUT_MS') || 45000),
      totalTimeoutMs: Number(Deno.env.get('SIMI_SYNC_TIMEOUT_MS') || 100000),
      batchPages: Number(Deno.env.get('SIMI_BATCH_PAGES') || 5),
      batchTimeoutMs: Number(Deno.env.get('SIMI_BATCH_TIMEOUT_MS') || 60000),
    }
    if (action === 'probe') {
      return json({ ...await probeConnection(settings), message: 'Conexión de lectura con SIMI comprobada. El catálogo no se ha modificado.' })
    }
    if (action === 'publish') {
      const { data, error } = await admin.rpc('acquire_simi_confirmed_publication', {
        requested_agency: settings.agency, confirmed_total: body.confirmed_total,
        expected_snapshot: body.expected_snapshot, expected_next_page: body.expected_next_page,
      })
      if (error) throw publicationError(error)
      progress = data
      if (progress && ['busy', 'waiting'].includes(String(progress.status))) return pausedResponse(progress)
      if (progress?.status === 'complete') return json({ code: 'SIMI_PUBLISHED', ...clientProgress(progress), count: progress.received })
      batchToken = typeof progress?.batch_token === 'string' ? progress.batch_token : null
      if (!batchToken || typeof progress?.job_id !== 'string') throw new SimiError('SIMI_SAVE', 'No se pudo reservar la validación de publicación.')
      const evidence = await validateCatalogEnd({
        ...settings, pageSize: Number(progress.page_size), maxPages: Number(progress.max_pages), agency: String(progress.agency),
      }, progress, body.confirmed_total)
      const { data: published, error: publishError } = await admin.rpc('finish_simi_confirmed_publication', {
        batch_token: batchToken, sync_job: progress.job_id, confirmed_total: body.confirmed_total,
        last_page_items: evidence.last_page_items, terminal_kind: evidence.terminal_kind, confirmed_by: callerId,
      })
      if (publishError) throw publicationError(publishError)
      if (published?.status !== 'complete' || published.received !== body.confirmed_total) {
        throw new SimiError('SIMI_SAVE', 'Supabase no confirmó la publicación. Consulta el estado antes de reintentar.')
      }
      progress = published
      batchToken = null
      return json({ code: 'SIMI_PUBLISHED', ...clientProgress(progress), count: published.received,
        message: 'Carga guardada validada y publicada con confirmación del administrador. SIMI y las citas no han sido modificados.' })
    }
    if (action === 'inspect') {
      const { data, error } = await admin.rpc('acquire_simi_page_inspection', { requested_agency: settings.agency })
      if (error) {
        if (error.message === 'SIMI_JOB_EXPIRED') {
          throw new SimiError('SIMI_JOB_EXPIRED', 'El trabajo tiene más de 24 horas o corresponde a otra agencia. No se revisará ni publicará esa copia antigua.')
        }
        if (error.message === 'SIMI_INSPECTION_UNAVAILABLE') {
          throw new SimiError('SIMI_INSPECTION_UNAVAILABLE', 'Solo se puede revisar un trabajo detenido por SIMI_FORMAT. Consulta su estado actualizado sin reiniciarlo.')
        }
        if (error.message === 'SIMI_CONFIG') throw new SimiError('SIMI_CONFIG', 'Revisa la agencia configurada en Supabase.')
        if (['PGRST202', '42883', '42501'].includes(error.code)) {
          return json({ code: 'SIMI_INSPECTION_MIGRATION', error: 'Falta ejecutar supabase/add-simi-page-inspection.sql.' }, 503)
        }
        throw new SimiError('SIMI_SAVE', 'No se pudo reservar el diagnóstico. Se conserva la carga parcial.')
      }
      progress = data
      if (progress && ['busy', 'waiting'].includes(String(progress.status))) return pausedResponse(progress)
      batchToken = typeof progress?.batch_token === 'string' ? progress.batch_token : null
      if (!batchToken || progress?.status !== 'failed' || progress.error_code !== 'SIMI_FORMAT') {
        throw new SimiError('SIMI_SAVE', 'No se pudo obtener la página fallida para revisarla.')
      }
      const result = await inspectPage({
        ...settings, pageSize: Number(progress.page_size), maxPages: Number(progress.max_pages),
        agency: String(progress.agency),
      }, Number(progress.next_page))
      // El diagnóstico no guarda páginas ni reabre el trabajo, aunque SIMI ahora entregue una lista.
      const { data: released, error: releaseError } = await admin.rpc('release_simi_sync_batch', {
        batch_token: batchToken, failure_code: 'SIMI_FORMAT',
      })
      if (releaseError) throw new SimiError('SIMI_SAVE', 'La página se revisó, pero no se pudo liberar la reserva. Espera antes de reintentar.')
      batchToken = null
      progress = released
      return json({ code: 'SIMI_INSPECTION', ...result, progress: clientProgress(progress),
        message: 'Diagnóstico de una sola página. No se ha publicado, reiniciado ni reanudado la carga.' })
    }
    if (action === 'restart') {
      const { data, error } = await admin.rpc('reset_simi_sync_job')
      if (error) return migrationRequired()
      if (['busy', 'waiting'].includes(data?.status)) return pausedResponse(data)
    }
    const { data: acquired, error: lockError } = await admin.rpc('acquire_simi_sync_batch', {
      requested_page_size: settings.pageSize, requested_agency: settings.agency,
      requested_max_pages: settings.maxPages, refresh_seconds: scheduled ? 21600 : 900,
    })
    if (lockError) {
      if (lockError.message === 'SIMI_CONFIG') {
        throw new SimiError('SIMI_CONFIG', 'Revisa la agencia, el tamaño de página y los límites configurados en Supabase.')
      }
      if (!lockError.code || ['PGRST202', '42883', '42P01', '42703', '42501'].includes(lockError.code)) return migrationRequired()
      throw new SimiError('SIMI_SAVE', 'No se pudo reservar el lote en Supabase. El catálogo publicado se conserva.')
    }
    progress = acquired
    if (!progress) throw new SimiError('SIMI_SAVE', 'No se pudo obtener el avance guardado.')
    if (['busy', 'waiting', 'failed'].includes(String(progress.status))) return pausedResponse(progress)
    if (progress.status === 'complete') return json({
      ...clientProgress(progress), count: progress.received, message: 'El catálogo ya está actualizado.',
    })
    batchToken = typeof progress.batch_token === 'string' ? progress.batch_token : null
    if (!batchToken || typeof progress.job_id !== 'string') throw new SimiError('SIMI_SAVE', 'No se pudo reservar el lote.')
    const syncJob = progress.job_id
    // Mantener los parámetros originales del trabajo, aunque cambien los secretos entre lotes.
    const result = await downloadBatch({
      ...settings, pageSize: Number(progress.page_size), maxPages: Number(progress.max_pages),
      agency: String(progress.agency),
    }, progress, async (page: { page: number; properties: unknown[]; total: number | null; pages: number | null }) => {
      const { data, error } = await admin.rpc('save_simi_sync_page', {
        batch_token: batchToken, sync_job: syncJob, requested_page: page.page, items: page.properties,
        page_total: page.total, page_count: page.pages,
      })
      if (error) {
        const known = ['SIMI_CHANGED', 'SIMI_DUPLICATE', 'SIMI_INCOMPLETE', 'SIMI_PAGE_LIMIT',
          'SIMI_PAGE_ORDER', 'SIMI_PROPERTY_CODE', 'SIMI_FORMAT', 'SIMI_BATCH_EXPIRED', 'SIMI_RESPONSE_SIZE']
        const code = known.includes(error.message) ? error.message : error.code === '23505' ? 'SIMI_DUPLICATE' : 'SIMI_SAVE'
        throw new SimiError(code, 'No se pudo confirmar esta página. Se conserva el avance anterior y el catálogo publicado.', { page: page.page })
      }
      progress = data
      return data
    })
    if (result.status !== 'complete') {
      const { data, error } = await admin.rpc('release_simi_sync_batch', { batch_token: batchToken })
      if (error) throw new SimiError('SIMI_SAVE', 'El avance se guardó, pero no se pudo liberar el lote. Espera antes de continuar.')
      progress = data
    } else progress = result
    batchToken = null
    return json({
      ...clientProgress(progress), count: progress?.status === 'complete' ? progress.received : undefined,
      message: progress?.status === 'complete' ? 'Catálogo completo publicado. SIMI no ha sido modificado.' : 'Lote guardado. La carga puede continuar.',
    })
  } catch (error) {
    const diagnostic = safeDiagnostic(error)
    if (batchToken) {
      try {
        const { data } = await admin.rpc('release_simi_sync_batch', {
          batch_token: batchToken, failure_code: ['inspect', 'publish'].includes(action) ? 'SIMI_FORMAT' : diagnostic.code,
        })
        if (data) progress = data
      } catch {}
    }
    // Nunca registrar el error crudo, encabezados, respuesta de SIMI, clave ni token de sesión.
    console.error(JSON.stringify({ event: 'simi_request_failed', action, ...diagnostic }))
    const message = error instanceof SimiError
      ? error.message : 'No fue posible completar la operación. Revisa el diagnóstico seguro de la función.'
    const status = ['SIMI_TIMEOUT', 'SIMI_SYNC_TIMEOUT'].includes(diagnostic.code) ? 504
      : diagnostic.code === 'SIMI_RATE_LIMIT' ? 429
        : ['SIMI_JOB_EXPIRED', 'SIMI_INSPECTION_UNAVAILABLE', 'SIMI_PUBLICATION_CONFIRMATION',
          'SIMI_PUBLICATION_UNAVAILABLE', 'SIMI_SNAPSHOT_CHANGED', 'SIMI_CHANGED', 'SIMI_INCOMPLETE'].includes(diagnostic.code) ? 409
          : diagnostic.code === 'SIMI_PUBLICATION_MIGRATION' ? 503 : 502
    return json({ error: message, code: diagnostic.code, diagnostic, progress: clientProgress(progress) }, status)
  }
})

function publicationError(error: { code?: string; message?: string }) {
  const messages: Record<string, string> = {
    SIMI_PUBLICATION_CONFIRMATION: 'El total confirmado o los datos de validación no son válidos.',
    SIMI_SNAPSHOT_CHANGED: 'La descarga o su total cambió. Recupera el estado actual y vuelve a confirmar el total sin reiniciar.',
    SIMI_PUBLICATION_UNAVAILABLE: 'Este cierre manual solo admite una carga detenida por formato sin totales del proveedor.',
    SIMI_JOB_EXPIRED: 'La carga tiene más de 24 horas o corresponde a otra agencia. No se publicó.',
    SIMI_INCOMPLETE: 'Los registros guardados no coinciden con el total o faltan páginas. No se publicó.',
    SIMI_CHANGED: 'La última página no coincide con la copia guardada. No se publicó.',
    SIMI_BATCH_EXPIRED: 'La reserva expiró. Consulta el estado antes de reintentar.',
  }
  if (error.message && Object.hasOwn(messages, error.message)) return new SimiError(error.message, messages[error.message])
  if (['PGRST202', '42883', '42703', '42501'].includes(error.code || '')) {
    return new SimiError('SIMI_PUBLICATION_MIGRATION', 'Falta ejecutar supabase/add-simi-confirmed-publication.sql.')
  }
  return new SimiError('SIMI_SAVE', 'No se pudo confirmar la publicación en Supabase. El catálogo y el avance anterior se conservan.')
}

function migrationRequired() {
  return json({ error: 'Falta ejecutar supabase/add-simi-batch-sync.sql para activar la carga por lotes.', code: 'SIMI_BATCH_MIGRATION' }, 503)
}

function clientProgress(value: unknown) {
  if (!value || typeof value !== 'object') return null
  const source = value as Record<string, unknown>
  const result: Record<string, unknown> = {}
  if (['idle', 'pending', 'complete', 'failed', 'busy', 'waiting'].includes(String(source.status))) result.status = source.status
  if (typeof source.restart_required === 'boolean') result.restart_required = source.restart_required
  if (typeof source.snapshot_ref === 'string' && /^[a-f0-9]{32}$/.test(source.snapshot_ref)) result.snapshot_ref = source.snapshot_ref
  for (const key of ['next_page', 'received', 'total', 'total_pages']) {
    const number = source[key]
    if (number === null || (typeof number === 'number' && Number.isSafeInteger(number) && number >= 0)) result[key] = number
  }
  for (const key of ['last_synced_at', 'retry_after']) {
    const value = source[key]
    if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) result[key] = new Date(value).toISOString()
  }
  if (typeof source.error_code === 'string' && /^SIMI_[A-Z_]+$/.test(source.error_code)) result.error_code = source.error_code
  return result
}

function pausedResponse(value: Record<string, unknown>) {
  const failed = value.status === 'failed'
  return json({
    error: failed ? value.error_code === 'SIMI_FORMAT'
      ? 'La carga parcial está detenida por formato. Revisa la página fallida antes de reiniciarla; el avance y el catálogo anterior se conservan.'
      : 'La carga parcial necesita reiniciarse. El catálogo anterior sigue disponible.'
      : value.status === 'waiting' ? 'Espera un minuto después del último fallo antes de continuar.'
        : 'Otro lote está en curso. El avance está guardado; espera antes de continuar.',
    code: failed ? 'SIMI_JOB_FAILED' : 'SIMI_BATCH_BUSY', progress: clientProgress(value),
  }, 409)
}

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}
