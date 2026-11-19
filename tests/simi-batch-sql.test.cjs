const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { PGlite } = require('@electric-sql/pglite');
const migration = readFileSync(require.resolve('../supabase/add-simi-batch-sync.sql'), 'utf8');
const base = readFileSync(require.resolve('../supabase/add-simi-property-catalog.sql'), 'utf8');
const schema = readFileSync(require.resolve('../supabase/schema.sql'), 'utf8');
const cleanupFix = readFileSync(require.resolve('../supabase/fix-simi-batch-staging-cleanup.sql'), 'utf8');
const property = n => ({
  code: `459-${n}`, title: `Apartamento ${n}`, neighborhood: 'Neiva', city: 'Neiva', address: '',
  rental: true, sales: false, url: `https://felixtrujillofalla.com/inmuebles/arriendo/detalle/459-${n}`,
});
let db;

before(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create function public.is_active_user() returns boolean language sql as $$ select true; $$;
    create table public.appointments (id integer primary key, property text);
    insert into public.appointments values (1, 'Dirección histórica');
  `);
  await db.exec(base);
  await db.exec(migration);
});
beforeEach(async () => {
  await db.exec(`
    reset role;
    delete from public.simi_catalog_staging;
    delete from public.simi_property_catalog;
    update public.simi_catalog_sync_state set lock_token = null, locked_until = null,
      last_attempt_at = null, last_synced_at = null, job_id = null, job_status = 'idle',
      job_started_at = null, next_page = 1, staged_count = 0, expected_total = null, expected_pages = null,
      job_page_size = null, job_max_pages = null, job_agency = null, job_error_code = null, retry_after = null;
  `);
  await db.query(`insert into public.simi_property_catalog (code, title, url, rental)
    values ($1, $2, $3, true)`, [property(100).code, 'Catálogo anterior', property(100).url]);
  await db.exec('set role service_role');
});
after(async () => { if (db) await db.close(); });

async function acquire(size = 20, agency = '459', max = 100) {
  return (await db.query('select public.acquire_simi_sync_batch($1, $2, $3) as p', [size, agency, max])).rows[0].p;
}
async function save(job, page, items, total = null, pages = null) {
  return (await db.query('select public.save_simi_sync_page($1, $2, $3, $4::jsonb, $5, $6) as p',
    [job.batch_token, job.job_id, page, JSON.stringify(items), total, pages])).rows[0].p;
}
async function release(job, code = null) {
  return (await db.query('select public.release_simi_sync_batch($1, $2) as p', [job.batch_token, code])).rows[0].p;
}
async function allowRetry() {
  await db.exec("reset role; update public.simi_catalog_sync_state set retry_after = now() - interval '1 second'; set role service_role");
}
async function published() {
  return (await db.query('select code from public.simi_property_catalog where active order by code')).rows.map(row => row.code);
}

test('el esquema y la migración coinciden; repetirla conserva una carga parcial', async () => {
  const body = migration.slice(migration.indexOf('alter table'), migration.lastIndexOf('commit;')).trim();
  assert.ok(schema.includes(body));
  const job = await acquire();
  await save(job, 1, [property(1)], 2, 2);
  await db.exec('reset role');
  await db.exec(migration);
  const state = (await db.query('select public.simi_batch_progress() as p')).rows[0].p;
  assert.equal(state.next_page, 2);
  assert.equal(state.received, 1);
  assert.equal((await db.query('select count(*)::int as c from public.simi_catalog_staging')).rows[0].c, 1);
  assert.deepEqual(await published(), ['459-100']);
});

test('la corrección coincide con el esquema y todas las eliminaciones de lotes tienen WHERE', () => {
  const definition = cleanupFix.slice(cleanupFix.indexOf('create or replace function'), cleanupFix.indexOf('\nrevoke all')).trim();
  assert.ok(migration.includes(definition));
  assert.ok(schema.includes(definition));
  for (const sql of [migration, cleanupFix]) {
    const withoutComments = sql.replace(/--[^\n]*/g, '');
    const deletes = withoutComments.match(/\bdelete\s+from\b[^;]*;/gi) || [];
    assert.ok(deletes.length > 0);
    for (const statement of deletes) assert.match(statement, /\bwhere\b/i);
    assert.doesNotMatch(withoutComments, /\btruncate\b|\bsafeupdate\b/i);
  }
});

test('el ajuste repara una instalación anterior y puede repetirse sin perder cursor ni permisos', async () => {
  const job = await acquire();
  await save(job, 1, [property(1)], 2, 2);
  await release(job);
  await db.exec('reset role');
  const oldDefinition = cleanupFix.slice(cleanupFix.indexOf('create or replace function'), cleanupFix.indexOf('\nrevoke all'))
    .replace('delete from public.simi_catalog_staging where job_id = state.job_id;', 'delete from public.simi_catalog_staging;');
  await db.exec(oldDefinition);
  const beforeFix = (await db.query('select public.simi_batch_progress() as p')).rows[0].p;
  await db.exec(cleanupFix);
  await db.exec(cleanupFix);
  const afterFix = (await db.query('select public.simi_batch_progress() as p')).rows[0].p;
  assert.deepEqual(afterFix, beforeFix);
  assert.deepEqual(await published(), ['459-100']);
  assert.equal((await db.query('select property from public.appointments where id = 1')).rows[0].property, 'Dirección histórica');
  for (const role of ['anon', 'authenticated']) {
    await db.exec(`reset role; set role ${role}`);
    await assert.rejects(acquire(), error => error.code === '42501');
  }
  await db.exec('reset role; set role service_role');
  const continued = await acquire();
  assert.equal(continued.job_id, job.job_id);
  assert.equal(continued.next_page, 2);
  assert.equal((await save(continued, 2, [property(2)], 2, 2)).status, 'complete');
});

test('una reserva nueva solo limpia restos del trabajo anterior y no el catálogo publicado', async () => {
  const previous = await acquire();
  await save(previous, 1, [property(1)], 2, 2);
  await release(previous);
  const unrelated = '00000000-0000-0000-0000-000000000999';
  await db.query(`insert into public.simi_catalog_staging (job_id, page_number, code, title, url, rental)
    values ($1, 1, $2, $3, $4, true)`, [unrelated, property(2).code, property(2).title, property(2).url]);
  await db.exec(`reset role;
    update public.simi_catalog_sync_state set job_status = 'complete', last_synced_at = now() - interval '1 hour' where singleton;
    set role service_role`);
  const next = await acquire();
  assert.notEqual(next.job_id, previous.job_id);
  assert.equal(next.next_page, 1);
  assert.equal(next.received, 0);
  const leftovers = (await db.query('select job_id from public.simi_catalog_staging')).rows;
  assert.deepEqual(leftovers, [{ job_id: unrelated }]);
  assert.deepEqual(await published(), ['459-100']);
});

test('cada página queda guardada y el catálogo cambia únicamente al completar la última', async () => {
  let job = await acquire(1);
  const first = await save(job, 1, [property(1)], 3, 3);
  assert.equal(first.next_page, 2);
  assert.equal(first.received, 1);
  assert.equal(first.status, 'pending');
  assert.deepEqual(await published(), ['459-100']);
  await release(job);
  job = await acquire(99);
  assert.equal(job.page_size, 1, 'se conservan los parámetros originales al reanudar');
  assert.equal(job.next_page, 2);
  await save(job, 2, [property(2)], 3, 3);
  assert.deepEqual(await published(), ['459-100']);
  const done = await save(job, 3, [property(3)], 3, 3);
  assert.equal(done.status, 'complete');
  assert.equal(done.received, 3);
  assert.deepEqual(await published(), ['459-1', '459-2', '459-3']);
  assert.equal((await db.query('select count(*)::int as c from public.simi_catalog_staging')).rows[0].c, 0);
  await db.exec('reset role');
  assert.equal((await db.query('select property from public.appointments where id = 1')).rows[0].property, 'Dirección histórica');
});

test('un fallo de red conserva el cursor; continuar no vuelve a descargar las páginas confirmadas', async () => {
  let job = await acquire();
  await save(job, 1, [property(1)], 2, 2);
  const paused = await release(job, 'SIMI_NETWORK');
  assert.equal(paused.status, 'pending');
  assert.equal(paused.next_page, 2);
  assert.equal((await acquire()).status, 'waiting');
  await allowRetry();
  job = await acquire();
  assert.equal(job.next_page, 2);
  assert.equal((await save(job, 2, [property(2)], 2, 2)).status, 'complete');
});

test('un bloqueo impide lotes concurrentes y al expirar invalida el token anterior', async () => {
  const first = await acquire();
  assert.equal((await acquire()).status, 'busy');
  await db.exec("reset role; update public.simi_catalog_sync_state set locked_until = now() - interval '1 second'; set role service_role");
  const second = await acquire();
  assert.notEqual(second.batch_token, first.batch_token);
  await assert.rejects(save(first, 1, [property(1)], 1, 1), error => error.code === '42501');
  assert.equal((await save(second, 1, [property(1)], 1, 1)).status, 'complete');
});

test('la confirmación repetida es idempotente y se rechazan saltos o duplicados entre páginas', async () => {
  const job = await acquire();
  await save(job, 1, [property(1)], 3, 3);
  const repeated = await save(job, 1, [property(99)], 3, 3);
  assert.equal(repeated.received, 1);
  await assert.rejects(save(job, 3, [property(3)], 3, 3), error => error.message === 'SIMI_PAGE_ORDER');
  await assert.rejects(save(job, 2, [property(1)], 3, 3), error => error.message === 'SIMI_DUPLICATE');
  assert.deepEqual(await published(), ['459-100']);
});

test('un cambio de totales exige reinicio y solo descarta la descarga parcial tras confirmarlo', async () => {
  const job = await acquire();
  await save(job, 1, [property(1)], 2, 2);
  await assert.rejects(save(job, 2, [property(2)], 3, 3), error => error.message === 'SIMI_CHANGED');
  const failed = await release(job, 'SIMI_CHANGED');
  assert.equal(failed.status, 'failed');
  assert.equal(failed.restart_required, true);
  await allowRetry();
  assert.equal((await acquire()).status, 'failed');
  const reset = (await db.query('select public.reset_simi_sync_job() as p')).rows[0].p;
  assert.equal(reset.status, 'idle');
  assert.deepEqual(await published(), ['459-100']);
  assert.equal((await db.query('select count(*)::int as c from public.simi_catalog_staging')).rows[0].c, 0);
  assert.notEqual((await acquire()).job_id, job.job_id);
});

test('un catálogo vacío o una descarga incompleta nunca retira inmuebles publicados', async () => {
  const job = await acquire();
  await assert.rejects(save(job, 1, [], 0, 0), error => error.message === 'SIMI_INCOMPLETE');
  await save(job, 1, [property(1)], 3, 3);
  await assert.rejects(save(job, 2, [], 3, 3), error => error.message === 'SIMI_INCOMPLETE');
  assert.deepEqual(await published(), ['459-100']);
});

test('sin metadatos, solo la página vacía terminal confirma que acabó la descarga', async () => {
  const job = await acquire();
  await save(job, 1, [property(1)]);
  assert.deepEqual(await published(), ['459-100']);
  assert.equal((await save(job, 2, [])).status, 'complete');
  assert.deepEqual(await published(), ['459-1']);
});

test('datos inválidos, otra agencia y límites excesivos se rechazan sin alterar el avance', async () => {
  const job = await acquire();
  await assert.rejects(save(job, 1, [property(1)], 1, 999), error => error.message === 'SIMI_PAGE_LIMIT');
  await assert.rejects(save(job, 1, [{ ...property(1), code: '123-1' }], 1, 1), error => error.message === 'SIMI_PROPERTY_CODE');
  await assert.rejects(save(job, 1, [{ ...property(1), url: 'javascript:alert(1)' }], 1, 1));
  const state = (await db.query('select public.simi_batch_progress() as p')).rows[0].p;
  assert.equal(state.next_page, 1);
  assert.equal(state.received, 0);
  assert.deepEqual(await published(), ['459-100']);
});

test('el trabajo caduca tras 24 horas y los clientes antiguos no pueden publicar por otra vía', async () => {
  const job = await acquire();
  await save(job, 1, [property(1)], 2, 2);
  await release(job);
  await db.exec("reset role; update public.simi_catalog_sync_state set job_started_at = now() - interval '25 hours'; set role service_role");
  assert.equal((await acquire()).status, 'failed');
  await assert.rejects(db.query('select public.begin_simi_catalog_sync()'), error => error.code === '42501');
  await assert.rejects(db.query("select public.apply_simi_catalog('[]'::jsonb, $1)", [job.batch_token]), error => error.code === '42501');
});

test('ni asesores ni usuarios anónimos pueden leer la descarga parcial o ejecutar sus funciones', async () => {
  for (const role of ['authenticated', 'anon']) {
    await db.exec(`reset role; set role ${role}`);
    await assert.rejects(db.query('select public.simi_batch_progress()'), error => error.code === '42501');
    await assert.rejects(acquire(), error => error.code === '42501');
    await assert.rejects(db.query('select public.reset_simi_sync_job()'), error => error.code === '42501');
    await assert.rejects(db.query('select * from public.simi_catalog_staging'), error => error.code === '42501');
  }
});

test('publica más de mil inmuebles sin truncarlos al límite del cliente REST', async () => {
  const job = await acquire(100);
  for (let page = 1; page <= 3; page += 1) {
    const items = Array.from({ length: 400 }, (_, n) => property((page - 1) * 400 + n + 1000));
    const result = await save(job, page, items, 1200, 3);
    assert.equal(result.status, page === 3 ? 'complete' : 'pending');
  }
  assert.equal((await published()).length, 1200);
});

test('la actualización programada espera seis horas, pero continúa un trabajo pendiente sin esa espera', async () => {
  let job = await acquire();
  await save(job, 1, [property(1)], 1, 1);
  await db.exec("reset role; update public.simi_catalog_sync_state set last_synced_at = now() - interval '2 hours'; set role service_role");
  let result = (await db.query("select public.acquire_simi_sync_batch(20, '459', 100, 21600) as p")).rows[0].p;
  assert.equal(result.status, 'complete');
  assert.equal('batch_token' in result, false);
  await db.exec("reset role; update public.simi_catalog_sync_state set last_synced_at = now() - interval '7 hours'; set role service_role");
  job = (await db.query("select public.acquire_simi_sync_batch(20, '459', 100, 21600) as p")).rows[0].p;
  assert.equal(job.status, 'pending');
  await save(job, 1, [property(2)], 2, 2);
  await release(job);
  result = (await db.query("select public.acquire_simi_sync_batch(20, '459', 100, 21600) as p")).rows[0].p;
  assert.equal(result.status, 'pending');
  assert.equal(result.next_page, 2);
  assert.equal(result.job_id, job.job_id);
});
