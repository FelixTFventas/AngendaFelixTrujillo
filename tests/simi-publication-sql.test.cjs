const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { PGlite } = require('@electric-sql/pglite');
const base = readFileSync(require.resolve('../supabase/add-simi-property-catalog.sql'), 'utf8');
const batch = readFileSync(require.resolve('../supabase/add-simi-batch-sync.sql'), 'utf8');
const migration = readFileSync(require.resolve('../supabase/add-simi-confirmed-publication.sql'), 'utf8');
const schema = readFileSync(require.resolve('../supabase/schema.sql'), 'utf8');
const adminId = '00000000-0000-0000-0000-000000000001';
const property = n => ({
  code: `459-${n}`, title: `Apartamento ${n}`, neighborhood: '', city: '', address: '',
  rental: true, sales: false, url: `https://felixtrujillofalla.com/inmuebles/arriendo/detalle/459-${n}`,
});
let db;

before(async () => {
  db = new PGlite();
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create function public.is_active_user() returns boolean language sql as $$ select true; $$;
    create table public.appointments (id integer primary key, property text);
    insert into public.appointments values (1, 'Dirección histórica');`);
  await db.exec(base);
  await db.exec(batch);
  await db.exec(migration);
});
beforeEach(async () => {
  await db.exec(`reset role;
    drop trigger if exists reject_publication on public.simi_property_catalog;
    delete from public.simi_catalog_staging;
    delete from public.simi_property_catalog;
    update public.simi_catalog_sync_state set job_id = null, job_status = 'idle', job_started_at = null,
      next_page = 1, staged_count = 0, expected_total = null, expected_pages = null,
      job_page_size = null, job_max_pages = null, job_agency = null, job_error_code = null,
      lock_token = null, locked_until = null, retry_after = null, last_attempt_at = null, last_synced_at = null,
      last_manual_confirmed_total = null, last_manual_confirmed_at = null, last_manual_confirmed_by = null
    where singleton;`);
  await db.query(`insert into public.simi_property_catalog (code, title, url, rental) values ($1, $2, $3, true)`,
    [property(90000).code, 'Catálogo anterior', property(90000).url]);
  await db.exec('set role service_role');
});
after(async () => { if (db) await db.close(); });
async function state() {
  return (await db.query('select public.simi_batch_progress() as p')).rows[0].p;
}
async function updateState(sql) {
  await db.exec(`reset role; update public.simi_catalog_sync_state set ${sql} where singleton; set role service_role`);
}
async function failed(total = 3, size = 2) {
  const job = (await db.query("select public.acquire_simi_sync_batch($1, '459', 100) as p", [size])).rows[0].p;
  for (let offset = 0, page = 1; offset < total; offset += size, page += 1) {
    const items = Array.from({ length: Math.min(size, total - offset) }, (_, n) => property(offset + n + 1));
    await db.query('select public.save_simi_sync_page($1, $2, $3, $4::jsonb)',
      [job.batch_token, job.job_id, page, JSON.stringify(items)]);
  }
  await db.query("select public.release_simi_sync_batch($1, 'SIMI_FORMAT')", [job.batch_token]);
  await updateState('retry_after = null');
  return state();
}
async function acquire(job, total = job.received, snapshot = job.snapshot_ref, page = job.next_page, agency = '459') {
  return (await db.query('select public.acquire_simi_confirmed_publication($1, $2, $3, $4) as p',
    [agency, total, snapshot, page])).rows[0].p;
}
async function finish(job, overrides = {}) {
  const args = { token: job.batch_token, job: job.job_id, total: job.received, items: job.last_page_items,
    kind: 'no_results_notice', admin: adminId, ...overrides };
  return (await db.query('select public.finish_simi_confirmed_publication($1, $2, $3, $4::jsonb, $5, $6) as p',
    [args.token, args.job, args.total, JSON.stringify(args.items), args.kind, args.admin])).rows[0].p;
}
async function active() {
  return (await db.query('select code from public.simi_property_catalog where active order by code')).rows.map(row => row.code);
}

test('el cierre validado coincide con el esquema y su migración no publica ni cambia el avance', async () => {
  assert.ok(schema.includes(migration.slice(migration.indexOf('alter table'), migration.lastIndexOf('commit;')).trim()));
  const sql = migration.replace(/--[^\n]*/g, '');
  for (const statement of sql.match(/\bdelete\s+from\b[^;]*;/gi)) assert.match(statement, /\bwhere\b/i);
  assert.doesNotMatch(sql, /\btruncate\b|\bsafeupdate\b/i);
  const job = await failed();
  await db.exec('reset role');
  await db.exec(migration);
  await db.exec(migration);
  assert.deepEqual(await state(), job);
  assert.deepEqual(await active(), ['459-90000']);
});

test('publica los 628 guardados en 32 páginas de forma atómica, audita y admite confirmación repetida', async () => {
  const job = await failed(628, 20);
  const reserved = await acquire(job);
  assert.equal(reserved.last_page_items.length, 8);
  assert.equal(reserved.next_page, 33);
  assert.deepEqual(await active(), ['459-90000']);
  const done = await finish(reserved);
  assert.equal(done.status, 'complete');
  assert.equal(done.total, 628);
  assert.equal(done.total_pages, 32);
  assert.equal((await active()).length, 628);
  assert.equal((await db.query('select count(*)::int as c from public.simi_catalog_staging')).rows[0].c, 0);
  await db.exec('reset role');
  const audit = (await db.query('select last_manual_confirmed_total as total, last_manual_confirmed_by as admin, last_manual_confirmed_at as at from public.simi_catalog_sync_state')).rows[0];
  assert.equal(audit.total, 628);
  assert.equal(audit.admin, adminId);
  assert.ok(audit.at);
  assert.equal((await db.query('select property from public.appointments where id = 1')).rows[0].property, 'Dirección histórica');
  await db.exec('set role service_role');
  assert.equal((await finish(reserved)).status, 'complete');
  assert.equal('batch_token' in await acquire(job), false);
});

test('el total no está fijado a 628 y admite una última página completa', async () => {
  const reserved = await acquire(await failed(4, 2));
  assert.equal(reserved.last_page_items.length, 2);
  assert.equal((await finish(reserved, { kind: 'empty_list' })).received, 4);
});

test('un total incorrecto o una confirmación de otra descarga no reserva ni publica', async () => {
  const job = await failed();
  for (const [total, snapshot, page, errorCode] of [
    [0, job.snapshot_ref, job.next_page, 'SIMI_PUBLICATION_CONFIRMATION'],
    [10001, job.snapshot_ref, job.next_page, 'SIMI_PUBLICATION_CONFIRMATION'],
    [2, job.snapshot_ref, job.next_page, 'SIMI_SNAPSHOT_CHANGED'],
    [3, '0'.repeat(32), job.next_page, 'SIMI_SNAPSHOT_CHANGED'],
    [3, job.snapshot_ref, job.next_page + 1, 'SIMI_SNAPSHOT_CHANGED'],
  ]) {
    await assert.rejects(acquire(job, total, snapshot, page), error => error.message === errorCode);
  }
  assert.deepEqual(await active(), ['459-90000']);
  assert.equal((await state()).received, 3);
});

test('no permite sobreescribir totales del proveedor ni validar trabajos antiguos, de otra agencia o con otros errores', async () => {
  const job = await failed();
  await assert.rejects(acquire(job, 3, job.snapshot_ref, job.next_page, '123'), error => error.message === 'SIMI_JOB_EXPIRED');
  for (const setting of ["expected_total = 4", "expected_pages = 3", "job_error_code = 'SIMI_DUPLICATE'", "job_status = 'pending'"]) {
    await updateState(setting);
    await assert.rejects(acquire(job), error => error.message === 'SIMI_PUBLICATION_UNAVAILABLE');
    await updateState("expected_total = null, expected_pages = null, job_error_code = 'SIMI_FORMAT', job_status = 'failed'");
  }
  await updateState("job_started_at = now() - interval '25 hours'");
  await assert.rejects(acquire(job), error => error.message === 'SIMI_JOB_EXPIRED');
  assert.deepEqual(await active(), ['459-90000']);
});

test('faltas de páginas, páginas intermedias cortas y contadores alterados bloquean el cierre', async () => {
  const job = await failed(7, 3);
  await db.query('update public.simi_catalog_staging set page_number = 3 where job_id = $1 and code = $2', [job.job_id, '459-1']);
  await assert.rejects(acquire(job), error => error.message === 'SIMI_INCOMPLETE');
  await db.query('update public.simi_catalog_staging set page_number = 1 where job_id = $1 and code = $2', [job.job_id, '459-1']);
  await db.query('update public.simi_catalog_staging set page_number = 4 where job_id = $1 and page_number = 2', [job.job_id]);
  await assert.rejects(acquire(job), error => error.message === 'SIMI_INCOMPLETE');
  assert.deepEqual(await active(), ['459-90000']);
});

test('no publica con última página distinta, avisos no aprobados, confirmación ausente o reserva inválida', async () => {
  const reserved = await acquire(await failed());
  for (const overrides of [
    { items: [{ ...reserved.last_page_items[0], title: 'Cambió' }] },
    { items: [] }, { items: [...reserved.last_page_items, ...reserved.last_page_items] },
    { kind: 'unknown_text' }, { kind: null }, { admin: null }, { token: null },
    { job: '00000000-0000-0000-0000-000000000099' },
  ]) await assert.rejects(finish(reserved, overrides));
  assert.deepEqual(await active(), ['459-90000']);
  assert.equal((await state()).status, 'failed');
  assert.equal((await db.query('select count(*)::int as c from public.simi_catalog_staging')).rows[0].c, 3);
});

test('el bloqueo impide carreras y una reserva caducada no puede publicar', async () => {
  const job = await failed();
  const first = await acquire(job);
  assert.equal((await acquire(job)).status, 'busy');
  assert.equal((await db.query('select public.reset_simi_sync_job() as p')).rows[0].p.status, 'busy');
  await updateState("locked_until = now() - interval '1 second', retry_after = now() - interval '1 second'");
  const second = await acquire(job);
  await assert.rejects(finish(first), error => error.message === 'SIMI_BATCH_EXPIRED');
  await updateState("job_started_at = now() - interval '25 hours'");
  await assert.rejects(finish(second), error => error.message === 'SIMI_JOB_EXPIRED');
  assert.deepEqual(await active(), ['459-90000']);
});

test('si falla una inserción se revierte toda la publicación, sin borrar staging ni el catálogo anterior', async () => {
  const reserved = await acquire(await failed());
  await db.exec(`reset role;
    create or replace function reject_simi_publication() returns trigger language plpgsql as $$
      begin if new.code = '459-2' then raise exception 'TEST_FAILURE'; end if; return new; end $$;
    create trigger reject_publication before insert on public.simi_property_catalog
      for each row execute function reject_simi_publication();
    set role service_role;`);
  await assert.rejects(finish(reserved), error => error.message === 'TEST_FAILURE');
  assert.deepEqual(await active(), ['459-90000']);
  assert.equal((await state()).status, 'failed');
  assert.equal((await db.query('select count(*)::int as c from public.simi_catalog_staging')).rows[0].c, 3);
});

test('anon y authenticated no pueden reservar ni publicar aunque conozcan la referencia de versión', async () => {
  const job = await failed();
  const reserved = await acquire(job);
  for (const role of ['anon', 'authenticated']) {
    await db.exec(`reset role; set role ${role}`);
    await assert.rejects(acquire(job), error => error.code === '42501');
    await assert.rejects(finish(reserved), error => error.code === '42501');
  }
});
