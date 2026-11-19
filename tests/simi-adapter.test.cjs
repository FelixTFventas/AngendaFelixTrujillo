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

test('normaliza colecciones directas, envueltas y objetos indexados de PHP sin cambiar los registros', () => {
  const rows = [row('459-1'), row('459-2')];
  const formats = [
    { data: rows, totalInmuebles: 2, totalPagina: 1 },
    { Inmuebles: rows, totalInmuebles: 2, totalPagina: 1 },
    { inmuebles: rows, totalInmuebles: 2, totalPagina: 1 },
    { data: { data: rows, totalInmuebles: 2, totalPagina: 1 } },
    { data: { Inmuebles: rows }, totalInmuebles: 2, totalPagina: 1 },
    { response: { data: rows, totalInmuebles: 2, totalPagina: 1 } },
    [{ data: rows, totalInmuebles: 2, totalPagina: 1 }],
    { data: { 1: rows[0], 3: rows[1] }, totalInmuebles: 2, totalPagina: 1 },
    { 1: rows[0], 3: rows[1], totalInmuebles: 2, totalPagina: 1 },
    { data: { '459-1': rows[0], '459-2': rows[1] }, totalInmuebles: 2, totalPagina: 1 },
    { data: [...rows, { totalInmuebles: 2, totalPagina: 1 }] },
    { data: rows, pagination: { total_inmuebles: 2, total_pages: 1, current_page: 1 } },
  ];
  for (const payload of formats) {
    const parsed = adapter.parsePage(payload, 1);
    assert.deepEqual(parsed.rows, rows);
    assert.equal(parsed.total, 2);
    assert.equal(parsed.pageCount, 1);
  }
  assert.deepEqual(adapter.parsePage(rows).rows, rows);
});

test('acepta JSON doblemente codificado con profundidad limitada', () => {
  const payload = { data: [row()], totalInmuebles: 1, totalPagina: 1 };
  assert.deepEqual(adapter.parsePage(JSON.stringify(payload)).rows, payload.data);
  assert.deepEqual(adapter.parsePage({ data: JSON.stringify(payload) }).rows, payload.data);
  assert.throws(() => adapter.parsePage({ data: JSON.stringify({ data: JSON.stringify({ data: JSON.stringify(payload) }) }) }),
    error => error.code === 'SIMI_FORMAT');
});

test('un acuse de éxito sin inmuebles, un detalle individual o un objeto vacío no son catálogos', () => {
  for (const payload of [
    { code: 0, response: true }, {}, { data: {} }, row(),
    [{ code: 0, response: true }], { data: [{ nombre: 'PRIVADO' }] },
    { data: [row(), { propietario: 'PRIVADO' }] },
    { data: [row()], inmuebles: [row('459-2')] },
  ]) {
    assert.throws(() => adapter.parsePage(payload), error => error.code === 'SIMI_FORMAT');
  }
});

test('rechaza errores de cualquier envoltorio aunque contengan una colección aparentemente válida', () => {
  for (const payload of [
    { response: false, data: [row()] },
    { response: 'false', data: [row()] },
    { response: ' False ', data: [row()] },
    { success: false, data: [row()] },
    { status: 'error', data: [row()] },
    { status: 'false', data: [row()] },
    { error: 'TOKEN-SECRETO', data: [row()] },
    { data: { response: false, data: [row()] } },
    { response: { data: [row()], success: false } },
    { data: [row(), { response: false, totalInmuebles: 1 }] },
  ]) {
    assert.throws(() => adapter.parsePage(payload), error => error.code === 'SIMI_REJECTED'
      && !error.message.includes('TOKEN-SECRETO'));
  }
  for (const payload of [
    { data: { status: 401, data: [row()] } },
    [{ code: 403 }],
    { response: { code: 401, data: [row()] } },
    { status: 'Unauthorized', data: [row()] },
  ]) {
    assert.throws(() => adapter.parsePage(payload), error => error.code === 'SIMI_AUTH');
  }
});

test('el formato y la paginación del listado completo se preservan al importar objetos PHP', async () => {
  let calls = 0;
  const properties = await adapter.downloadCatalog({
    apiKey: 'TEST', pageSize: 1,
    fetcher: async () => {
      calls += 1;
      return json({ data: {
        [String(calls * 2)]: row(`459-${calls}`),
        totalInmuebles: '2', totalPagina: '2', pagina_actual: String(calls),
      } });
    },
  });
  assert.equal(properties.length, 2);
  assert.equal(calls, 2);
});

test('metadatos contradictorios, fraccionarios, negativos o páginas repetidas bloquean la importación', () => {
  for (const payload of [
    { data: { data: [row()], totalInmuebles: 9 }, totalInmuebles: 1 },
    { data: [row()], totalInmuebles: '1.000' },
    { data: [row()], totalInmuebles: '1.5' },
    { data: [row()], totalInmuebles: -1 },
    { data: [row()], totalPagina: 0 },
    { data: [row()], totalInmuebles: 0 },
    { data: [row()], pagina_actual: 2 },
    { data: [row()], totalPagina: true },
  ]) {
    assert.throws(() => adapter.parsePage(payload, 1), error => error.code === 'SIMI_FORMAT');
  }
});

test('el diagnóstico describe solo nombres autorizados y tipos, nunca valores o claves de campos desconocidos', () => {
  const payload = {
    status: 'TOKEN-SECRETO',
    data: { TOKEN_PRIVADO: { correo: 'persona@example.test' } },
    apiKey: 'TOKEN-SECRETO', 'LLAVE-SECRETA': 'privado', description: 'TOKEN-SECRETO',
  };
  let failure;
  try { adapter.parsePage(payload); } catch (error) { failure = error; }
  assert.equal(failure.code, 'SIMI_FORMAT');
  assert.ok(failure.message.includes('data=object'));
  const diagnostic = adapter.safeDiagnostic(failure);
  assert.deepEqual(diagnostic.response_shape, { root: 'object', data: 'object', status: 'string', description: 'string' });
  const output = JSON.stringify({ message: failure.message, diagnostic });
  for (const value of ['TOKEN-SECRETO', 'TOKEN_PRIVADO', 'LLAVE-SECRETA', 'persona@example.test']) {
    assert.equal(output.includes(value), false);
  }
  const malicious = new adapter.SimiError('SIMI_FORMAT', 'Seguro', {
    response_shape: { root: 'object', data: 'TOKEN-SECRETO', apiKey: 'string' },
  });
  assert.deepEqual(adapter.safeDiagnostic(malicious).response_shape, { root: 'object' });
});

test('la prueba pequeña valida que la respuesta contenga inmuebles de la agencia correcta', async () => {
  await assert.rejects(adapter.probeConnection({
    apiKey: 'TEST', fetcher: async () => json({ Inmuebles: [row('123-1')] }),
  }), error => error.code === 'SIMI_PROPERTY_CODE');
  const response = await adapter.probeConnection({
    apiKey: 'TEST', fetcher: async () => json({ Inmuebles: { 3: row('459-3') }, response: true }),
  });
  assert.equal(response.code, 'SIMI_OK');
  assert.equal(response.sample_count, 1);
});

test('los lotes reanudan el cursor y confirman cada página antes de consultar la siguiente', async () => {
  const requests = [];
  const confirmed = [];
  let state = { status: 'pending', next_page: 22, received: 420, total: 500, total_pages: 25 };
  const settings = {
    apiKey: 'TEST', batchPages: 2,
    fetcher: async url => {
      const page = Number(url.match(/\/limite\/(\d+)/)[1]);
      requests.push(page);
      if (page > 22) assert.ok(confirmed.includes(page - 1));
      return json({
        data: Array.from({ length: 20 }, (_, n) => row(`459-${(page - 1) * 20 + n + 1}`)),
        totalInmuebles: 500, totalPagina: 25, pagina_actual: page,
      });
    },
  };
  const persist = async page => {
    confirmed.push(page.page);
    state = { ...state, next_page: page.page + 1, received: state.received + page.properties.length,
      status: page.page === 25 ? 'complete' : 'pending' };
    return state;
  };
  state = await adapter.downloadBatch(settings, state, persist);
  assert.equal(state.next_page, 24);
  assert.equal(state.received, 460);
  state = await adapter.downloadBatch(settings, state, persist);
  assert.equal(state.status, 'complete');
  assert.deepEqual(requests, [22, 23, 24, 25]);
});

test('un error de página no deshace confirmaciones anteriores y no se reintenta automáticamente', async () => {
  const confirmed = [];
  let calls = 0;
  await assert.rejects(adapter.downloadBatch({
    apiKey: 'TEST', fetcher: async () => {
      if (++calls === 2) throw new Error('network');
      return json({ data: [row()], totalInmuebles: 2, totalPagina: 2 });
    },
  }, { status: 'pending', next_page: 1, received: 0 }, async page => {
    confirmed.push(page.page);
    return { status: 'pending', next_page: 2, received: 1, total: 2, total_pages: 2 };
  }), error => error.code === 'SIMI_NETWORK');
  assert.deepEqual(confirmed, [1]);
  assert.equal(calls, 2);
});

test('termina el lote antes de agotar el tiempo sin perder el avance confirmado', async () => {
  let clock = 0;
  let calls = 0;
  const progress = await adapter.downloadBatch({
    apiKey: 'TEST', batchTimeoutMs: 60000, clock: () => clock,
    fetcher: async () => {
      calls += 1; clock = 20000;
      return json({ data: [row()], totalInmuebles: 3, totalPagina: 3 });
    },
  }, { status: 'pending', next_page: 1, received: 0 }, async () => ({
    status: 'pending', next_page: 2, received: 1, total: 3, total_pages: 3,
  }));
  assert.equal(calls, 1);
  assert.equal(progress.next_page, 2);
});

test('cambios de totales y confirmaciones sin cursor nuevo detienen el lote', async () => {
  await assert.rejects(adapter.downloadBatch({
    apiKey: 'TEST', fetcher: async () => json({ data: [row()], totalInmuebles: 3, totalPagina: 3 }),
  }, { status: 'pending', next_page: 2, received: 1, total: 2, total_pages: 2 }, async () => {
    assert.fail('no debe confirmarse una página de otro catálogo');
  }), error => error.code === 'SIMI_CHANGED');
  await assert.rejects(adapter.downloadBatch({
    apiKey: 'TEST', fetcher: async () => json({ data: [row()], totalInmuebles: 2, totalPagina: 2 }),
  }, { status: 'pending', next_page: 1, received: 0 }, async () => ({
    status: 'pending', next_page: 1, received: 0,
  })), error => error.code === 'SIMI_SAVE');
});

test('el diagnóstico consulta solo la página guardada y clasifica texto sin devolverlo', async () => {
  for (const [text, kind] of [
    ['No se encontraron inmuebles.', 'no_results_notice'],
    ['  SIN RESULTADOS! ', 'no_results_notice'],
    ['No autorizado', 'auth_notice'],
    ['Token expirado.', 'auth_notice'],
    ['Too many requests', 'rate_limit_notice'],
    ['<!DOCTYPE html><html>PRIVADO</html>', 'html_document'],
    ['  ', 'empty_text'],
    ['No hay inmuebles: propietario PRIVADO token TEST-ONLY', 'unknown_text'],
    ['Mensaje PRIVADO: TEST-ONLY', 'unknown_text'],
    ['x'.repeat(501), 'unknown_text'],
  ]) {
    let calls = 0;
    const result = await adapter.inspectPage({
      apiKey: 'TEST-ONLY', pageSize: 20,
      fetcher: async (url, options) => {
        calls += 1;
        assert.ok(url.includes('/limite/33/total/20/'));
        assert.equal(options.method, 'GET');
        assert.equal(options.redirect, 'manual');
        return json(text);
      },
    }, 33);
    assert.equal(calls, 1);
    assert.equal(result.classification, kind);
    assert.equal(result.diagnostic.code, 'SIMI_FORMAT');
    assert.equal(result.diagnostic.page, 33);
    assert.equal(result.diagnostic.text_length, text.length);
    assert.deepEqual(result.diagnostic.response_shape, { root: 'string' });
    assert.equal(JSON.stringify(result).includes('PRIVADO'), false);
    assert.equal(JSON.stringify(result).includes('TEST-ONLY'), false);
    assert.equal('properties' in result, false);
    assert.throws(() => adapter.parsePage(text, 33), error => error.code === 'SIMI_FORMAT',
      'clasificar un aviso no lo convierte en un catálogo vacío');
  }
});

test('un lote nunca confirma una página de texto aunque parezca un aviso de fin', async () => {
  let calls = 0;
  await assert.rejects(adapter.downloadBatch({
    apiKey: 'TEST', fetcher: async () => { calls += 1; return json('No se encontraron inmuebles.'); },
  }, { status: 'pending', next_page: 33, received: 628 }, async () => {
    assert.fail('un aviso no debe guardarse como página vacía ni publicar el catálogo');
  }), error => error.code === 'SIMI_FORMAT' && error.details.page === 33);
  assert.equal(calls, 1);
});

test('la inspección valida listas pero no expone inmuebles ni contactos', async () => {
  for (const rows of [[], [row('459-1', { propietario: 'PRIVADO' })]]) {
    const result = await adapter.inspectPage({
      apiKey: 'TEST', fetcher: async () => json({ data: rows }),
    }, 33);
    assert.equal(result.classification, rows.length ? 'valid_list' : 'empty_list');
    assert.equal(result.sample_count, rows.length);
    assert.deepEqual(result.diagnostic, { code: 'SIMI_OK', page: 33 });
    assert.equal(JSON.stringify(result).includes('459-1'), false);
    assert.equal(JSON.stringify(result).includes('PRIVADO'), false);
  }
  for (const rows of [[row(), row()], [row('123-1')]]) {
    await assert.rejects(adapter.inspectPage({ apiKey: 'TEST', fetcher: async () => json({ data: rows }) }, 33));
  }
});

test('la inspección conserva seguridad HTTPS, límites y errores de transporte sin reintentos', async () => {
  let calls = 0;
  for (const page of [0, 101, NaN, 1.5]) {
    await assert.rejects(adapter.inspectPage({
      apiKey: 'TEST', fetcher: async () => { calls += 1; },
    }, page), error => error.code === 'SIMI_CONFIG');
  }
  assert.equal(calls, 0);
  for (const [status, code] of [[401, 'SIMI_AUTH'], [429, 'SIMI_RATE_LIMIT']]) {
    await assert.rejects(adapter.inspectPage({
      apiKey: 'TEST', fetcher: async () => { calls += 1; return new Response('PRIVADO', { status }); },
    }, 33), error => error.code === code && !error.message.includes('PRIVADO'));
  }
  assert.equal(calls, 2);
  await assert.rejects(adapter.inspectPage({
    apiKey: 'TEST', fetcher: async () => new Response(null, { status: 302, headers: { location: 'https://evil.example/' } }),
  }, 33), error => error.code === 'SIMI_REDIRECT');
});

test('el resumen de texto también admite envoltorios sin copiar valores desconocidos', async () => {
  const result = await adapter.inspectPage({
    apiKey: 'TEST', fetcher: async () => json({ data: 'No hay inmuebles', propietario: 'PRIVADO' }),
  }, 33);
  assert.equal(result.classification, 'no_results_notice');
  assert.deepEqual(result.diagnostic.response_shape, { root: 'object', data: 'string' });
  assert.equal(JSON.stringify(result).includes('PRIVADO'), false);
  const filtered = adapter.safeDiagnostic(new adapter.SimiError('SIMI_FORMAT', 'PRIVADO', {
    text_kind: 'PRIVADO', text_length: -1, raw: 'PRIVADO',
  }));
  assert.deepEqual(filtered, { code: 'SIMI_FORMAT' });
});
