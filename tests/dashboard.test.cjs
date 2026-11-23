const { test } = require('node:test');
const assert = require('node:assert/strict');
const dashboard = require('../dashboard.js');

test('la semana empieza el lunes y cruza meses y años sin perder días', () => {
  assert.deepEqual(dashboard.period(new Date(2027, 0, 3), 'week'), {
    start: '2026-12-28', end: '2027-01-04',
  });
  assert.deepEqual(dashboard.period(new Date(2026, 10, 16), 'week'), {
    start: '2026-11-16', end: '2026-11-23',
  });
});

test('el mes usa límites exclusivos correctos, incluidos febrero bisiesto y diciembre', () => {
  assert.deepEqual(dashboard.period(new Date(2028, 1, 29), 'month'), {
    start: '2028-02-01', end: '2028-03-01',
  });
  assert.deepEqual(dashboard.period(new Date(2026, 11, 31), 'month'), {
    start: '2026-12-01', end: '2027-01-01',
  });
});

test('solo admin y supervisor activos con contraseña cambiada tienen acceso', () => {
  const profile = { active: true, must_change_password: false };
  for (const role of ['admin', 'supervisor']) {
    assert.equal(dashboard.canView({ ...profile, role }), true);
    assert.equal(dashboard.canView({ ...profile, role, active: false }), false);
    assert.equal(dashboard.canView({ ...profile, role, must_change_password: true }), false);
  }
  assert.equal(dashboard.canView({ ...profile, role: 'advisor', can_manage_team_appointments: true }), false);
  assert.equal(dashboard.canView(null), false);
});

test('filtros independientes por equipo y asesor, con totales numéricos', () => {
  const rows = [
    { advisor_id: 'a', team: 'rental', total: '5', completed: '3' },
    { advisor_id: 'b', team: 'sales', total: 4, completed: 2 },
    { advisor_id: 'a', team: 'sales', total: 2, completed: 1 },
  ];
  const expected = (total, completed) => ({ total, completed, rented: 0, cancelled: 0, unresolved: total - completed });
  assert.deepEqual(dashboard.totals(rows), expected(11, 6));
  assert.deepEqual(dashboard.totals(dashboard.filterRows(rows, 'rental')), expected(5, 3));
  assert.deepEqual(dashboard.totals(dashboard.filterRows(rows, 'all', 'a')), expected(7, 4));
  assert.deepEqual(dashboard.totals(dashboard.filterRows(rows, 'sales', 'a')), expected(2, 1));
  assert.deepEqual(dashboard.totals(dashboard.filterRows(rows, 'rental', 'b')), expected(0, 0));
});

function bundle() {
  const counts = { total: 4, completed: 1, rented: 1, cancelled: 1, unresolved: 1 };
  return { protocol: 'outcomes-v1',
    advisors: [{ advisor_id: 'a', advisor_name: 'Ana', team: 'rental', active: true, ...counts }],
    subjects: [{ advisor_id: 'a', team: 'rental', label: 'Visita comercial', ...counts }],
    sources: [{ advisor_id: 'a', team: 'rental', label: 'WhatsApp', ...counts }] };
}

test('normaliza agregados completos y mantiene los tres resultados separados sin datos privados', () => {
  const data = bundle();
  data.advisors[0].phone = 'PRIVADO';
  const result = dashboard.normalize(data);
  assert.deepEqual(dashboard.totals(result.advisors), { total: 4, completed: 1, rented: 1, cancelled: 1, unresolved: 1 });
  assert.equal(JSON.stringify(result).includes('PRIVADO'), false);
});

test('rechaza formatos antiguos, métricas ausentes, duplicados y desgloses truncados en vez de inventar ceros', () => {
  for (const change of [
    data => { delete data.protocol; },
    data => { delete data.advisors[0].rented; },
    data => { data.advisors[0].rented = -1; },
    data => { data.subjects[0].completed = 1.5; },
    data => { data.sources[0].total = 5; },
    data => { data.sources = []; },
    data => { data.subjects.push({ ...data.subjects[0] }); },
    data => { data.subjects[0].advisor_id = 'otro'; },
    data => { data.advisors[0].total = '4.0'; },
  ]) {
    const data = bundle();
    change(data);
    assert.throws(() => dashboard.normalize(data));
  }
});

test('agrupa asuntos y Captado después de aplicar equipo y asesor, sin duplicar resultados', () => {
  const rows = [
    { advisor_id: 'a', team: 'sales', label: 'WhatsApp', total: 3, completed: 1, rented: 1, cancelled: 1, unresolved: 0 },
    { advisor_id: 'b', team: 'rental', label: 'WhatsApp', total: 2, completed: 1, rented: 1, cancelled: 0, unresolved: 0 },
    { advisor_id: 'a', team: 'sales', label: 'Sin registrar', total: 1, completed: 0, rented: 0, cancelled: 0, unresolved: 1 },
  ];
  const all = dashboard.groupCategories(rows);
  assert.equal(all[0].label, 'WhatsApp');
  assert.equal(all[0].total, 5);
  assert.equal(all[0].completed, 2);
  assert.equal(all[0].rented, 2);
  assert.equal(dashboard.groupCategories(rows, 'rental')[0].total, 2);
  assert.equal(dashboard.groupCategories(rows, 'all', 'a')[0].total, 3);
  assert.deepEqual(dashboard.groupCategories(rows, 'sales', 'b'), []);
});
