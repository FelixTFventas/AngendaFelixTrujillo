import { createClient } from 'npm:@supabase/supabase-js@2'

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

    const { password } = await request.json()
    if (typeof password !== 'string' || password.length < 10) {
      return json({ error: 'La contraseña debe tener al menos 10 caracteres.' }, 400)
    }

    const { error: passwordError } = await admin.auth.admin.updateUserById(authData.user.id, { password })
    if (passwordError) return json({ error: passwordError.message }, 400)

    const { error: profileError } = await admin
      .from('profiles')
      .update({ must_change_password: false })
      .eq('id', authData.user.id)

    if (profileError) return json({ error: 'La contraseña cambió, pero no fue posible actualizar el perfil.' }, 500)
    return json({ success: true })
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
