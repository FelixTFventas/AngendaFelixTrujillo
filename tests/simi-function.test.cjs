const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { stripTypeScriptTypes } = require('node:module');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const source = readFileSync(require.resolve('../supabase/functions/simi-catalog-sync/index.ts'), 'utf8');
const script = stripTypeScriptTypes(source.replace(/^import .*$/gm, ''));
let adapter;
before(async () => { adapter = await import('../supabase/functions/simi-catalog-sync/simi.mjs'); });

function setup(options = {}) {
  let handler;
  const calls = [];
  const logs = [];
  let currentProgress = {
    status: options.complete ? 'complete' : 'pending', next_page: 1, received: 0, total: 1, total_pages: 1,
    job_id: 'job-id', batch_token: 'lock-token', page_size: 20, max_pages: 100, agency: '459', ...options.progress,
  };
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
      if (name === 'acquire_simi_sync_batch') return {
        data: { ...currentProgress, ...(options.busy ? { status: 'busy' } : {}) },
        error: options.acquireError || (options.missingMigration ? {} : null),
      };
      if (name === 'acquire_simi_page_inspection') return { data: { ...currentProgress }, error: options.inspectionError || null };
      if (name === 'save_simi_sync_page') {
        currentProgress = { ...currentProgress, status: options.pending ? 'pending' : 'complete', next_page: 2, received: 1 };
      }
      if (name === 'release_simi_sync_batch' && options.savedBeforeFailure) {
        currentProgress = { ...currentProgress, next_page: 22, received: 420 };
      }
      if (name === 'reset_simi_sync_job') currentProgress = { ...currentProgress, status: 'idle' };
      return { data: currentProgress, error: null };
    },
  };
  vm.runInNewContext(script, {
    Deno: { env: { get: name => env[name] }, serve: callback => { handler = callback; } },
    createClient: () => admin,
    downloadBatch: async (settings, progress, persist) => {
      calls.push({ name: 'download' });
      if (options.failDownload) throw new Error('No fue posible conectar con SIMI por HTTPS. El catálogo anterior se conserva.');
      return persist({ page: 1, properties: [{ code: '459-1' }], total: 1, pages: 1 });
    },
    probeConnection: async () => {
      calls.push({ name: 'probe' });
      if (options.probeError) throw options.probeError;
      return { ok: true, code: 'SIMI_OK', sample_count: 1, elapsed_ms: 10 };
    },
    inspectPage: async (settings, page) => {
      calls.push({ name: 'inspect', settings, page });
      if (options.inspectError) throw options.inspectError;
      return adapter.inspectPage({ ...settings, fetcher: async () => new Response(JSON.stringify(options.inspectPayload ?? 'No hay inmuebles')) }, page);
    },
    SimiError: adapter.SimiError, safeDiagnostic: adapter.safeDiagnostic,
    console: { error: message => logs.push(JSON.parse(message)) },
    Response, Request, TextEncoder, crypto: webcrypto,
  });
  return {
    calls,
    logs,
    request: (body = { appointment_subject: 'Visita comercial', sync_protocol: 'batch-v1' }, headers = { Authorization: 'Bearer valid' }, method = 'POST') =>
      handler(new Request('https://test.supabase.co/functions/v1/simi-catalog-sync', {
        method, headers: { 'Content-Type': 'application/json', ...headers },
        ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
      })),
  };
}

test('la función rechaza métodos no admitidos y sesiones ausentes sin consultar SIMI', async () => {
  const fixture = setup();
  assert.equal((await fixture.request({}, {}, 'PUT')).status, 405);
  assert.equal((await fixture.request({}, {}, 'GET')).status, 401);
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
  assert.deepEqual(fixture.calls.map(call => call.name), ['acquire_simi_sync_batch', 'download', 'save_simi_sync_page']);
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
  assert.deepEqual(failing.calls.map(call => call.name), ['acquire_simi_sync_batch', 'download', 'release_simi_sync_batch']);
});

test('GET prueba la conexión sin adquirir bloqueos ni escribir el catálogo', async () => {
  const fixture = setup();
  const response = await fixture.request(undefined, {
    Authorization: 'Bearer valid', 'x-simi-appointment-subject': 'Visita comercial',
  }, 'GET');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).code, 'SIMI_OK');
  assert.deepEqual(fixture.calls.map(call => call.name), ['probe']);
  assert.equal((await fixture.request(undefined, { Authorization: 'Bearer valid' }, 'GET')).status, 400);
});

test('solo administrador activo puede ejecutar la prueba pequeña', async () => {
  for (const options of [{ role: 'advisor' }, { role: 'supervisor' }, { active: false }]) {
    const fixture = setup(options);
    assert.equal((await fixture.request(undefined, {
      Authorization: 'Bearer valid', 'x-simi-appointment-subject': 'Visita comercial',
    }, 'GET')).status, 403);
    assert.equal(fixture.calls.length, 0);
  }
});

test('se devuelven y registran códigos seguros de error sin copiar información privada', async () => {
  const fixture = setup({ probeError: new adapter.SimiError('SIMI_TIMEOUT', 'Tiempo de espera agotado.', {
    page: 1, timeout_ms: 45000, apiKey: 'NO-REVELAR', url: 'https://example.com/NO-REVELAR',
  }) });
  const response = await fixture.request(undefined, {
    Authorization: 'Bearer valid', 'x-simi-appointment-subject': 'Visita comercial',
  }, 'GET');
  assert.equal(response.status, 504);
  const payload = await response.json();
  assert.equal(payload.code, 'SIMI_TIMEOUT');
  assert.equal(payload.diagnostic.page, 1);
  assert.equal(JSON.stringify(payload).includes('NO-REVELAR'), false);
  assert.equal(JSON.stringify(fixture.logs).includes('NO-REVELAR'), false);
  assert.equal(fixture.logs[0].event, 'simi_request_failed');
});

test('responde con avance pendiente y nunca expone tokens internos al navegador', async () => {
  const fixture = setup({ pending: true });
  const response = await fixture.request();
  const body = await response.json();
  assert.equal(body.status, 'pending');
  assert.equal(body.received, 1);
  assert.equal(body.next_page, 2);
  assert.equal('batch_token' in body, false);
  assert.equal('job_id' in body, false);
  assert.equal(fixture.calls.at(-1).name, 'release_simi_sync_batch');
});

test('un fallo devuelve el último avance confirmado para poder continuar', async () => {
  const fixture = setup({ failDownload: true, savedBeforeFailure: true });
  const response = await fixture.request();
  const body = await response.json();
  assert.equal(body.progress.next_page, 22);
  assert.equal(body.progress.received, 420);
  assert.equal(JSON.stringify(body).includes('lock-token'), false);
});

test('clientes antiguos y ausencia de migración no descargan páginas', async () => {
  const fixture = setup();
  assert.equal((await fixture.request({ appointment_subject: 'Visita comercial' })).status, 409);
  assert.equal(fixture.calls.length, 0);
  const missing = setup({ missingMigration: true });
  const response = await missing.request();
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, 'SIMI_BATCH_MIGRATION');
  assert.equal(missing.calls.some(call => call.name === 'download'), false);
});

test('configuración inválida y fallos de base de datos no se confunden con migración ausente', async () => {
  for (const [acquireError, expected] of [
    [{ message: 'SIMI_CONFIG', code: '22023' }, 'SIMI_CONFIG'],
    [{ message: 'PRIVATE-DATABASE-DETAIL', code: 'XX000' }, 'SIMI_SAVE'],
  ]) {
    const fixture = setup({ acquireError });
    const response = await fixture.request();
    const body = await response.json();
    assert.equal(body.code, expected);
    assert.equal(JSON.stringify(body).includes('PRIVATE-DATABASE-DETAIL'), false);
    assert.equal(fixture.calls.some(call => call.name === 'download'), false);
  }
});

test('el programador usa seis horas entre catálogos nuevos y no puede reiniciar trabajos', async () => {
  const secret = 'SECRETO-DE-PRUEBA-SOLO-LOCAL-1234567890';
  const fixture = setup({ env: { SIMI_SYNC_SECRET: secret } });
  assert.equal((await fixture.request(undefined, { 'x-simi-sync-secret': secret })).status, 200);
  assert.equal(fixture.calls[0].args.refresh_seconds, 21600);
  const manual = setup();
  await manual.request();
  assert.equal(manual.calls[0].args.refresh_seconds, 900);
  const restart = setup({ env: { SIMI_SYNC_SECRET: secret } });
  const response = await restart.request({
    appointment_subject: 'Visita comercial', sync_protocol: 'batch-v1', action: 'restart',
  }, { 'x-simi-sync-secret': secret });
  assert.equal(response.status, 403);
  assert.equal(restart.calls.length, 0);
});

const inspectionBody = { appointment_subject: 'Visita comercial', sync_protocol: 'batch-v1', action: 'inspect' };
const failedPage = { status: 'failed', error_code: 'SIMI_FORMAT', next_page: 33, received: 628, total: null, total_pages: null };

test('la revisión usa solo el cursor y tamaño guardados, no las páginas enviadas por el cliente', async () => {
  const fixture = setup({ progress: failedPage, env: { SIMI_PAGE_SIZE: '100' } });
  const response = await fixture.request({ ...inspectionBody, next_page: 1, page_size: 1 });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.code, 'SIMI_INSPECTION');
  assert.equal(body.classification, 'no_results_notice');
  assert.equal(body.diagnostic.page, 33);
  assert.equal(body.progress.received, 628);
  assert.equal(body.progress.next_page, 33);
  assert.equal(body.progress.status, 'failed');
  assert.deepEqual(fixture.calls.map(call => call.name), ['acquire_simi_page_inspection', 'inspect', 'release_simi_sync_batch']);
  assert.equal(fixture.calls[1].settings.pageSize, 20);
  assert.equal(fixture.calls[1].page, 33);
  assert.equal(fixture.calls[2].args.failure_code, 'SIMI_FORMAT');
  assert.equal(JSON.stringify(body).includes('lock-token'), false);
  assert.equal(JSON.stringify(body).includes('job-id'), false);
  assert.equal(fixture.logs.length, 0);
});

test('la inspección no publica ni reanuda aunque la respuesta nueva sea una lista válida o vacía', async () => {
  for (const inspectPayload of [{ data: [] }, { data: [{ Codigo_Inmueble: '459-1', Gestion: 'Arriendo', propietario: 'PRIVADO' }] }]) {
    const fixture = setup({ progress: failedPage, inspectPayload });
    const response = await fixture.request(inspectionBody);
    const body = await response.json();
    assert.equal(body.progress.status, 'failed');
    assert.equal(body.progress.next_page, 33);
    assert.equal(body.progress.received, 628);
    assert.equal(JSON.stringify(body).includes('PRIVADO'), false);
    assert.equal(JSON.stringify(body).includes('459-1'), false);
    assert.equal(fixture.calls.some(call => ['download', 'save_simi_sync_page', 'reset_simi_sync_job'].includes(call.name)), false);
  }
});

test('la revisión rechaza otros roles, programador y clientes sin protocolo antes de reservar', async () => {
  for (const options of [{ role: 'advisor' }, { role: 'supervisor' }, { active: false }, { mustChange: true }]) {
    const fixture = setup(options);
    assert.equal((await fixture.request(inspectionBody)).status, 403);
    assert.equal(fixture.calls.length, 0);
  }
  const secret = 'SECRETO-DE-PRUEBA-SOLO-LOCAL-1234567890';
  const scheduled = setup({ env: { SIMI_SYNC_SECRET: secret } });
  assert.equal((await scheduled.request(inspectionBody, { 'x-simi-sync-secret': secret })).status, 403);
  assert.equal(scheduled.calls.length, 0);
  const outdated = setup();
  assert.equal((await outdated.request({ appointment_subject: 'Visita comercial', action: 'inspect' })).status, 409);
  assert.equal(outdated.calls.length, 0);
});

test('una reserva ocupada, migración ausente o trabajo no elegible nunca consulta SIMI', async () => {
  for (const options of [
    { progress: { ...failedPage, status: 'busy' } },
    { progress: { ...failedPage, status: 'waiting' } },
    { inspectionError: { message: 'SIMI_INSPECTION_UNAVAILABLE', code: '22023' } },
    { inspectionError: { message: 'SIMI_JOB_EXPIRED', code: '22023' } },
    { inspectionError: { message: 'missing', code: 'PGRST202' } },
  ]) {
    const fixture = setup(options);
    const response = await fixture.request(inspectionBody);
    assert.ok(response.status >= 400);
    assert.equal(fixture.calls.some(call => call.name === 'inspect'), false);
    if (options.inspectionError?.code === 'PGRST202') {
      const body = await response.json();
      assert.equal(body.code, 'SIMI_INSPECTION_MIGRATION');
      assert.ok(body.error.includes('add-simi-page-inspection.sql'));
    }
  }
});

test('un error durante la revisión libera la reserva y mantiene el fallo original sin filtrar información', async () => {
  const fixture = setup({ progress: failedPage,
    inspectError: new adapter.SimiError('SIMI_NETWORK', 'Error seguro.', { page: 33, raw: 'PRIVADO' }) });
  const response = await fixture.request(inspectionBody);
  const body = await response.json();
  assert.equal(response.status, 502);
  assert.equal(body.code, 'SIMI_NETWORK');
  assert.equal(body.progress.received, 628);
  assert.equal(body.progress.error_code, 'SIMI_FORMAT');
  assert.equal(fixture.calls.at(-1).args.failure_code, 'SIMI_FORMAT');
  assert.equal(JSON.stringify(body).includes('PRIVADO'), false);
  assert.equal(JSON.stringify(fixture.logs).includes('PRIVADO'), false);
});
