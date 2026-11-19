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

const listKeys = ['data', 'Inmuebles', 'inmuebles'];
const totalKeys = ['totalInmuebles', 'total_inmuebles'];
const pagesKeys = ['totalPagina', 'totalPaginas', 'totalPages', 'total_pages'];
const currentKeys = ['pagina_actual', 'current_page'];
const paginationKeys = [...totalKeys, ...pagesKeys, ...currentKeys, 'inicio', 'fin'];
const metadataKeys = [...paginationKeys, 'status', 'code', 'response', 'success', 'error'];
const shapePaths = [
  'data', 'Inmuebles', 'inmuebles', 'response', 'status', 'code', 'success', 'error',
  'message', 'description', 'pagination', 'paginacion', 'meta', ...paginationKeys,
  'data.data', 'data.Inmuebles', 'data.inmuebles', 'response.data',
  'response.Inmuebles', 'response.inmuebles',
];
const shapeTypes = ['missing', 'null', 'array', 'object', 'string', 'number', 'boolean'];
const textKinds = ['empty_text', 'no_results_notice', 'auth_notice', 'rate_limit_notice', 'html_document', 'unknown_text'];

function classifyText(value) {
  // Solo clasifica frases completas predefinidas. Nunca devuelve el texto original.
  // Incluso un aviso de "sin resultados" NO se acepta como fin de catálogo.
  if (value.length > 500) return 'unknown_text';
  const text = value.trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ');
  if (!text) return 'empty_text';
  if (/^(?:no se encontraron inmuebles|no se encontro ningun inmueble|no hay inmuebles|no existen inmuebles|sin inmuebles|no se encontraron resultados|sin resultados|no results found|no properties found)[.!]?$/.test(text)) return 'no_results_notice';
  if (/^(?:no autorizado|acceso denegado|token invalido|token expirado|unauthorized|forbidden)[.!]?$/.test(text)) return 'auth_notice';
  if (/^(?:demasiadas solicitudes|limite de consultas excedido|too many requests|rate limit exceeded)[.!]?$/.test(text)) return 'rate_limit_notice';
  if (/^(?:<!doctype html\b|<html\b)/.test(text)) return 'html_document';
  return 'unknown_text';
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function own(value, key) {
  return isObject(value) && Object.hasOwn(value, key);
}

function shapeType(value) {
  return value === undefined ? 'missing' : value === null ? 'null'
    : Array.isArray(value) ? 'array' : typeof value;
}

function safeShape(payload) {
  const shape = { root: shapeType(payload) };
  for (const path of shapePaths) {
    const value = path.split('.').reduce((node, key) => own(node, key) ? node[key] : undefined, payload);
    if (value !== undefined) shape[path] = shapeType(value);
  }
  // Solo nombres predefinidos y tipos; ni siquiera se exponen nombres de campos desconocidos.
  return shape;
}

function formatFailure(payload, reason = 'SIMI no devolvió un listado reconocible.', code = 'SIMI_FORMAT', textValue = payload) {
  const responseShape = safeShape(payload);
  const description = Object.entries(responseShape).map(([key, type]) => `${key === 'root' ? 'raíz' : key}=${type}`).join(', ');
  const text = typeof textValue === 'string'
    ? { text_kind: classifyText(textValue), text_length: textValue.length } : {};
  fail(code, `${reason} Estructura: ${description}. El catálogo anterior se conserva.`,
    { response_shape: responseShape, ...text, direct_text: typeof payload === 'string' && payload === textValue });
}

export function safeDiagnostic(error) {
  // Solo códigos, números y nombres controlados. Nunca incluir error.message/cause, URL, clave o respuesta.
  const diagnostic = { code: error instanceof SimiError ? error.code : 'SIMI_UNEXPECTED' };
  if (error instanceof SimiError) {
    for (const key of ['page', 'http_status', 'timeout_ms', 'elapsed_ms']) {
      const value = error.details[key];
      if (Number.isFinite(value)) diagnostic[key] = value;
    }
    if (isObject(error.details.response_shape)) {
      const shape = {};
      for (const path of ['root', ...shapePaths]) {
        const type = error.details.response_shape[path];
        if (shapeTypes.includes(type)) shape[path] = type;
      }
      diagnostic.response_shape = shape;
    }
    if (textKinds.includes(error.details.text_kind)) diagnostic.text_kind = error.details.text_kind;
    if (Number.isSafeInteger(error.details.text_length) && error.details.text_length >= 0
      && error.details.text_length <= 5_000_000) diagnostic.text_length = error.details.text_length;
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

function checkStatus(node, original) {
  if (!isObject(node)) return;
  const statuses = [Number(node.status), Number(node.code)];
  const statusText = typeof node.status === 'string' ? node.status.trim().toLowerCase() : '';
  if (statuses.some(status => status === 401 || status === 403) || ['unauthorized', 'forbidden'].includes(statusText)) {
    fail('SIMI_AUTH', 'SIMI rechazó la autenticación o los permisos. Confirma con soporte el formato de la clave; no la compartas.');
  }
  if (statuses.includes(429)) fail('SIMI_RATE_LIMIT', 'SIMI indicó que se alcanzó el límite de consultas. Espera y confirma la cuota con soporte.');
  const falseFlag = value => value === false || value === 0
    || (typeof value === 'string' && ['false', '0', 'error', 'failed', 'failure'].includes(value.trim().toLowerCase()));
  const negativeStatus = ['error', 'failed', 'failure', 'false'].includes(statusText);
  if (statuses.some(status => status >= 400) || negativeStatus
    || (own(node, 'response') && falseFlag(node.response))
    || (own(node, 'success') && falseFlag(node.success))
    || node.status === false || (own(node, 'error') && Boolean(node.error))) {
    formatFailure(original, 'SIMI indicó una respuesta de error, no un listado de inmuebles.', 'SIMI_REJECTED');
  }
}

function propertyRecord(value) {
  return isObject(value) && /^\d+-\d+$/.test(String(value.Codigo_Inmueble || value.codinm || ''));
}

export function parsePage(payload, requestedPage = null) {
  const original = payload;
  const paging = [];
  let decodings = 0;
  function decode(value) {
    if (typeof value !== 'string') return value;
    if (decodings >= 2 || !/^[\s]*[[{]/.test(value)) formatFailure(original, 'SIMI devolvió texto en lugar de una colección.', 'SIMI_FORMAT', value);
    decodings += 1;
    try { return JSON.parse(value); }
    catch { formatFailure(original, 'SIMI devolvió una colección codificada no válida.'); }
  }
  function remember(node) {
    if (!isObject(node)) return;
    checkStatus(node, original);
    paging.push(node);
    for (const key of ['pagination', 'paginacion', 'meta']) {
      if (own(node, key) && isObject(node[key])) paging.push(node[key]);
    }
  }
  function metadataEntry(node) {
    return isObject(node) && Object.keys(node).every(key => metadataKeys.includes(key))
      && paginationKeys.some(key => own(node, key));
  }
  function collection(node, depth = 0) {
    if (depth > 3) formatFailure(original, 'SIMI devolvió demasiados envoltorios de datos.');
    node = decode(node);
    if (Array.isArray(node)) {
      // Algunos serializadores envuelven la respuesta completa en un array de un elemento.
      if (node.length === 1 && isObject(node[0]) && !propertyRecord(node[0])
        && (listKeys.some(key => own(node[0], key)) || isObject(node[0].response))) {
        return collection(node[0], depth + 1);
      }
      const rows = [];
      for (const item of node) {
        if (propertyRecord(item)) rows.push(item);
        else if (metadataEntry(item)) remember(item);
        else {
          checkStatus(item, original);
          formatFailure(original, 'La colección contiene elementos que no son inmuebles reconocibles.');
        }
      }
      return rows;
    }
    if (!isObject(node)) formatFailure(original);
    remember(node);
    const containers = listKeys.filter(key => own(node, key) && node[key] != null);
    if (containers.length > 1) formatFailure(original, 'SIMI devolvió más de una colección posible.');
    if (containers.length === 1) return collection(node[containers[0]], depth + 1);
    if (own(node, 'response') && (isObject(node.response) || Array.isArray(node.response))) {
      return collection(node.response, depth + 1);
    }
    // Un array PHP con índices no consecutivos puede serializarse como objeto.
    const entries = Object.entries(node).filter(([key]) => !metadataKeys.includes(key)
      && !['pagination', 'paginacion', 'meta'].includes(key));
    if (entries.length && entries.every(([key, item]) => propertyRecord(item)
      && (/^\d+$/.test(key) || key === String(item.Codigo_Inmueble || item.codinm)))) {
      return entries.map(([, item]) => item);
    }
    // Un acuse {code:0,response:true}, un detalle individual o {} nunca son un catálogo vacío.
    if (node.response === true && own(node, 'code')) {
      formatFailure(original, 'SIMI confirmó la solicitud, pero no incluyó una colección de inmuebles.');
    }
    formatFailure(original);
  }
  const rows = collection(payload);
  function count(keys, allowZero = true) {
    let result = null;
    for (const node of paging) {
      for (const key of keys) {
        if (!own(node, key) || node[key] == null || node[key] === '') continue;
        const raw = node[key];
        if ((typeof raw !== 'number' && (typeof raw !== 'string' || !/^\d+$/.test(raw.trim())))
          || !Number.isSafeInteger(Number(raw)) || Number(raw) < (allowZero ? 0 : 1)) {
          formatFailure(original, 'SIMI devolvió metadatos de paginación no válidos.');
        }
        const number = Number(raw);
        if (result !== null && result !== number) formatFailure(original, 'Los metadatos de paginación son contradictorios.');
        result = number;
      }
    }
    return result;
  }
  const total = count(totalKeys);
  const pageCount = count(pagesKeys);
  const current = count(currentKeys, false);
  if ((requestedPage != null && current != null && current !== requestedPage)
    || (total === 0 && rows.length > 0) || (pageCount === 0 && rows.length > 0)) {
    formatFailure(original, 'SIMI devolvió una página o un total que no corresponde a los datos.');
  }
  return {
    rows,
    pageCount: pageCount > 0 ? pageCount : null,
    total,
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
        ? 'La ejecución alcanzó el tiempo máximo permitido. Las páginas ya confirmadas y el catálogo anterior se conservan.'
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
  if (remaining <= 0) fail('SIMI_SYNC_TIMEOUT', 'La ejecución alcanzó el tiempo máximo permitido. Las páginas ya confirmadas y el catálogo anterior se conservan.', { page });
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
      return parsePage(await readJSON(response), page);
    }
  } catch (error) {
    throw classifyConnectionError(error, signal, { ...context, elapsed_ms: Math.max(0, options.clock() - pageStarted) });
  }
}

export async function probeConnection(settings) {
  const options = connectionOptions({ ...settings, pageSize: 1 });
  const startedAt = options.clock();
  const result = await getPage(1, options, startedAt);
  for (const row of result.rows) propertyFromSIMI(row, options.agency);
  // No se guardan registros ni se devuelven datos del inmueble o contactos.
  return { ok: true, code: 'SIMI_OK', sample_count: result.rows.length,
    elapsed_ms: Math.max(0, options.clock() - startedAt) };
}

export async function inspectPage(settings, page) {
  const options = connectionOptions(settings);
  if (!Number.isInteger(page) || page < 1 || page > options.maxPages) {
    fail('SIMI_CONFIG', 'La página guardada no es válida para el diagnóstico.');
  }
  try {
    const result = await getPage(page, options, options.clock());
    const seen = new Set();
    for (const row of result.rows) {
      const property = propertyFromSIMI(row, options.agency);
      if (seen.has(property.code)) fail('SIMI_DUPLICATE', 'La página de diagnóstico contiene códigos repetidos.', { page });
      seen.add(property.code);
    }
    // No se devuelven ni guardan inmuebles; tampoco se certifica un final de catálogo.
    return { classification: result.rows.length ? 'valid_list' : 'empty_list',
      diagnostic: { code: 'SIMI_OK', page }, sample_count: result.rows.length };
  } catch (error) {
    if (!(error instanceof SimiError) || error.code !== 'SIMI_FORMAT') throw error;
    const diagnostic = safeDiagnostic(error);
    return { classification: diagnostic.text_kind || 'unrecognized_format', diagnostic };
  }
}

export async function validateCatalogEnd(settings, progress, confirmedTotal) {
  const options = connectionOptions(settings);
  const nextPage = progress?.next_page;
  const saved = progress?.last_page_items;
  if (!Number.isInteger(confirmedTotal) || confirmedTotal < 1 || confirmedTotal > 10000
    || confirmedTotal !== progress?.received || !Number.isInteger(nextPage) || nextPage < 2 || nextPage > options.maxPages
    || !Array.isArray(saved) || !saved.length || saved.length > options.pageSize) {
    fail('SIMI_PUBLICATION_CONFIRMATION', 'El total confirmado o la última página guardada no son válidos.');
  }
  const startedAt = options.clock();
  const lastPage = nextPage - 1;
  const latest = await getPage(lastPage, options, startedAt);
  if ((latest.total != null && latest.total !== confirmedTotal)
    || (latest.pageCount != null && latest.pageCount !== lastPage)) {
    fail('SIMI_CHANGED', 'SIMI informó totales distintos durante la validación. Se conserva la carga sin publicar.', { page: lastPage });
  }
  const properties = latest.rows.map(row => propertyFromSIMI(row, options.agency));
  const byCode = new Map(saved.map(item => [item.code, item]));
  const seen = new Set();
  const fields = ['code', 'title', 'neighborhood', 'city', 'address', 'rental', 'sales', 'url'];
  if (properties.length !== saved.length || byCode.size !== saved.length || properties.some(item => {
    const previous = byCode.get(item.code);
    if (seen.has(item.code) || !previous || fields.some(key => previous[key] !== item[key])) return true;
    seen.add(item.code);
    return false;
  })) {
    fail('SIMI_CHANGED', 'La última página cambió desde la descarga. El catálogo anterior y la carga guardada se conservan.', { page: lastPage });
  }
  let terminalKind;
  try {
    const terminal = await getPage(nextPage, options, startedAt);
    if (terminal.rows.length || (terminal.total != null && terminal.total !== confirmedTotal)
      || (terminal.pageCount != null && terminal.pageCount !== lastPage)) {
      fail('SIMI_INCOMPLETE', 'SIMI todavía devuelve inmuebles o totales distintos después de la última página guardada.', { page: nextPage });
    }
    terminalKind = 'empty_list';
  } catch (error) {
    // Excepción explícita SOLO para este cierre manual con total confirmado.
    // El importador normal sigue rechazando todo texto; no se aceptan avisos anidados.
    if (!(error instanceof SimiError) || error.code !== 'SIMI_FORMAT'
      || error.details.text_kind !== 'no_results_notice' || error.details.direct_text !== true) throw error;
    terminalKind = 'no_results_notice';
  }
  return { last_page_items: properties, terminal_kind: terminalKind };
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

// Cada página se confirma en Supabase antes de pedir la siguiente.
// El cursor y la publicación final son autoritativos en la base de datos, no en el navegador.
export async function downloadBatch(settings, progress, persistPage) {
  const options = connectionOptions(settings);
  const batchPages = settings.batchPages ?? 5;
  const batchTimeoutMs = settings.batchTimeoutMs ?? 60000;
  if (!Number.isInteger(batchPages) || batchPages < 1 || batchPages > 10
    || !Number.isInteger(batchTimeoutMs) || batchTimeoutMs < 1000 || batchTimeoutMs > 80000
    || !Number.isInteger(progress?.next_page) || progress.next_page < 1
    || !Number.isInteger(progress?.received) || progress.received < 0 || progress.received > 10000) {
    fail('SIMI_CONFIG', 'El lote o su cursor no son válidos.');
  }
  options.totalTimeoutMs = Math.min(options.totalTimeoutMs, batchTimeoutMs);
  const startedAt = options.clock();
  let saved = { ...progress };
  for (let index = 0; index < batchPages; index += 1) {
    if (saved.status === 'complete') return saved;
    // No iniciar otra página si no queda margen para su tiempo de espera.
    if (index > 0 && options.totalTimeoutMs - (options.clock() - startedAt) < options.requestTimeoutMs) return saved;
    const page = saved.next_page;
    if (page > options.maxPages) fail('SIMI_PAGE_LIMIT', 'Se alcanzó el límite de páginas del trabajo.');
    const result = await getPage(page, options, startedAt);
    if ((saved.total != null && result.total != null && saved.total !== result.total)
      || (saved.total_pages != null && result.pageCount != null && saved.total_pages !== result.pageCount)) {
      fail('SIMI_CHANGED', 'El catálogo cambió durante la descarga. Debe reiniciarse la carga parcial.', { page });
    }
    if ((result.pageCount != null && result.pageCount > options.maxPages)
      || (result.total != null && result.total > 10000)) {
      fail('SIMI_PAGE_LIMIT', 'El catálogo supera los límites configurados.', { page });
    }
    const seen = new Set();
    const properties = result.rows.map(row => {
      const property = propertyFromSIMI(row, options.agency);
      if (seen.has(property.code)) fail('SIMI_DUPLICATE', 'SIMI repitió un código en la misma página.', { page });
      seen.add(property.code);
      return property;
    });
    saved = await persistPage({
      page, properties, total: result.total, pages: result.pageCount,
    });
    if (!saved || !['pending', 'complete'].includes(saved.status)
      || saved.next_page !== page + 1 || !Number.isInteger(saved.received)) {
      fail('SIMI_SAVE', 'No se pudo confirmar el avance de la página. Reanuda para consultar el estado guardado.', { page });
    }
  }
  return saved;
}
