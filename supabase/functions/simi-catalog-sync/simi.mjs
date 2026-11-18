// Únicamente consultas GET a un origen fijo HTTPS. Nunca se envían cambios a SIMI.
const baseURL = 'https://simi-api.com/ApiSimiweb/response/v2.1.1/filtroInmueble/';

function plain(value, max = 160) {
  return String(value ?? '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

export function propertyFromSIMI(row, agency = '459') {
  const code = plain(row.Codigo_Inmueble || row.codinm, 50);
  if (!/^\d+-\d+$/.test(code) || code.split('-')[0] !== agency
    || (row.IdInmobiliaria != null && String(row.IdInmobiliaria) !== agency)) {
    throw new Error('SIMI devolvió un código de inmueble no válido para esta inmobiliaria.');
  }
  const operation = plain(row.Gestion).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const rental = /arriendo|arrendamiento/.test(operation);
  const sales = /venta/.test(operation);
  if (!rental && !sales) throw new Error('SIMI devolvió un inmueble sin gestión comercial reconocida.');
  const neighborhood = plain(row.Barrio);
  const city = plain(row.Ciudad);
  const type = plain(row.Tipo_Inmueble, 80) || 'Inmueble';
  return {
    code,
    title: plain([type, neighborhood, city].filter(Boolean).join(' · '), 240),
    neighborhood,
    city,
    // Solo dirección propia del inmueble, nunca direcciones de asesor, captador o propietario.
    address: plain(row.Direccion_Inmueble || row.direccion_inmueble || row.Direccion, 320),
    rental,
    sales,
    url: `https://felixtrujillofalla.com/inmuebles/${rental ? 'arriendo' : 'venta'}/detalle/${code}`,
  };
}

export function catalogURL(page, pageSize) {
  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    throw new Error('Paginación no válida.');
  }
  return `${baseURL}limite/${page}/total/${pageSize}/departamento/0/ciudad/0/zona/0/barrio/0/tipoInm/0/tipOper/0/areamin/0/areamax/0/valmin/0/valmax/0/campo/0/order/0/banios/0/alcobas/0/garajes/0/sede/0/usuario/0`;
}

export function parsePage(payload) {
  if (!payload || typeof payload !== 'object' || Number(payload.status) >= 400
    || Number(payload.code) >= 400 || payload.response === false || !Array.isArray(payload.data)) {
    throw new Error('SIMI no devolvió un listado válido. Revisa la clave y los permisos con soporte.');
  }
  const pageCount = payload.totalPagina == null || payload.totalPagina === '' ? NaN : Number(payload.totalPagina);
  const total = payload.totalInmuebles == null || payload.totalInmuebles === '' ? NaN : Number(payload.totalInmuebles);
  return {
    rows: payload.data,
    pageCount: Number.isInteger(pageCount) && pageCount > 0 ? pageCount : null,
    total: Number.isInteger(total) && total >= 0 ? total : null,
  };
}

async function readJSON(response) {
  if (!response.ok) throw new Error('No fue posible consultar SIMI. El catálogo anterior se conserva.');
  // Limitar también respuestas sin Content-Length; no exponer el cuerpo ni la clave en errores.
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > 5_000_000) throw new Error('La respuesta de SIMI supera el tamaño permitido.');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new Error('SIMI devolvió una respuesta que no es JSON. El catálogo anterior se conserva.'); }
}

export async function downloadCatalog({ apiKey, agency = '459', pageSize = 50, maxPages = 100, fetcher = fetch }) {
  if (!apiKey || /[\r\n]/.test(apiKey) || !/^\d+$/.test(agency)) throw new Error('Configura los secretos de SIMI en Supabase.');
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 200) throw new Error('Límite de páginas no válido.');
  // La documentación de SIMI usa Basic base64("Authorization:" + token).
  const authorization = `Basic ${btoa(`Authorization:${apiKey.trim()}`)}`;
  const properties = new Map();
  let expectedTotal = null;
  let expectedPages = null;
  for (let page = 1; page <= maxPages; page += 1) {
    let response;
    try {
      response = await fetcher(catalogURL(page, pageSize), {
        method: 'GET', headers: { Authorization: authorization, Accept: 'application/json' },
        redirect: 'error', signal: AbortSignal.timeout(15_000),
      });
    } catch { throw new Error('No fue posible conectar con SIMI por HTTPS. El catálogo anterior se conserva.'); }
    const result = parsePage(await readJSON(response));
    if (page === 1) {
      expectedTotal = result.total;
      expectedPages = result.pageCount;
      if (expectedPages && expectedPages > maxPages) throw new Error('El catálogo supera el límite de páginas configurado.');
    } else if ((result.total != null && expectedTotal != null && result.total !== expectedTotal)
      || (result.pageCount != null && expectedPages != null && result.pageCount !== expectedPages)) {
      throw new Error('El catálogo cambió durante la descarga. Reintenta más tarde.');
    }
    for (const row of result.rows) {
      const property = propertyFromSIMI(row, agency);
      if (properties.has(property.code)) throw new Error('La paginación de SIMI devolvió códigos repetidos. No se reemplazó el catálogo.');
      properties.set(property.code, property);
    }
    const finished = expectedPages ? page === expectedPages
      : expectedTotal != null ? properties.size >= expectedTotal : result.rows.length === 0;
    if (finished) {
      if (!properties.size || (expectedTotal != null && properties.size !== expectedTotal)) {
        throw new Error('SIMI devolvió un catálogo vacío o incompleto. El catálogo anterior se conserva.');
      }
      return [...properties.values()];
    }
    if (!result.rows.length) throw new Error('La descarga está incompleta. El catálogo anterior se conserva.');
  }
  throw new Error('Se alcanzó el límite de páginas sin completar el catálogo.');
}
