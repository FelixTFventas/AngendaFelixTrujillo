// Únicamente consultas GET a un origen fijo HTTPS. Nunca se envían cambios a SIMI.
const baseURL = 'https://simi-api.com/ApiSimiweb/response/v2.1.1/filtroInmueble/';

export class SimiError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'SimiError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new SimiError(code, message, details);
}

export function safeDiagnostic(error) {
  // Solo códigos, números y nombres controlados. Nunca incluir error.message/cause, URL, clave o respuesta.
  const diagnostic = { code: error instanceof SimiError ? error.code : 'SIMI_UNEXPECTED' };
  if (error instanceof SimiError) {
    for (const key of ['page', 'http_status', 'timeout_ms', 'elapsed_ms']) {
      const value = error.details[key];
      if (Number.isFinite(value)) diagnostic[key] = value;
    }
  }
  return diagnostic;
}

function plain(value, max = 160) {
  return String(value ?? '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

export function propertyFromSIMI(row, agency = '459') {
  const code = plain(row.Codigo_Inmueble || row.codinm, 50);
  if (!/^\d+-\d+$/.test(code) || code.split('-')[0] !== agency
    || (row.IdInmobiliaria != null && String(row.IdInmobiliaria) !== agency)) {
    fail('SIMI_PROPERTY_CODE', 'SIMI devolvió un código de inmueble no válido para esta inmobiliaria.');
  }
  const operation = plain(row.Gestion).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const rental = /arriendo|arrendamiento/.test(operation);
  const sales = /venta/.test(operation);
  if (!rental && !sales) fail('SIMI_PROPERTY_OPERATION', 'SIMI devolvió un inmueble sin gestión comercial reconocida.');
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
    fail('SIMI_CONFIG', 'La paginación configurada no es válida.');
  }
  return `${baseURL}limite/${page}/total/${pageSize}/departamento/0/ciudad/0/zona/0/barrio/0/tipoInm/0/tipOper/0/areamin/0/areamax/0/valmin/0/valmax/0/campo/0/order/0/banios/0/alcobas/0/garajes/0/sede/0/usuario/0`;
}

export function parsePage(payload) {
  const statuses = [Number(payload?.status), Number(payload?.code)];
  if (statuses.some(status => status === 401 || status === 403)) {
    fail('SIMI_AUTH', 'SIMI rechazó la autenticación o los permisos. Confirma con soporte el formato de la clave; no la compartas.');
  }
  if (statuses.includes(429)) fail('SIMI_RATE_LIMIT', 'SIMI indicó que se alcanzó el límite de consultas. Espera y confirma la cuota con soporte.');
  if (!payload || typeof payload !== 'object' || Number(payload.status) >= 400
    || Number(payload.code) >= 400 || payload.response === false || !Array.isArray(payload.data)) {
    fail('SIMI_FORMAT', 'SIMI no devolvió un listado válido. El catálogo anterior se conserva.');
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
  if (response.status === 401 || response.status === 403) {
    fail('SIMI_AUTH', 'SIMI rechazó la autenticación o los permisos. Confirma con soporte el formato de la clave; no la compartas.', { http_status: response.status });
  }
  if (response.status === 429) {
    fail('SIMI_RATE_LIMIT', 'SIMI indicó que se alcanzó el límite de consultas. Espera y confirma la cuota con soporte.', { http_status: 429 });
  }
  if (!response.ok) fail('SIMI_HTTP', 'SIMI devolvió un error HTTP. El catálogo anterior se conserva.', { http_status: response.status });
  if (!response.body) fail('SIMI_FORMAT', 'SIMI devolvió una respuesta vacía.');
  // Limitar también respuestas sin Content-Length; no exponer el cuerpo ni la clave en errores.
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > 5_000_000) fail('SIMI_RESPONSE_SIZE', 'La respuesta de SIMI supera el tamaño permitido.');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { fail('SIMI_FORMAT', 'SIMI devolvió una respuesta que no es JSON. El catálogo anterior se conserva.'); }
}

export function safeRedirect(location, from) {
  let target;
  try { target = new URL(location, from); }
  catch { fail('SIMI_REDIRECT', 'SIMI devolvió una redirección no válida. No se enviaron credenciales a otro sitio.'); }
  const original = new URL(from);
  if (!location || target.protocol !== 'https:' || !['simi-api.com', 'www.simi-api.com'].includes(target.hostname)
    || target.port || target.username || target.password || target.search || target.hash
    || target.pathname.replace(/\/$/, '') !== original.pathname.replace(/\/$/, '')) {
    fail('SIMI_REDIRECT', 'SIMI redirigió a una dirección no autorizada. No se siguió la redirección ni se envió la clave a ese destino.');
  }
  return target.href;
}

function classifyConnectionError(error, signal, context) {
  if (error instanceof SimiError) {
    Object.assign(error.details, context);
    return error;
  }
  const hint = [error?.name, error?.message, error?.cause?.code, error?.cause?.message].join(' ').toLowerCase();
  // Se inspecciona el error para clasificarlo, pero no se expone ni se registra su contenido.
  if (signal?.aborted || /abort|timeout|timed out/.test(hint)) {
    return new SimiError(context.budget_limited ? 'SIMI_SYNC_TIMEOUT' : 'SIMI_TIMEOUT',
      context.budget_limited
        ? 'La descarga completa alcanzó el tiempo máximo permitido. El catálogo anterior se conserva.'
        : 'SIMI tardó más del tiempo de espera permitido en responder. El catálogo anterior se conserva.',
      context);
  }
  if (/certificate|cert_|tls|ssl|unknown.?issuer/.test(hint)) {
    return new SimiError('SIMI_TLS', 'No se pudo validar la conexión TLS de SIMI desde Supabase. Consulta a soporte de SIMI; no se desactiva la seguridad HTTPS.', context);
  }
  if (/dns|enotfound|eai_again|resolve|name or service|lookup address/.test(hint)) {
    return new SimiError('SIMI_DNS', 'Supabase no pudo resolver el dominio de SIMI. Revisa con soporte la conexión desde servicios externos.', context);
  }
  return new SimiError('SIMI_NETWORK', 'No se pudo completar la conexión de red entre Supabase y SIMI. Confirma con soporte si existen restricciones por IP o centro de datos.', context);
}

function connectionOptions({ apiKey, agency = '459', pageSize = 20, maxPages = 100,
  requestTimeoutMs = 45_000, totalTimeoutMs = 100_000, fetcher = fetch, clock = Date.now }) {
  if (!apiKey || !/^[\x21-\x7e]+$/.test(apiKey.trim()) || /[\r\n]/.test(apiKey) || !/^\d+$/.test(agency)) {
    fail('SIMI_CONFIG', 'Configura los secretos de SIMI en Supabase con el token original, sin prefijos ni saltos de línea.');
  }
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 200
    || !Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1000 || requestTimeoutMs > 60_000
    || !Number.isInteger(totalTimeoutMs) || totalTimeoutMs < 1000 || totalTimeoutMs > 120_000) {
    fail('SIMI_CONFIG', 'Los límites de páginas o tiempo de espera configurados no son válidos.');
  }
  catalogURL(1, pageSize);
  // La documentación de SIMI usa Basic base64("Authorization:" + token).
  const authorization = `Basic ${btoa(`Authorization:${apiKey.trim()}`)}`;
  return { agency, pageSize, maxPages, requestTimeoutMs, totalTimeoutMs, fetcher, clock, authorization };
}

async function getPage(page, options, startedAt) {
  const remaining = options.totalTimeoutMs - (options.clock() - startedAt);
  if (remaining <= 0) fail('SIMI_SYNC_TIMEOUT', 'La descarga completa alcanzó el tiempo máximo permitido. El catálogo anterior se conserva.', { page });
  const timeout = Math.min(options.requestTimeoutMs, remaining);
  const signal = AbortSignal.timeout(timeout);
  const context = { page, timeout_ms: timeout, budget_limited: remaining < options.requestTimeoutMs };
  const pageStarted = options.clock();
  let url = catalogURL(page, options.pageSize);
  try {
    for (let redirects = 0; redirects <= 2; redirects += 1) {
      const response = await options.fetcher(url, {
        method: 'GET', headers: { Authorization: options.authorization, Accept: 'application/json' },
        redirect: 'manual', signal,
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel().catch(() => {});
        if (redirects === 2) fail('SIMI_REDIRECT', 'SIMI devolvió demasiadas redirecciones. El catálogo anterior se conserva.');
        url = safeRedirect(response.headers.get('location'), url);
        continue;
      }
      return parsePage(await readJSON(response));
    }
  } catch (error) {
    throw classifyConnectionError(error, signal, { ...context, elapsed_ms: Math.max(0, options.clock() - pageStarted) });
  }
}

export async function probeConnection(settings) {
  const options = connectionOptions({ ...settings, pageSize: 1 });
  const startedAt = options.clock();
  const result = await getPage(1, options, startedAt);
  // No se guardan registros ni se devuelven datos del inmueble o contactos.
  return { ok: true, code: 'SIMI_OK', sample_count: result.rows.length,
    elapsed_ms: Math.max(0, options.clock() - startedAt) };
}

export async function downloadCatalog(settings) {
  const options = connectionOptions(settings);
  const { agency, pageSize, maxPages } = options;
  const startedAt = options.clock();
  const properties = new Map();
  let expectedTotal = null;
  let expectedPages = null;
  for (let page = 1; page <= maxPages; page += 1) {
    const result = await getPage(page, options, startedAt);
    if (page === 1) {
      expectedTotal = result.total;
      expectedPages = result.pageCount;
      if (expectedPages && expectedPages > maxPages) fail('SIMI_PAGE_LIMIT', 'El catálogo supera el límite de páginas configurado.');
    } else if ((result.total != null && expectedTotal != null && result.total !== expectedTotal)
      || (result.pageCount != null && expectedPages != null && result.pageCount !== expectedPages)) {
      fail('SIMI_CHANGED', 'El catálogo cambió durante la descarga. Reintenta más tarde.');
    }
    for (const row of result.rows) {
      const property = propertyFromSIMI(row, agency);
      if (properties.has(property.code)) fail('SIMI_DUPLICATE', 'La paginación de SIMI devolvió códigos repetidos. No se reemplazó el catálogo.');
      properties.set(property.code, property);
    }
    const finished = expectedPages ? page === expectedPages
      : expectedTotal != null ? properties.size >= expectedTotal : result.rows.length === 0;
    if (finished) {
      if (!properties.size || (expectedTotal != null && properties.size !== expectedTotal)) {
        fail('SIMI_INCOMPLETE', 'SIMI devolvió un catálogo vacío o incompleto. El catálogo anterior se conserva.');
      }
      return [...properties.values()];
    }
    if (!result.rows.length) fail('SIMI_INCOMPLETE', 'La descarga está incompleta. El catálogo anterior se conserva.');
  }
  fail('SIMI_PAGE_LIMIT', 'Se alcanzó el límite de páginas sin completar el catálogo.');
}
