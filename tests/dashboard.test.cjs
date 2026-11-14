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
  assert.deepEqual(dashboard.totals(rows), { total: 11, completed: 6 });
  assert.deepEqual(dashboard.totals(dashboard.filterRows(rows, 'rental')), { total: 5, completed: 3 });
  assert.deepEqual(dashboard.totals(dashboard.filterRows(rows, 'all', 'a')), { total: 7, completed: 4 });
  assert.deepEqual(dashboard.totals(dashboard.filterRows(rows, 'sales', 'a')), { total: 2, completed: 1 });
  assert.deepEqual(dashboard.totals(dashboard.filterRows(rows, 'rental', 'b')), { total: 0, completed: 0 });
});
