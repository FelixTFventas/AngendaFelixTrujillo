const { test, before } = require('node:test');
const assert = require('node:assert/strict');
let adapter;
const row = (code = '459-1', extra = {}) => ({
  Codigo_Inmueble: code, IdInmobiliaria: '459', Tipo_Inmueble: 'Apartamento',
  Gestion: 'Arriendo', Barrio: 'Primavera Verde', Ciudad: 'Neiva', ...extra,
});
const json = body => new Response(JSON.stringify(body), { status: 200 });

before(async () => { adapter = await import('../supabase/functions/simi-catalog-sync/simi.mjs'); });

test('el adaptador solo expone datos públicos y nunca toma la dirección de contactos', () => {
  const result = adapter.propertyFromSIMI(row('459-7337', {
    asesor: { Direccion: 'PRIVADA', celular: 'SECRETO' },
    propietario: { correo: 'privado@example.test' },
  }));
  assert.equal(result.address, '');
  assert.equal(result.code, '459-7337');
  assert.equal(JSON.stringify(result).includes('PRIVADA'), false);
  assert.equal(JSON.stringify(result).includes('SECRETO'), false);
  assert.equal(result.url, 'https://felixtrujillofalla.com/inmuebles/arriendo/detalle/459-7337');
  assert.equal(adapter.propertyFromSIMI(row('459-2', { Gestion: 'Venta', Direccion_Inmueble: 'Calle 1' })).address, 'Calle 1');
  const both = adapter.propertyFromSIMI(row('459-3', { Gestion: 'Arriendo/Venta' }));
  assert.equal(both.rental && both.sales, true);
});

test('los datos de otra inmobiliaria y los códigos o gestiones desconocidos son rechazados', () => {
  for (const record of [row('123-1'), row('459-1', { IdInmobiliaria: 123 }), row('javascript:bad'), row('459-1', { Gestion: 'Desconocido' })]) {
    assert.throws(() => adapter.propertyFromSIMI(record));
  }
});

test('descarga paginada con GET HTTPS, redirecciones manuales y autorización Basic documentada', async () => {
  const calls = [];
  const properties = await adapter.downloadCatalog({
    apiKey: 'TOKEN-DE-PRUEBA', pageSize: 2,
    fetcher: async (url, options) => {
      calls.push({ url, options });
      return json({ data: calls.length === 1 ? [row('459-1'), row('459-2')] : [row('459-3')], totalInmuebles: '3', totalPagina: '2' });
    },
  });
  assert.equal(properties.length, 3);
  assert.equal(calls.length, 2);
  assert.ok(calls[1].url.includes('/limite/2/total/2/'));
  for (const { url, options } of calls) {
    assert.equal(new URL(url).origin, 'https://simi-api.com');
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'manual');
    assert.equal(atob(options.headers.Authorization.slice(6)), 'Authorization:TOKEN-DE-PRUEBA');
    assert.equal(url.includes('TOKEN-DE-PRUEBA'), false);
  }
});

test('rechaza respuestas de autenticación incluso si SIMI devuelve HTTP 200', async () => {
  await assert.rejects(adapter.downloadCatalog({
    apiKey: 'TEST', fetcher: async () => json({ status: 401, description: 'No autorizado' }),
  }), error => error.code === 'SIMI_AUTH');
  assert.throws(() => adapter.parsePage({ status: 200, code: 403, data: [] }), error => error.code === 'SIMI_AUTH');
});

test('duplicados, descargas vacías, metadatos cambiantes y cortes no se aceptan como catálogo completo', async () => {
  for (const pages of [
    [{ data: [], totalInmuebles: 0, totalPagina: 1 }],
    [{ data: [row()], totalInmuebles: 2, totalPagina: 2 }, { data: [row()], totalInmuebles: 2, totalPagina: 2 }],
    [{ data: [row()], totalInmuebles: 2, totalPagina: 2 }, { data: [], totalInmuebles: 2, totalPagina: 2 }],
    [{ data: [row()], totalInmuebles: 2, totalPagina: 2 }, { data: [row('459-2')], totalInmuebles: 3, totalPagina: 2 }],
  ]) {
    let index = 0;
    await assert.rejects(adapter.downloadCatalog({
      apiKey: 'TEST', pageSize: 1, fetcher: async () => json(pages[index++]),
    }));
  }
});

test('respeta el límite de páginas y admite paginación sin metadatos solo al llegar al final', async () => {
  await assert.rejects(adapter.downloadCatalog({
    apiKey: 'TEST', maxPages: 1, fetcher: async () => json({ data: [row()], totalPagina: 2 }),
  }), /límite/);
  let page = 0;
  const result = await adapter.downloadCatalog({
    apiKey: 'TEST', pageSize: 1, fetcher: async () => json({ data: ++page === 1 ? [row()] : [] }),
  });
  assert.equal(result.length, 1);
  let shortPage = 0;
  const shortResult = await adapter.downloadCatalog({
    apiKey: 'TEST', pageSize: 50,
    fetcher: async () => json({ data: ++shortPage <= 2 ? [row(`459-${shortPage}`)] : [] }),
  });
  assert.equal(shortResult.length, 2, 'una página corta sin metadatos no se confunde con el final');
  assert.equal(shortPage, 3);
});

test('no revela la clave ni utiliza HTTP en errores de red, cuota o formato', async () => {
  for (const fetcher of [
    async () => { throw new Error('TOKEN-SECRETO'); },
    async () => new Response('TOKEN-SECRETO', { status: 429 }),
    async () => new Response('<html>TOKEN-SECRETO</html>'),
  ]) {
    await assert.rejects(adapter.downloadCatalog({ apiKey: 'TOKEN-SECRETO', fetcher }), error => !error.message.includes('TOKEN-SECRETO'));
  }
  assert.throws(() => adapter.catalogURL(0, 50));
});

test('distingue tiempo agotado, certificado TLS, DNS y fallo de red sin mostrar errores crudos', async () => {
  for (const [cause, expected] of [
    [new DOMException('TOKEN-SECRETO', 'TimeoutError'), 'SIMI_TIMEOUT'],
    [new Error('TLS certificate unknown issuer TOKEN-SECRETO'), 'SIMI_TLS'],
    [Object.assign(new Error('TOKEN-SECRETO'), { cause: { code: 'ENOTFOUND' } }), 'SIMI_DNS'],
    [new Error('connection reset TOKEN-SECRETO'), 'SIMI_NETWORK'],
  ]) {
    await assert.rejects(adapter.downloadCatalog({
      apiKey: 'TOKEN-SECRETO', fetcher: async () => { throw cause; },
    }), error => {
      assert.equal(error.code, expected);
      assert.equal(error.message.includes('TOKEN-SECRETO'), false);
      assert.equal(error.details.page, 1);
      assert.equal(error.details.timeout_ms, 45000);
      assert.equal(JSON.stringify(adapter.safeDiagnostic(error)).includes('TOKEN-SECRETO'), false);
      return true;
    });
  }
});

test('clasifica errores HTTP y cuotas sin repetir consultas automáticamente', async () => {
  for (const [status, expected] of [[401, 'SIMI_AUTH'], [403, 'SIMI_AUTH'], [429, 'SIMI_RATE_LIMIT'], [503, 'SIMI_HTTP']]) {
    let calls = 0;
    await assert.rejects(adapter.downloadCatalog({
      apiKey: 'TEST', fetcher: async () => { calls += 1; return new Response('TOKEN-SECRETO', { status }); },
    }), error => error.code === expected && !error.message.includes('TOKEN-SECRETO'));
    assert.equal(calls, 1);
  }
  await assert.rejects(adapter.downloadCatalog({
    apiKey: 'TEST', fetcher: async () => json({ status: 429, description: 'TOKEN-SECRETO' }),
  }), error => error.code === 'SIMI_RATE_LIMIT');
});

test('solo sigue redirecciones HTTPS oficiales, sin filtrar credenciales a otros destinos', async () => {
  const calls = [];
  const result = await adapter.downloadCatalog({
    apiKey: 'TEST',
    fetcher: async (url, options) => {
      calls.push({ url, options });
      return calls.length === 1
        ? new Response(null, { status: 301, headers: { location: url.replace('https://simi-api.com', 'https://www.simi-api.com') } })
        : json({ data: [row()], totalInmuebles: 1, totalPagina: 1 });
    },
  });
  assert.equal(result.length, 1);
  assert.equal(calls.length, 2);
  assert.equal(new URL(calls[1].url).origin, 'https://www.simi-api.com');
  assert.equal(calls[0].options.headers.Authorization, calls[1].options.headers.Authorization);
  for (const location of [
    'http://simi-api.com/ApiSimiweb/response/x',
    'https://evil.example/ApiSimiweb/response/x',
    'https://simi-api.com.evil.example/ApiSimiweb/response/x',
    'https://simi-api.com/login',
    'https://user:pass@simi-api.com/ApiSimiweb/response/x',
  ]) {
    let count = 0;
    await assert.rejects(adapter.downloadCatalog({
      apiKey: 'TEST', fetcher: async () => { count += 1; return new Response(null, { status: 302, headers: { location } }); },
    }), error => error.code === 'SIMI_REDIRECT');
    assert.equal(count, 1, 'no se contacta con el destino rechazado');
  }
});

test('limita bucles de redirección y el tiempo de toda la descarga', async () => {
  let calls = 0;
  await assert.rejects(adapter.downloadCatalog({
    apiKey: 'TEST',
    fetcher: async url => { calls += 1; return new Response(null, { status: 302, headers: { location: url } }); },
  }), error => error.code === 'SIMI_REDIRECT');
  assert.equal(calls, 3);
  let now = 0;
  await assert.rejects(adapter.downloadCatalog({
    apiKey: 'TEST', totalTimeoutMs: 1000, clock: () => now,
    fetcher: async () => { now = 1100; return json({ data: [row()], totalInmuebles: 2, totalPagina: 2 }); },
  }), error => error.code === 'SIMI_SYNC_TIMEOUT' && error.details.page === 2);
});

test('un fallo durante la lectura del cuerpo recibe el mismo diagnóstico seguro', async () => {
  await assert.rejects(adapter.downloadCatalog({
    apiKey: 'TEST',
    fetcher: async () => new Response(new ReadableStream({
      pull(controller) { controller.error(new DOMException('TOKEN-SECRETO', 'TimeoutError')); },
    })),
  }), error => error.code === 'SIMI_TIMEOUT' && !error.message.includes('TOKEN-SECRETO'));
});

test('la prueba de conexión usa una sola consulta pequeña y no devuelve datos del inmueble', async () => {
  const calls = [];
  const result = await adapter.probeConnection({
    apiKey: 'TEST', pageSize: 100,
    fetcher: async (url, options) => {
      calls.push({ url, options });
      return json({ data: [row('459-1', { propietario: { nombre: 'PRIVADO' } })], totalInmuebles: 500, totalPagina: 500 });
    },
  });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.includes('/total/1/'));
  assert.equal(result.code, 'SIMI_OK');
  assert.equal(result.sample_count, 1);
  assert.equal(JSON.stringify(result).includes('459-1'), false);
  assert.equal(JSON.stringify(result).includes('PRIVADO'), false);
});

test('el diagnóstico permite solo campos numéricos seguros y los límites inválidos no consultan SIMI', async () => {
  const error = new adapter.SimiError('SIMI_NETWORK', 'TOKEN-SECRETO', {
    page: 1, elapsed_ms: 30, apiKey: 'TOKEN-SECRETO', url: 'https://example.com/TOKEN-SECRETO',
  });
  assert.deepEqual(adapter.safeDiagnostic(error), { code: 'SIMI_NETWORK', page: 1, elapsed_ms: 30 });
  assert.deepEqual(adapter.safeDiagnostic(new Error('TOKEN-SECRETO')), { code: 'SIMI_UNEXPECTED' });
  for (const options of [{ requestTimeoutMs: 999999 }, { totalTimeoutMs: 999999 }, { pageSize: NaN }, { apiKey: 'Basic token' }]) {
    let called = false;
    await assert.rejects(adapter.downloadCatalog({ apiKey: 'TEST', ...options, fetcher: async () => { called = true; } }), error => error.code === 'SIMI_CONFIG');
    assert.equal(called, false);
  }
});
