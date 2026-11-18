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

test('descarga paginada con GET fijo HTTPS, sin redirecciones y autorización Basic documentada', async () => {
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
    assert.equal(options.redirect, 'error');
    assert.equal(atob(options.headers.Authorization.slice(6)), 'Authorization:TOKEN-DE-PRUEBA');
    assert.equal(url.includes('TOKEN-DE-PRUEBA'), false);
  }
});

test('rechaza respuestas de autenticación incluso si SIMI devuelve HTTP 200', async () => {
  await assert.rejects(adapter.downloadCatalog({
    apiKey: 'TEST', fetcher: async () => json({ status: 401, description: 'No autorizado' }),
  }), /listado válido/);
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
