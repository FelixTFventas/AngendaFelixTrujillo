const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { PGlite } = require('@electric-sql/pglite');
const schema = readFileSync(require.resolve('../supabase/schema.sql'), 'utf8');
const migration = readFileSync(require.resolve('../supabase/add-simi-property-catalog.sql'), 'utf8');
const id = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const property = (n, flags = {}) => ({
  code: `459-${n}`, title: `Apartamento ${n} · Cándido Leguizamo`, neighborhood: 'Cándido Leguizamo',
  city: 'Neiva', address: '', rental: true, sales: false,
  url: `https://felixtrujillofalla.com/inmuebles/arriendo/detalle/459-${n}`, ...flags,
});
let db;

async function serviceLock() {
  await db.exec('reset role');
  await db.exec('update public.simi_catalog_sync_state set locked_until = null, last_attempt_at = null, last_synced_at = null');
  await db.exec('set role service_role');
  return (await db.query('select public.begin_simi_catalog_sync() as token')).rows[0].token;
}

async function apply(items, token) {
  return db.query('select public.apply_simi_catalog($1::jsonb, $2::uuid)', [JSON.stringify(items), token]);
}

async function signIn(n, role = 'authenticated') {
  await db.exec('reset role');
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [n ? id(n) : '']);
  await db.exec(`set role ${role}`);
}

async function search(query = 'candido', team = 'all', subject = 'Visita comercial') {
  return (await db.query('select public.search_simi_properties($1, $2, $3) as result', [query, team, subject])).rows[0].result;
}

before(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role bypassrls;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
    $$;
    create table public.profiles (id uuid primary key, active boolean, must_change_password boolean);
    insert into public.profiles values
      ('${id(1)}', true, false), ('${id(2)}', false, false), ('${id(3)}', true, true);
    create table public.appointments (id uuid primary key default gen_random_uuid(), subject text, property text);
    insert into public.appointments (id, subject, property) values ('${id(1)}', 'Visita comercial', 'Dirección anterior');
  `);
  await db.exec(schema.match(/create or replace function public\.is_active_user\(\)[\s\S]*?\$\$;/)[0]);
  await db.exec(migration);
  const token = await serviceLock();
  await apply([property(1), property(2, { rental: false, sales: true }), property(3, { sales: true })], token);
});

after(async () => { if (db) await db.close(); });

test('la migración coincide con el esquema y al repetirse no altera citas ni catálogo', async () => {
  const body = migration.slice(migration.indexOf('alter table'), migration.lastIndexOf('commit;')).trim();
  assert.ok(schema.includes(body));
  await db.exec('reset role');
  const beforeRows = (await db.query('select * from public.simi_property_catalog order by code')).rows;
  await db.exec(migration);
  assert.deepEqual((await db.query('select * from public.simi_property_catalog order by code')).rows, beforeRows);
  const appointment = (await db.query('select * from public.appointments')).rows[0];
  assert.equal(appointment.property, 'Dirección anterior');
  assert.equal(appointment.simi_property_code, null);
});

test('usuarios activos buscan por código, barrio sin acentos y equipo, sin leer tablas internas', async () => {
  await signIn(1);
  const all = await search();
  assert.equal(all.properties.length, 3);
  assert.ok(all.last_synced_at);
  assert.equal((await search('459-1')).properties[0].code, '459-1');
  assert.equal((await search('candido', 'rental')).properties.length, 2);
  assert.equal((await search('candido', 'sales')).properties.length, 2);
  await assert.rejects(db.query('select * from public.simi_property_catalog'), error => error.code === '42501');
  await assert.rejects(db.query('select * from public.simi_catalog_sync_state'), error => error.code === '42501');
});

test('anon, cuentas inactivas, contraseña temporal y asuntos no comerciales son rechazados', async () => {
  for (const n of [2, 3, 999, null]) {
    await signIn(n);
    await assert.rejects(search(), error => error.code === '42501');
  }
  await signIn(1, 'anon');
  await assert.rejects(search(), error => error.code === '42501');
  await signIn(1);
  await assert.rejects(search('Neiva', 'all', 'Recepción Propietario'), error => error.code === '42501');
  await assert.rejects(search('Neiva', 'all', null), error => error.code === '42501');
});

test('búsquedas cortas y equipos inválidos no producen consultas amplias', async () => {
  await signIn(1);
  await assert.rejects(search('a'), error => error.code === '22023');
  await assert.rejects(search('a'.repeat(121)), error => error.code === '22023');
  await assert.rejects(search('Neiva', 'otro'), error => error.code === '22023');
  assert.equal((await search("';--")).properties.length, 0);
});

test('usuarios normales no pueden adquirir bloqueos ni reemplazar el catálogo', async () => {
  await signIn(1);
  await assert.rejects(db.query('select public.begin_simi_catalog_sync()'), error => error.code === '42501');
  await assert.rejects(apply([property(8)], id(88)), error => error.code === '42501');
  await assert.rejects(db.query('select public.cancel_simi_catalog_sync($1)', [id(88)]), error => error.code === '42501');
});

test('bloqueo y enfriamiento evitan descargas simultáneas o demasiado frecuentes', async () => {
  const token = await serviceLock();
  assert.ok(token);
  assert.equal((await db.query('select public.begin_simi_catalog_sync() as token')).rows[0].token, null);
  await apply([property(1), property(2, { rental: false, sales: true }), property(3, { sales: true })], token);
  assert.equal((await db.query('select public.begin_simi_catalog_sync() as token')).rows[0].token, null);
});

test('catálogo vacío, duplicado o con datos inválidos no daña los inmuebles anteriores', async () => {
  const token = await serviceLock();
  const previous = (await db.query('select * from public.simi_property_catalog order by code')).rows;
  for (const items of [[], [property(1), property(1)], [property(9, { url: 'javascript:alert(1)' })]]) {
    await assert.rejects(apply(items, token));
    assert.deepEqual((await db.query('select * from public.simi_property_catalog order by code')).rows, previous);
  }
  await assert.rejects(apply([property(1)], id(999)), error => error.code === '42501');
  await db.query('select public.cancel_simi_catalog_sync($1)', [token]);
});

test('el reemplazo completo retira inmuebles solo del buscador y nunca cambia citas históricas', async () => {
  await db.exec('reset role');
  await db.query('update public.appointments set simi_property_code = $1, simi_property_url = $2 where id = $3',
    ['459-1', property(1).url, id(1)]);
  const token = await serviceLock();
  await apply([property(2, { rental: false, sales: true })], token);
  await signIn(1);
  assert.equal((await search('459-1')).properties.length, 0);
  await db.exec('reset role');
  const appointment = (await db.query('select * from public.appointments where id = $1', [id(1)])).rows[0];
  assert.equal(appointment.property, 'Dirección anterior');
  assert.equal(appointment.simi_property_code, '459-1');
  assert.equal(appointment.simi_property_url, property(1).url);
  assert.equal((await db.query("select active from public.simi_property_catalog where code = '459-1'")).rows[0].active, false);
});
