const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { PGlite } = require('@electric-sql/pglite');

const schema = readFileSync(require.resolve('../supabase/schema.sql'), 'utf8');
const migration = readFileSync(require.resolve('../supabase/add-appointment-dashboard.sql'), 'utf8');
const id = value => `00000000-0000-0000-0000-${String(value).padStart(12, '0')}`;
let db;

before(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon;
    create role authenticated;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
    $$;
    create type public.app_role as enum ('admin', 'supervisor', 'advisor');
    create type public.team_type as enum ('rental', 'sales');
    create type public.appointment_status as enum ('pending', 'confirmed', 'completed', 'cancelled');
    create table public.profiles (
      id uuid primary key, role public.app_role, active boolean, must_change_password boolean,
      can_manage_team_appointments boolean default false
    );
    create table public.advisors (
      id uuid primary key, full_name text, team public.team_type, active boolean
    );
    create table public.appointments (
      advisor_id uuid references public.advisors, advisor_team public.team_type,
      appointment_date date, status public.appointment_status
    );
    alter table public.profiles enable row level security;
    alter table public.advisors enable row level security;
    alter table public.appointments enable row level security;
    insert into public.profiles values
      ('${id(1)}', 'admin', true, false, false),
      ('${id(2)}', 'supervisor', true, false, false),
      ('${id(3)}', 'advisor', true, false, true),
      ('${id(4)}', 'admin', false, false, false),
      ('${id(5)}', 'supervisor', true, true, false);
    insert into public.advisors values
      ('${id(3)}', 'Asesor arriendo', 'rental', true),
      ('${id(6)}', 'Asesor sin citas', 'sales', true),
      ('${id(7)}', 'Asesor inactivo', 'sales', false),
      ('${id(8)}', 'Asesor ventas', 'sales', true);
    insert into public.appointments values
      ('${id(3)}', 'rental', '2026-11-16', 'completed'),
      ('${id(3)}', 'rental', '2026-11-16', 'pending'),
      ('${id(3)}', 'rental', '2026-11-17', 'confirmed'),
      ('${id(3)}', 'rental', '2026-11-18', 'cancelled'),
      ('${id(3)}', 'rental', '2026-11-22', 'completed'),
      ('${id(3)}', 'rental', '2026-11-23', 'completed'),
      ('${id(3)}', 'rental', '2026-10-31', 'completed'),
      ('${id(3)}', 'sales', '2026-11-19', 'completed'),
      ('${id(8)}', 'sales', '2026-11-17', 'completed'),
      ('${id(7)}', 'sales', '2026-11-18', 'completed');
    insert into public.appointments
    select '${id(8)}', 'sales', '2026-12-01'::date,
      (case when n % 2 = 0 then 'completed' else 'pending' end)::public.appointment_status
    from generate_series(1, 1205) n;
  `);
  const helper = schema.match(/create or replace function public\.current_profile_role\(\)[\s\S]*?\$\$;/)[0];
  await db.exec(helper);
  await db.exec(migration);
});

after(async () => { if (db) await db.close(); });

async function signIn(user, role = 'authenticated') {
  await db.exec('reset role');
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [user ? id(user) : '']);
  await db.exec(`set role ${role}`);
}

async function metrics(start = '2026-11-16', end = '2026-11-23') {
  return (await db.query('select * from public.appointment_dashboard($1::date, $2::date)', [start, end])).rows;
}

test('la migración coincide con el esquema nuevo y es reutilizable', async () => {
  const functionSQL = text => text.match(/create or replace function public\.appointment_dashboard[\s\S]*?grant execute[^;]+;/)[0];
  assert.equal(functionSQL(migration), functionSQL(schema));
  await db.exec(migration);
});

test('admin obtiene totales por asesor y equipo, incluidos cancelados y ceros', async () => {
  await signIn(1);
  const rows = await metrics();
  const rental = rows.find(row => row.advisor_id === id(3) && row.team === 'rental');
  assert.equal(Number(rental.total), 5);
  assert.equal(Number(rental.completed), 2);
  const zero = rows.find(row => row.advisor_id === id(6));
  assert.equal(Number(zero.total), 0);
  assert.equal(Number(zero.completed), 0);
  assert.equal(rows.reduce((sum, row) => sum + Number(row.total), 0), 8);
});

test('supervisora accede sin permisos de lectura de la tabla de asesores', async () => {
  await signIn(2);
  assert.equal((await metrics()).length, 5);
  await assert.rejects(db.query('select * from public.advisors'), error => error.code === '42501');
});

test('los inactivos conservan historial y el equipo procede de cada cita', async () => {
  await signIn(1);
  const rows = await metrics();
  const inactive = rows.find(row => row.advisor_id === id(7));
  assert.equal(inactive.active, false);
  assert.equal(Number(inactive.completed), 1);
  const historical = rows.filter(row => row.advisor_id === id(3));
  assert.equal(historical.length, 2);
  assert.equal(Number(historical.find(row => row.team === 'sales').total), 1);
});

test('el mes incluye sus límites correctos y no está truncado a 1000 citas', async () => {
  await signIn(1);
  const november = await metrics('2026-11-01', '2026-12-01');
  assert.equal(november.reduce((sum, row) => sum + Number(row.total), 0), 9);
  const december = await metrics('2026-12-01', '2027-01-01');
  assert.equal(Number(december.find(row => row.advisor_id === id(8)).total), 1205);
  assert.equal(Number(december.find(row => row.advisor_id === id(8)).completed), 602);
  assert.equal(december.some(row => row.advisor_id === id(7)), false);
});

test('asesor gestor, admin inactivo, contraseña temporal y sesión desconocida son rechazados', async () => {
  for (const user of [3, 4, 5, 999, null]) {
    await signIn(user);
    await assert.rejects(metrics(), error => error.code === '42501');
  }
});

test('anon no tiene permiso de ejecución aunque presente un identificador de admin', async () => {
  await signIn(1, 'anon');
  await assert.rejects(metrics(), error => error.code === '42501');
});

test('fechas nulas, invertidas y periodos mayores a 31 días son rechazados', async () => {
  await signIn(1);
  for (const [start, end] of [[null, '2026-11-23'], ['2026-11-16', null],
    ['2026-11-16', '2026-11-16'], ['2026-11-16', '2026-11-15'], ['2026-11-01', '2026-12-03']]) {
    await assert.rejects(metrics(start, end), error => error.code === '22023');
  }
});
