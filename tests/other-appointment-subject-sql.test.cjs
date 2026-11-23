const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { PGlite } = require('@electric-sql/pglite');

const schema = readFileSync(require.resolve('../supabase/schema.sql'), 'utf8');
const migration = readFileSync(require.resolve('../supabase/add-other-appointment-subject.sql'), 'utf8');
const outcomes = readFileSync(require.resolve('../supabase/add-appointment-outcomes-dashboard.sql'), 'utf8');
const id = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
let db;
let originals;
let policies;

before(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
    $$;
    create type public.app_role as enum ('admin', 'supervisor', 'advisor');
    create type public.team_type as enum ('rental', 'sales');
    create type public.appointment_status as enum ('pending', 'confirmed', 'completed', 'cancelled');
    create table public.profiles (
      id uuid primary key, role public.app_role, active boolean, must_change_password boolean,
      team public.team_type, can_manage_team_appointments boolean default false
    );
    create table public.advisors (
      id uuid primary key, full_name text, team public.team_type, active boolean, color text
    );
    create table public.appointments (
      id uuid primary key default gen_random_uuid(), appointment_date date not null, appointment_time time not null default '10:00',
      subject text not null check (char_length(trim(subject)) between 1 and 160),
      client text not null check (char_length(trim(client)) between 1 and 160),
      phone text not null default '', property text not null default '', notes text not null default '',
      status public.appointment_status not null default 'pending',
      capture_source text, simi_property_code text, simi_property_url text,
      advisor_id uuid not null references public.advisors(id), advisor_name text not null,
      advisor_team public.team_type not null, advisor_color text not null,
      created_by uuid, updated_by uuid, created_at timestamptz default now(), updated_at timestamptz default now()
    );
    insert into public.profiles values
      ('${id(1)}', 'admin', true, false, null, false), ('${id(2)}', 'supervisor', true, false, null, false),
      ('${id(3)}', 'advisor', true, false, 'sales', false), ('${id(4)}', 'advisor', true, false, 'sales', true),
      ('${id(5)}', 'admin', true, true, null, false), ('${id(6)}', 'admin', false, false, null, false);
    insert into public.advisors values
      ('${id(3)}', 'Asesor', 'sales', true, 'blue'), ('${id(4)}', 'Gestora', 'sales', true, 'violet'),
      ('${id(7)}', 'Arriendos', 'rental', true, 'teal'), ('${id(8)}', 'Sin acceso', 'sales', true, 'amber');
    insert into public.appointments (id, appointment_date, subject, client, status, notes, advisor_id, advisor_name, advisor_team, advisor_color) values
      ('${id(10)}', '2026-11-18', 'Asunto antiguo', 'Cliente histórico', 'confirmed', '', '${id(3)}', 'Asesor', 'sales', 'blue'),
      ('${id(11)}', '2026-11-18', 'Otros', 'Cliente anterior', 'pending', '', '${id(3)}', 'Asesor', 'sales', 'blue');
  `);
  for (const name of ['current_profile_role', 'is_active_user', 'can_manage_appointment_team', 'prepare_appointment', 'validate_appointment_capture_source']) {
    const definition = schema.match(new RegExp(`create or replace function public\\.${name}\\([\\s\\S]*?\\$\\$;`));
    assert.ok(definition, name);
    await db.exec(definition[0]);
  }
  await db.exec(`
    create trigger appointments_prepare before insert or update on public.appointments
      for each row execute function public.prepare_appointment();
    create trigger appointments_validate_capture_source before insert or update of subject, capture_source on public.appointments
      for each row execute function public.validate_appointment_capture_source();
    alter table public.appointments enable row level security;
    grant select, insert, update, delete on public.appointments to authenticated;
  `);
  await db.exec(schema.slice(schema.indexOf('drop policy if exists appointments_read'), schema.indexOf('grant select on public.profiles')));
  await db.exec(outcomes);
  originals = (await db.query('select * from public.appointments order by id')).rows;
  policies = (await db.query("select * from pg_policies where tablename = 'appointments' order by policyname")).rows;
  await db.exec(migration);
});
after(async () => { if (db) await db.close(); });

async function signIn(user = 1, role = 'authenticated') {
  await db.exec('reset role');
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [user ? id(user) : '']);
  await db.exec(`set role ${role}`);
}
async function insert({ subject = 'Otros', client = '', notes = 'Actividad interna', advisor = 3, date = '2031-01-01' } = {}) {
  return (await db.query(`insert into public.appointments (subject, client, notes, advisor_id, appointment_date)
    values ($1, $2, $3, $4, $5) returning *`, [subject, client, notes, id(advisor), date])).rows[0];
}

test('la migración coincide con el esquema, conserva las citas y no cambia permisos ni SIMI', async () => {
  const body = migration.slice(migration.indexOf('alter table'), migration.lastIndexOf('commit;')).trim();
  assert.ok(schema.includes(body));
  await db.exec(migration);
  assert.deepEqual((await db.query('select * from public.appointments order by id')).rows, originals);
  assert.deepEqual((await db.query("select * from pg_policies where tablename = 'appointments' order by policyname")).rows, policies);
  assert.doesNotMatch(migration.replace(/--[^\n]*/g, ''), /\b(update|delete|insert|grant|revoke|policy|simi)\b/i);
});

test('Otros admite cliente vacío, conserva fecha, hora, asesor y queda sin resultado', async () => {
  await signIn();
  const row = await insert();
  assert.equal(row.client, '');
  assert.equal(row.notes, 'Actividad interna');
  assert.equal(row.subject, 'Otros');
  assert.equal(row.status, 'pending');
  assert.equal(row.phone, '');
  assert.equal(row.property, '');
  assert.equal(row.capture_source, null);
  assert.equal(row.advisor_id, id(3));
  assert.equal(row.advisor_team, 'sales');
  assert.equal(row.created_by, id(1));
  assert.equal(row.appointment_time, '10:00:00');
});

test('Otros exige notas no vacías en Supabase, incluso si el cliente omite validaciones', async () => {
  await signIn();
  for (const notes of ['', ' ', '\t\r\n  ']) {
    await assert.rejects(insert({ notes }), error => error.code === '23514' && error.message.includes('appointments_other_notes_check'));
  }
  await assert.rejects(insert({ notes: null }), error => error.code === '23502');
  await assert.rejects(db.query(`insert into public.appointments (subject, client, advisor_id, appointment_date)
    values ('Otros', '', $1, '2031-01-01')`, [id(3)]), error => error.code === '23514');
  const row = await insert();
  await assert.rejects(db.query("update public.appointments set notes = '' where id = $1", [row.id]), error => error.code === '23514');
});

test('los demás asuntos siguen exigiendo cliente y no requieren notas', async () => {
  await signIn();
  for (const subject of ['Recepción Propietario', 'Previsita de inventario', 'Asunto histórico']) {
    for (const client of ['', '   ']) {
      await assert.rejects(insert({ subject, client }), error => error.code === '23514' && error.message.includes('appointments_client_check'));
    }
    assert.equal((await insert({ subject, client: 'Cliente', notes: '' })).notes, '');
  }
  for (const subject of ['Otros', 'Recepción Propietario']) {
    await assert.rejects(insert({ subject, client: 'x'.repeat(161) }), error => error.code === '23514');
  }
});

test('pasar de Otros a un asunto normal exige cliente y conserva la regla de Captado comercial', async () => {
  await signIn();
  const row = await insert();
  await assert.rejects(db.query("update public.appointments set subject = 'Recepción Propietario' where id = $1", [row.id]),
    error => error.code === '23514');
  await db.query("update public.appointments set subject = 'Recepción Propietario', client = 'Cliente' where id = $1", [row.id]);
  await assert.rejects(db.query("update public.appointments set subject = 'Visita comercial' where id = $1", [row.id]),
    error => error.code === '23514' && error.message.includes('captada'));
  await db.query("update public.appointments set subject = 'Visita comercial', capture_source = 'WhatsApp' where id = $1", [row.id]);
});

test('las citas históricas no se reclasifican y Otros histórico sin notas solo las exige al guardar', async () => {
  await signIn();
  const historical = (await db.query('select * from public.appointments where id = $1', [id(10)])).rows[0];
  assert.equal(historical.status, 'confirmed');
  await db.query("update public.appointments set notes = 'Nota histórica' where id = $1", [id(10)]);
  assert.equal((await db.query('select status from public.appointments where id = $1', [id(10)])).rows[0].status, 'confirmed');
  await assert.rejects(db.query('update public.appointments set appointment_time = $1 where id = $2', ['11:00', id(11)]),
    error => error.code === '23514');
  await db.query("update public.appointments set notes = 'Propósito del espacio' where id = $1", [id(11)]);
});

test('Otros respeta los permisos reales de creación, lectura y edición por equipo', async () => {
  for (const user of [1, 2]) {
    await signIn(user);
    assert.equal((await insert({ advisor: 7 })).advisor_team, 'rental');
  }
  await signIn(3);
  const own = await insert();
  await assert.rejects(insert({ advisor: 8 }), error => error.code === '42501');
  assert.equal((await db.query("update public.appointments set notes = 'No permitido' where id = $1 returning id", [own.id])).rows.length, 0);
  await signIn(4);
  const managed = await insert({ advisor: 8 });
  await db.query("update public.appointments set notes = 'Gestión del equipo' where id = $1", [managed.id]);
  await assert.rejects(insert({ advisor: 7 }), error => error.code === '42501');
  const outside = (await db.query("select id from public.appointments where advisor_team = 'rental' limit 1")).rows[0].id;
  assert.equal((await db.query("update public.appointments set notes = 'No permitido' where id = $1 returning id", [outside])).rows.length, 0);
  for (const user of [5, 6]) {
    await signIn(user);
    await assert.rejects(insert(), error => error.code === '42501');
    assert.equal((await db.query('select * from public.appointments')).rows.length, 0);
  }
  await signIn(null, 'anon');
  await assert.rejects(insert(), error => error.code === '42501');
});

test('el Dashboard agrega Otros sin usar las notas como categorías ni devolver su contenido', async () => {
  await signIn();
  await insert({ date: '2027-02-01', notes: 'REUNION-PRIVADA' });
  await insert({ date: '2027-02-02', notes: 'CAPACITACION-PRIVADA' });
  const data = (await db.query("select public.appointment_outcome_dashboard('2027-02-01', '2027-03-01') as data")).rows[0].data;
  assert.equal(data.subjects.length, 1);
  assert.equal(data.subjects[0].label, 'Otros');
  assert.equal(data.subjects[0].total, 2);
  assert.equal(data.subjects[0].unresolved, 2);
  assert.equal(data.subjects[0].completed, 0);
  assert.equal(data.sources[0].label, 'Sin registrar');
  assert.doesNotMatch(JSON.stringify(data), /REUNION-PRIVADA|CAPACITACION-PRIVADA/);
});

test('repetir la migración después de crear reservas no cambia datos ni desactiva las validaciones', async () => {
  await db.exec('reset role');
  const before = (await db.query('select * from public.appointments order by id')).rows;
  await db.exec(migration);
  assert.deepEqual((await db.query('select * from public.appointments order by id')).rows, before);
  await signIn();
  await assert.rejects(insert({ notes: '' }), error => error.code === '23514');
  await assert.rejects(insert({ subject: 'Previsita de inventario' }), error => error.code === '23514');
});
