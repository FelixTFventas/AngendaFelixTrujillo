import { createClient } from 'npm:@supabase/supabase-js@2'
import { downloadCatalog } from './simi.mjs'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info, x-simi-sync-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
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
  if (request.method !== 'POST') return json({ error: 'Método no permitido.' }, 405)
  let syncToken: string | null = null
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
      const { data: caller } = await admin.from('profiles')
        .select('role, active, must_change_password').eq('id', data.user.id).single()
      if (!caller?.active || caller.must_change_password || caller.role !== 'admin') {
        return json({ error: 'Solo el administrador puede actualizar el catálogo.' }, 403)
      }
    }
    const body = await request.json()
    if (body.appointment_subject !== 'Visita comercial') {
      return json({ error: 'El catálogo solo se consulta para Visita comercial.' }, 400)
    }
    const apiKey = Deno.env.get('SIMI_API_KEY')
    if (!apiKey) return json({ error: 'Falta configurar el secreto SIMI_API_KEY en Supabase.' }, 503)
    const { data: lock, error: lockError } = await admin.rpc('begin_simi_catalog_sync')
    if (lockError) return json({ error: 'Falta activar supabase/add-simi-property-catalog.sql.' }, 503)
    if (!lock) return json({ error: 'Ya hay una actualización en curso o el catálogo se actualizó hace menos de 15 minutos. Espera antes de reintentar.' }, 409)
    syncToken = lock
    const properties = await downloadCatalog({
      apiKey, agency: Deno.env.get('SIMI_AGENCY_ID') || '459',
      pageSize: Number(Deno.env.get('SIMI_PAGE_SIZE') || 50),
      maxPages: Number(Deno.env.get('SIMI_MAX_PAGES') || 100),
    })
    const { data: count, error } = await admin.rpc('apply_simi_catalog', { items: properties, sync_token: syncToken })
    if (error) throw new Error('No fue posible guardar el catálogo completo. Se conservan los datos anteriores.')
    syncToken = null
    return json({ count, message: 'Catálogo actualizado. SIMI no ha sido modificado.' })
  } catch (error) {
    if (syncToken) await admin.rpc('cancel_simi_catalog_sync', { sync_token: syncToken })
    // Los errores del adaptador son mensajes controlados; no registrar cuerpos ni credenciales.
    const message = error instanceof Error ? error.message : 'No fue posible actualizar el catálogo.'
    return json({ error: message.startsWith('SIMI ') || message.startsWith('No fue posible ')
      || message.startsWith('El catálogo ') || message.startsWith('La ') || message.startsWith('Se alcanzó ')
      || message.startsWith('Configura ') || message.startsWith('Límite ')
      ? message : 'No fue posible actualizar el catálogo. Revisa la configuración de SIMI.' }, 502)
  }
})

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}
