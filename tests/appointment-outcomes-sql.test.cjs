const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { PGlite } = require('@electric-sql/pglite');
const schema = readFileSync(require.resolve('../supabase/schema.sql'), 'utf8');
const migration = readFileSync(require.resolve('../supabase/add-appointment-outcomes-dashboard.sql'), 'utf8');
const id = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
let db;

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
    create table public.profiles (id uuid primary key, role public.app_role, active boolean, must_change_password boolean,
      can_manage_team_appointments boolean default false);
    create table public.advisors (id uuid primary key, full_name text, team public.team_type, active boolean);
    create table public.appointments (
      id uuid primary key default gen_random_uuid(), advisor_id uuid references public.advisors,
      advisor_team public.team_type, appointment_date date, status public.appointment_status not null default 'pending',
      subject text not null default 'Visita comercial', capture_source text, client text default 'CLIENTE-PRIVADO',
      phone text default 'TELEFONO-PRIVADO', property text default 'DIRECCION-PRIVADA', notes text default 'NOTAS-PRIVADAS',
      created_at timestamptz default '2020-01-01', created_by uuid
    );
    insert into public.profiles values
      ('${id(1)}', 'admin', true, false, false), ('${id(2)}', 'supervisor', true, false, false),
      ('${id(3)}', 'advisor', true, false, true), ('${id(4)}', 'admin', false, false, false),
      ('${id(5)}', 'admin', true, true, false);
    insert into public.advisors values ('${id(3)}', 'Asesor arriendo', 'rental', true),
      ('${id(6)}', 'Sin citas', 'sales', true), ('${id(7)}', 'Inactivo', 'sales', false);
    insert into public.appointments (id, advisor_id, advisor_team, appointment_date, status, subject, capture_source) values
      ('${id(10)}', '${id(3)}', 'rental', '2026-11-16', 'completed', 'Visita comercial', 'WhatsApp'),
      ('${id(11)}', '${id(3)}', 'rental', '2026-11-17', 'cancelled', 'Entrega al arrendatario', 'Facebook'),
      ('${id(12)}', '${id(3)}', 'rental', '2026-11-18', 'pending', 'Visita comercial', null),
      ('${id(13)}', '${id(3)}', 'rental', '2026-11-19', 'confirmed', 'Asunto anterior', null),
      ('${id(14)}', '${id(3)}', 'sales', '2026-11-20', 'completed', 'Previsita de devolución', 'Fijo'),
      ('${id(15)}', '${id(7)}', 'sales', '2026-11-21', 'completed', 'Visita comercial', 'Instagram'),
      ('${id(16)}', '${id(3)}', 'rental', '2026-11-23', 'completed', 'Visita comercial', 'WhatsApp'),
      ('${id(50)}', '${id(3)}', 'rental', '2030-01-01', 'confirmed', 'Histórico editable', null);
    alter table public.profiles enable row level security;
    alter table public.advisors enable row level security;
    alter table public.appointments enable row level security;
  `);
  await db.exec(schema.match(/create or replace function public\.current_profile_role\(\)[\s\S]*?\$\$;/)[0]);
  await db.exec(migration);
  await db.query(`insert into public.appointments (id, advisor_id, advisor_team, appointment_date, status, subject, capture_source)
    values ($1, $2, 'rental', '2026-11-22', 'rented', 'Visita comercial', 'WhatsApp')`, [id(17), id(3)]);
  await db.exec(`
    insert into public.appointments (advisor_id, advisor_team, appointment_date, status, subject, capture_source)
    select '${id(3)}', 'rental', '2026-12-01', (case n % 4
      when 0 then 'completed' when 1 then 'rented' when 2 then 'cancelled' else 'pending' end)::public.appointment_status,
      'Asunto histórico ' || n, (array['WhatsApp','Fijo','Finca Raíz','Proppit','Ciencuadras','Facebook','Instagram'])[1 + (n % 7)]
    from generate_series(1, 1205) n;
    grant select, insert, update on public.appointments to authenticated;
    create policy read_appointments on public.appointments for select to authenticated
      using (public.current_profile_role() is not null);
    create policy write_appointments on public.appointments for insert to authenticated
      with check (public.current_profile_role() in ('admin','supervisor') or advisor_id = auth.uid());
    create policy edit_appointments on public.appointments for update to authenticated
      using (public.current_profile_role() in ('admin','supervisor'))
      with check (public.current_profile_role() in ('admin','supervisor'));
  `);
});
after(async () => { if (db) await db.close(); });
async function signIn(user = 1, role = 'authenticated') {
  await db.exec('reset role');
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [user ? id(user) : '']);
  await db.exec(`set role ${role}`);
}
async function metrics(start = '2026-11-16', end = '2026-11-23') {
  return (await db.query('select public.appointment_outcome_dashboard($1, $2) as data', [start, end])).rows[0].data;
}
function total(rows, key) { return rows.reduce((sum, row) => sum + Number(row[key]), 0); }

test('la migración y el esquema coinciden; repetir el ajuste no reclasifica ni modifica citas', async () => {
  const body = migration.slice(migration.indexOf('create or replace function'), migration.lastIndexOf('commit;')).trim();
  assert.ok(schema.includes(body));
  await db.exec('reset role');
  const previous = (await db.query('select * from public.appointments order by id')).rows;
  await db.exec(migration);
  await db.exec(migration);
  assert.deepEqual((await db.query('select * from public.appointments order by id')).rows, previous);
  assert.doesNotMatch(migration.replace(/--[^\n]*/g, ''), /\b(update|delete from)\s+public\.appointments\b/i);
});

test('realizadas, arrendadas y canceladas son independientes; el total conserva citas sin resultado', async () => {
  await signIn();
  const data = await metrics();
  const rental = data.advisors.find(row => row.advisor_id === id(3) && row.team === 'rental');
  assert.deepEqual([rental.total, rental.completed, rental.rented, rental.cancelled, rental.unresolved], [5, 1, 1, 1, 2]);
  for (const group of ['advisors', 'subjects', 'sources']) {
    assert.equal(total(data[group], 'total'), 7);
    assert.equal(total(data[group], 'completed'), 3);
    assert.equal(total(data[group], 'rented'), 1);
    assert.equal(total(data[group], 'cancelled'), 1);
    assert.equal(total(data[group], 'unresolved'), 2);
  }
});

test('agrupa por asunto y Captado, conserva asuntos antiguos y Sin registrar', async () => {
  await signIn(2);
  const data = await metrics();
  assert.ok(data.subjects.some(row => row.label === 'Asunto anterior' && row.unresolved === 1));
  assert.ok(data.sources.some(row => row.label === 'Sin registrar' && row.total === 2));
  const whatsapp = data.sources.find(row => row.label === 'WhatsApp');
  assert.equal(whatsapp.completed, 1);
  assert.equal(whatsapp.rented, 1);
  assert.equal(whatsapp.total, 2);
  assert.equal(data.advisors.find(row => row.advisor_id === id(6)).total, 0);
  assert.equal(data.advisors.find(row => row.advisor_id === id(7)).active, false);
  assert.equal(data.advisors.filter(row => row.advisor_id === id(3)).length, 2, 'respeta el equipo histórico de cada cita');
  await assert.rejects(db.query('select * from public.advisors'), error => error.code === '42501');
});

test('usa fecha de la cita, no creación, y devuelve más de mil agrupaciones sin truncarlas', async () => {
  await signIn();
  assert.equal(total((await metrics('2026-11-01', '2026-12-01')).advisors, 'total'), 8);
  const december = await metrics('2026-12-01', '2027-01-01');
  assert.equal(total(december.advisors, 'total'), 1205);
  assert.equal(december.subjects.length, 1205);
  assert.equal(total(december.subjects, 'total'), 1205);
  assert.equal(total(december.advisors, 'completed'), 301);
  assert.equal(total(december.advisors, 'rented'), 302);
  assert.equal(total(december.advisors, 'cancelled'), 301);
  assert.equal(total(december.advisors, 'unresolved'), 301);
  assert.deepEqual(new Set(december.sources.map(row => row.label)),
    new Set(['WhatsApp', 'Fijo', 'Finca Raíz', 'Proppit', 'Ciencuadras', 'Facebook', 'Instagram']));
});

test('no devuelve datos de clientes, propiedades o contactos; solo indicadores agregados', async () => {
  await signIn();
  const data = await metrics();
  assert.deepEqual(Object.keys(data).sort(), ['advisors', 'protocol', 'sources', 'subjects']);
  for (const value of ['CLIENTE-PRIVADO', 'TELEFONO-PRIVADO', 'DIRECCION-PRIVADA', 'NOTAS-PRIVADAS', 'created_by', 'created_at']) {
    assert.equal(JSON.stringify(data).includes(value), false);
  }
});

test('asesores gestores, cuentas inactivas, contraseña temporal y anónimos no acceden a indicadores', async () => {
  for (const user of [3, 4, 5, 999, null]) {
    await signIn(user);
    await assert.rejects(metrics(), error => error.code === '42501');
  }
  await signIn(1, 'anon');
  await assert.rejects(metrics(), error => error.code === '42501');
});

test('periodos nulos, invertidos o mayores a 31 días son rechazados', async () => {
  await signIn();
  for (const [start, end] of [[null, '2026-11-23'], ['2026-11-16', null], ['2026-11-23', '2026-11-16'], ['2026-11-01', '2026-12-03']]) {
    await assert.rejects(metrics(start, end), error => error.code === '22023');
  }
});

test('permite registrar tres resultados y mantener una cita futura sin resultado, sin permitir Confirmada nueva', async () => {
  await signIn();
  for (const outcome of ['completed', 'rented', 'cancelled', 'pending']) {
    const result = await db.query(`insert into public.appointments (advisor_id, advisor_team, appointment_date, status)
      values ($1, 'rental', '2031-01-01', $2) returning id, status`, [id(3), outcome]);
    assert.equal(result.rows[0].status, outcome);
    if (outcome !== 'pending') {
      await assert.rejects(db.query("update public.appointments set status = 'pending' where id = $1", [result.rows[0].id]),
        error => error.code === '23514');
    }
  }
  await assert.rejects(db.query(`insert into public.appointments (advisor_id, advisor_team, appointment_date, status)
    values ($1, 'rental', '2031-01-01', 'confirmed')`, [id(3)]), error => error.code === '23514');
});

test('editar una cita Confirmada anterior conserva el valor o permite asignarle un resultado explícito', async () => {
  await signIn();
  await db.query("update public.appointments set notes = 'Nota nueva', status = 'confirmed' where id = $1", [id(50)]);
  assert.equal((await db.query('select status from public.appointments where id = $1', [id(50)])).rows[0].status, 'confirmed');
  await db.query("update public.appointments set status = 'rented' where id = $1", [id(50)]);
  assert.equal((await db.query('select status from public.appointments where id = $1', [id(50)])).rows[0].status, 'rented');
  await assert.rejects(db.query("update public.appointments set status = 'confirmed' where id = $1", [id(50)]), error => error.code === '23514');
});
