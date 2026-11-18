const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { stripTypeScriptTypes } = require('node:module');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const source = readFileSync(require.resolve('../supabase/functions/simi-catalog-sync/index.ts'), 'utf8');
const script = stripTypeScriptTypes(source.replace(/^import .*$/gm, ''));

function setup(options = {}) {
  let handler;
  const calls = [];
  const env = {
    SUPABASE_URL: 'https://test.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'LOCAL-TEST',
    SIMI_API_KEY: 'TEST-ONLY', ...options.env,
  };
  const admin = {
    auth: { getUser: async token => token === 'valid'
      ? { data: { user: { id: 'user' } }, error: null }
      : { data: {}, error: {} } },
    from: () => {
      const query = { select: () => query, eq: () => query, single: async () => ({ data: {
        role: options.role || 'admin', active: options.active !== false,
        must_change_password: options.mustChange || false,
      } }) };
      return query;
    },
    rpc: async (name, args) => {
      calls.push({ name, args });
      if (name === 'begin_simi_catalog_sync') return { data: options.busy ? null : 'lock-token', error: null };
      return { data: name === 'apply_simi_catalog' ? 1 : null, error: null };
    },
  };
  vm.runInNewContext(script, {
    Deno: { env: { get: name => env[name] }, serve: callback => { handler = callback; } },
    createClient: () => admin,
    downloadCatalog: async () => {
      calls.push({ name: 'download' });
      if (options.failDownload) throw new Error('No fue posible conectar con SIMI por HTTPS. El catálogo anterior se conserva.');
      return [{ code: '459-1' }];
    },
    Response, Request, TextEncoder, crypto: webcrypto,
  });
  return {
    calls,
    request: (body = { appointment_subject: 'Visita comercial' }, headers = { Authorization: 'Bearer valid' }, method = 'POST') =>
      handler(new Request('https://test.supabase.co/functions/v1/simi-catalog-sync', {
        method, headers: { 'Content-Type': 'application/json', ...headers },
        ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
      })),
  };
}

test('la función rechaza métodos no admitidos y sesiones ausentes sin consultar SIMI', async () => {
  const fixture = setup();
  assert.equal((await fixture.request({}, {}, 'GET')).status, 405);
  assert.equal((await fixture.request({}, {})).status, 401);
  assert.equal((await fixture.request({}, { Authorization: 'Bearer invalid' })).status, 401);
  assert.equal(fixture.calls.length, 0);
});

test('solo administradores activos con contraseña cambiada pueden sincronizar', async () => {
  for (const options of [{ role: 'advisor' }, { role: 'supervisor' }, { active: false }, { mustChange: true }]) {
    const fixture = setup(options);
    assert.equal((await fixture.request()).status, 403);
    assert.equal(fixture.calls.length, 0);
  }
  const fixture = setup();
  const response = await fixture.request();
  assert.equal(response.status, 200);
  assert.equal((await response.json()).count, 1);
  assert.deepEqual(fixture.calls.map(call => call.name), ['begin_simi_catalog_sync', 'download', 'apply_simi_catalog']);
});

test('otros asuntos y falta de clave no hacen llamadas a SIMI', async () => {
  const fixture = setup();
  assert.equal((await fixture.request({ appointment_subject: 'Entrega al arrendatario' })).status, 400);
  assert.equal(fixture.calls.length, 0);
  const missing = setup({ env: { SIMI_API_KEY: '' } });
  assert.equal((await missing.request()).status, 503);
  assert.equal(missing.calls.length, 0);
});

test('el programador necesita un secreto independiente válido y de al menos 32 caracteres', async () => {
  const secret = 'SECRETO-DE-PRUEBA-SOLO-LOCAL-1234567890';
  const fixture = setup({ env: { SIMI_SYNC_SECRET: secret } });
  assert.equal((await fixture.request(undefined, { 'x-simi-sync-secret': 'incorrecto' })).status, 401);
  assert.equal((await fixture.request(undefined, { 'x-simi-sync-secret': secret })).status, 200);
  const short = setup({ env: { SIMI_SYNC_SECRET: 'corto' } });
  assert.equal((await short.request(undefined, { 'x-simi-sync-secret': 'corto' })).status, 401);
});

test('un bloqueo activo no permite descargar y un fallo conserva el catálogo liberando el bloqueo', async () => {
  const busy = setup({ busy: true });
  assert.equal((await busy.request()).status, 409);
  assert.equal(busy.calls.some(call => call.name === 'download'), false);
  const failing = setup({ failDownload: true });
  assert.equal((await failing.request()).status, 502);
  assert.deepEqual(failing.calls.map(call => call.name), ['begin_simi_catalog_sync', 'download', 'cancel_simi_catalog_sync']);
});
