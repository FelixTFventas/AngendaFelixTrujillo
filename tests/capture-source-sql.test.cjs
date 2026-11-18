const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { PGlite } = require('@electric-sql/pglite');

const schema = readFileSync(require.resolve('../supabase/schema.sql'), 'utf8');
const initialMigration = readFileSync(require.resolve('../supabase/add-appointment-capture-source.sql'), 'utf8');
const migration = readFileSync(require.resolve('../supabase/require-capture-source-for-commercial-visits.sql'), 'utf8');
const sources = ['WhatsApp', 'Fijo', 'Finca Raíz', 'Proppit', 'Ciencuadras', 'Facebook', 'Instagram'];
const otherSubjects = ['Recepción Propietario', 'Previsita de inventario', 'Previsita de devolución',
  'Devolución por el arrendatario', 'Entrega al arrendatario', 'Devolución al propietario'];
const oldId = '00000000-0000-0000-0000-000000000001';
const oldCommercialId = '00000000-0000-0000-0000-000000000002';
let db;
let originalRows;

before(async () => {
  db = new PGlite();
  await db.exec(`
    create table public.appointments (
      id uuid primary key default gen_random_uuid(),
      subject text not null,
      appointment_date date not null
    );
    insert into public.appointments (id, subject, appointment_date) values
      ('${oldId}', 'Cita antigua', '2026-11-18'),
      ('${oldCommercialId}', 'Visita comercial', '2026-11-18');
  `);
  await db.exec(initialMigration);
  // Comprueba el ajuste sobre la regla anterior que ya se ejecutó en Supabase.
  await assert.rejects(insert('Entrega al arrendatario', null), error => error.code === '23514');
  await insert('Visita comercial', 'WhatsApp');
  originalRows = (await db.query('select * from public.appointments order by id')).rows;
  await db.exec(migration);
});

after(async () => { if (db) await db.close(); });

async function insert(subject, source) {
  return db.query(
    'insert into public.appointments (subject, appointment_date, capture_source) values ($1, $2, $3) returning *',
    [subject, '2026-11-19', source],
  );
}

test('el ajuste coincide con el esquema nuevo y no modifica las citas existentes', async () => {
  const body = migration.slice(migration.indexOf('create or replace function'), migration.lastIndexOf('commit;')).trim();
  assert.ok(schema.includes(body));
  const rows = (await db.query('select * from public.appointments order by id')).rows;
  assert.deepEqual(rows, originalRows);
});

test('Supabase exige Captado para visitas comerciales nuevas, omitido o nulo', async () => {
  await assert.rejects(
    db.query("insert into public.appointments (subject, appointment_date) values ('Visita comercial', '2026-11-19')"),
    error => error.code === '23514' && error.message.includes('captada'),
  );
  await assert.rejects(insert('Visita comercial', null), error => error.code === '23514');
});

test('todos los demás asuntos permiten citas nuevas sin Captado', async () => {
  for (const subject of otherSubjects) {
    const { rows } = await insert(subject, null);
    assert.equal(rows[0].capture_source, null);
    const omitted = await db.query(
      'insert into public.appointments (subject, appointment_date) values ($1, $2) returning capture_source',
      [subject, '2026-11-19'],
    );
    assert.equal(omitted.rows[0].capture_source, null);
  }
});

test('se admiten los siete medios y se rechazan valores fuera del catálogo para cualquier asunto', async () => {
  for (const source of sources) {
    const { rows } = await insert('Visita comercial', source);
    assert.equal(rows[0].capture_source, source);
  }
  for (const subject of ['Visita comercial', 'Previsita de inventario']) {
    for (const source of ['', ' ', 'Otro', 'whatsapp', 'Finca Raiz']) {
      await assert.rejects(insert(subject, source), error => error.code === '23514');
    }
  }
});

test('las citas antiguas, incluidas visitas comerciales, conservan el campo vacío al editar', async () => {
  for (const id of [oldId, oldCommercialId]) {
    const { rows } = await db.query(`
      update public.appointments set appointment_date = '2026-11-20', capture_source = null
      where id = $1 returning capture_source
    `, [id]);
    assert.equal(rows[0].capture_source, null);
  }
});

test('cambiar solo el asunto a Visita comercial también exige el medio de captación', async () => {
  const { rows } = await insert('Previsita de inventario', null);
  const id = rows[0].id;
  await assert.rejects(
    db.query("update public.appointments set subject = 'Visita comercial' where id = $1", [id]),
    error => error.code === '23514',
  );
  await db.query(
    "update public.appointments set subject = 'Visita comercial', capture_source = 'Facebook' where id = $1", [id],
  );
  assert.equal((await db.query('select capture_source from public.appointments where id = $1', [id])).rows[0].capture_source, 'Facebook');
});

test('una visita comercial registrada puede cambiar de medio pero no perderlo manteniendo el asunto', async () => {
  const { rows } = await insert('Visita comercial', 'WhatsApp');
  const id = rows[0].id;
  await db.query("update public.appointments set capture_source = 'Finca Raíz' where id = $1", [id]);
  await assert.rejects(
    db.query('update public.appointments set capture_source = null where id = $1', [id]),
    error => error.code === '23514',
  );
  await db.query(
    "update public.appointments set subject = 'Entrega al arrendatario', capture_source = null where id = $1", [id],
  );
  assert.equal((await db.query('select capture_source from public.appointments where id = $1', [id])).rows[0].capture_source, null);
});

test('una cita no comercial puede cambiar o eliminar el medio opcional', async () => {
  const { rows } = await insert('Previsita de devolución', 'Instagram');
  const id = rows[0].id;
  await db.query("update public.appointments set capture_source = 'Proppit' where id = $1", [id]);
  await db.query('update public.appointments set capture_source = null where id = $1', [id]);
  assert.equal((await db.query('select capture_source from public.appointments where id = $1', [id])).rows[0].capture_source, null);
});

test('completar el medio de una visita comercial antigua elimina la excepción de campo vacío', async () => {
  await db.query("update public.appointments set capture_source = 'Ciencuadras' where id = $1", [oldCommercialId]);
  await assert.rejects(
    db.query('update public.appointments set capture_source = null where id = $1', [oldCommercialId]),
    error => error.code === '23514',
  );
});

test('repetir el ajuste no modifica datos y mantiene la regla condicional', async () => {
  const before = (await db.query('select * from public.appointments order by id')).rows;
  await db.exec(migration);
  const after = (await db.query('select * from public.appointments order by id')).rows;
  assert.deepEqual(after, before);
  await assert.rejects(insert('Visita comercial', null), error => error.code === '23514');
  assert.equal((await insert('Recepción Propietario', null)).rows[0].capture_source, null);
});
