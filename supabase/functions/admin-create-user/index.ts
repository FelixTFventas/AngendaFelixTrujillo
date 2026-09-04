import { createClient } from 'npm:@supabase/supabase-js@2'

const advisorColors = ['amber', 'teal', 'blue', 'violet', 'coral', 'emerald', 'indigo', 'rose', 'orange', 'cyan', 'lime', 'slate']

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (request.method !== 'POST') return json({ error: 'Método no permitido.' }, 405)

  try {
    const token = request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '')
    if (!token) return json({ error: 'Sesión no válida.' }, 401)

    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      { auth: { autoRefreshToken: false, persistSession: false } },
    )

    const { data: authData, error: authError } = await admin.auth.getUser(token)
    if (authError || !authData.user) return json({ error: 'Sesión no válida.' }, 401)

    const { data: caller } = await admin
      .from('profiles')
      .select('role, active, must_change_password')
      .eq('id', authData.user.id)
      .single()

    if (!caller?.active || caller.must_change_password || caller.role !== 'admin') {
      return json({ error: 'Solo el administrador puede crear usuarios.' }, 403)
    }

    const body = await request.json()
    const email = String(body.email || '').trim().toLowerCase()
    const fullName = String(body.full_name || '').trim()
    const password = String(body.temporary_password || '')
    const role = body.role === 'supervisor' ? 'supervisor' : 'advisor'
    const team = role === 'advisor' && ['rental', 'sales'].includes(body.team) ? body.team : null
    const color = role === 'advisor' && advisorColors.includes(body.color) ? body.color : null

    if (!email || !fullName || password.length < 10) {
      return json({ error: 'Completa el nombre, correo y una contraseña temporal de al menos 10 caracteres.' }, 400)
    }
    if (role === 'advisor' && (!team || !color)) {
      return json({ error: 'Los asesores requieren equipo y color.' }, 400)
    }

    if (color) {
      const { data: assignedColor, error: colorError } = await admin
        .from('advisors')
        .select('id')
        .eq('color', color)
        .maybeSingle()

      if (colorError) return json({ error: 'No fue posible validar el color seleccionado.' }, 500)
      if (assignedColor) return json({ error: 'Ese color ya está asignado a otro asesor.' }, 409)
    }

    const { data: created, error: createError } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: fullName },
    })

    if (createError || !created.user) {
      return json({ error: createError?.message || 'No fue posible crear el usuario.' }, 400)
    }

    const { data: profile, error: profileError } = await admin
      .from('profiles')
      .update({
        full_name: fullName,
        role,
        team,
        color,
        active: true,
        must_change_password: true,
      })
      .eq('id', created.user.id)
      .select('id, email, full_name, role, team, color, active')
      .single()

    if (profileError) {
      const { error: deleteError } = await admin.auth.admin.deleteUser(created.user.id)
      if (deleteError) {
        return json({ error: 'No se completó el perfil y no fue posible limpiar la cuenta creada. Revísala en Authentication.' }, 500)
      }
      if (profileError.code === '23505') {
        return json({ error: 'Ese color ya está asignado a otro asesor.' }, 409)
      }
      return json({ error: 'No fue posible completar el perfil del usuario.' }, 500)
    }

    return json({ profile }, 201)
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'Error inesperado.' }, 500)
  }
})

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}
