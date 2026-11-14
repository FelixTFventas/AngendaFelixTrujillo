const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { JSDOM } = require('jsdom');

const html = readFileSync(require.resolve('../index.html'), 'utf8');
const helpers = readFileSync(require.resolve('../dashboard.js'), 'utf8');
const app = readFileSync(require.resolve('../app.js'), 'utf8');
const settle = () => new Promise(resolve => setImmediate(resolve));
const sample = [
  { advisor_id: 'a', advisor_name: 'Ana <Ventas>', team: 'sales', active: true, total: 8, completed: 5 },
  { advisor_id: 'b', advisor_name: 'Luis', team: 'rental', active: true, total: 4, completed: 2 },
  { advisor_id: 'c', advisor_name: 'Asesor inactivo', team: 'sales', active: false, total: 2, completed: 1 },
];

async function workspace(role = 'admin', options = {}) {
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://agenda.example/' });
  const window = dom.window;
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  const profile = { id: 'user', full_name: 'Usuario', role, active: true, must_change_password: false,
    team: role === 'advisor' ? 'sales' : null, can_manage_team_appointments: role === 'advisor', ...options.profile };
  const calls = [];
  let response = async () => ({ data: sample, error: null });
  let realtime;
  const client = {
    auth: {
      getSession: async () => ({ data: { session: null }, error: null }),
      signOut: async () => ({}),
    },
    from: table => {
      const query = {
        select: () => query, eq: () => query, order: () => query,
        single: async () => ({ data: profile, error: null }),
        then: (resolve, reject) => Promise.resolve({ data: [], error: null }).then(resolve, reject),
      };
      return query;
    },
    rpc: async (name, args) => {
      if (name === 'appointment_dashboard') {
        calls.push(JSON.parse(JSON.stringify(args)));
        return response();
      }
      return { data: [], error: null };
    },
    channel: () => {
      const channel = { on: (event, filters, callback) => { realtime = callback; return channel; }, subscribe: () => channel };
      return channel;
    },
    removeChannel: async () => {},
  };
  window.SUPABASE_CONFIG = { url: 'https://example.supabase.co', publishableKey: 'public' };
  window.supabase = { createClient: () => client };
  window.eval(helpers);
  window.eval(app);
  await settle();
  await window.startSession({ id: 'user' });
  const query = selector => window.document.querySelector(selector);
  const click = async selector => { query(selector).click(); await settle(); };
  const change = async (selector, value) => {
    query(selector).value = value;
    query(selector).dispatchEvent(new window.Event('change'));
    await settle();
  };
  return { dom, window, query, click, change, calls, profile,
    setResponse: callback => { response = callback; }, realtime: () => realtime() };
}

test('admin y supervisora ven la pestaña; asesores gestores no acceden ni ejecutan RPC', async () => {
  for (const role of ['admin', 'supervisor', 'advisor']) {
    const ui = await workspace(role);
    try {
      const allowed = role !== 'advisor';
      const buttons = [...ui.window.document.querySelectorAll('[data-section="dashboard"]')];
      assert.equal(buttons.length, 2);
      assert.ok(buttons.every(button => button.hidden === !allowed));
      ui.window.showSection('dashboard');
      await settle();
      assert.equal(ui.query('#dashboardView').hidden, !allowed);
      assert.equal(ui.calls.length, allowed ? 1 : 0);
      if (role === 'supervisor') assert.equal(ui.query('[data-section="admin"]').hidden, true);
    } finally { ui.dom.window.close(); }
  }
});

test('tabla, resúmenes por equipo, filtros independientes y nombres seguros', async () => {
  const ui = await workspace();
  try {
    await ui.click('[data-section="dashboard"]');
    assert.equal(ui.query('#dashboardRows').rows.length, 3);
    assert.ok(ui.query('#dashboardRows').textContent.includes('Ana <Ventas>'));
    assert.equal(ui.query('#dashboardRows ventas'), null);
    assert.equal(ui.query('#dashboardTotals').textContent, 'Total seleccionado148');
    assert.equal(ui.query('.dashboard-team.rental dd').textContent, '4');
    assert.equal(ui.query('.dashboard-team.sales dd').textContent, '10');
    await ui.change('#dashboardTeam', 'sales');
    assert.equal(ui.query('#dashboardRows').rows.length, 2);
    assert.equal(ui.query('.dashboard-team.rental'), null);
    assert.equal(ui.query('#dashboardAdvisor option[value="b"]'), null);
    assert.ok(ui.query('#dashboardAdvisor option[value="c"]').textContent.includes('inactivo'));
    await ui.change('#dashboardAdvisor', 'a');
    assert.equal(ui.query('#dashboardRows').rows.length, 1);
    assert.equal(ui.query('#dashboardTotals').textContent, 'Total seleccionado85');
    await ui.change('#dashboardTeam', 'rental');
    assert.equal(ui.query('#dashboardAdvisor').value, 'all');
    assert.equal(ui.query('#dashboardRows').rows.length, 1);
    assert.equal(ui.calls.length, 1, 'los filtros no descargan citas ni necesitan nuevas consultas');
  } finally { ui.dom.window.close(); }
});

test('periodos semanales y mensuales, selección de fecha y navegación', async () => {
  const ui = await workspace();
  try {
    await ui.click('[data-section="dashboard"]');
    await ui.change('#dashboardDate', '2027-01-03');
    assert.deepEqual(ui.calls.at(-1), { period_start: '2026-12-28', period_end: '2027-01-04' });
    await ui.click('#dashboardNext');
    assert.deepEqual(ui.calls.at(-1), { period_start: '2027-01-04', period_end: '2027-01-11' });
    await ui.click('[data-period="month"]');
    assert.equal(ui.query('#dashboardDate').type, 'month');
    await ui.change('#dashboardDate', '2028-02');
    assert.deepEqual(ui.calls.at(-1), { period_start: '2028-02-01', period_end: '2028-03-01' });
    await ui.click('#dashboardPrevious');
    assert.deepEqual(ui.calls.at(-1), { period_start: '2028-01-01', period_end: '2028-02-01' });
    assert.equal(ui.query('[data-period="month"]').getAttribute('aria-pressed'), 'true');
  } finally { ui.dom.window.close(); }
});

test('RPC ausente muestra instrucciones y permite reintentar, sin ceros engañosos', async () => {
  const ui = await workspace();
  try {
    ui.setResponse(async () => ({ error: { code: 'PGRST202', message: 'Function not found' } }));
    await ui.click('[data-section="dashboard"]');
    assert.ok(ui.query('#dashboardStatus').textContent.includes('supabase/add-appointment-dashboard.sql'));
    assert.equal(ui.query('#dashboardRetry').hidden, false);
    assert.equal(ui.query('.dashboard-team dd').textContent, '—');
    assert.equal(ui.query('#dashboardTotals').textContent, '');
    ui.setResponse(async () => ({ data: [], error: null }));
    await ui.click('#dashboardRetry');
    assert.equal(ui.query('#dashboardRetry').hidden, true);
    assert.equal(ui.query('#dashboardTotals').textContent, 'Total seleccionado00');
    assert.ok(ui.query('#dashboardStatus').textContent.includes('No hay citas'));
  } finally { ui.dom.window.close(); }
});

test('una respuesta antigua no sobrescribe el periodo más reciente', async () => {
  const ui = await workspace();
  try {
    let finish;
    ui.setResponse(() => new Promise(resolve => { finish = resolve; }));
    await ui.click('[data-section="dashboard"]');
    assert.equal(ui.query('#dashboardResults').getAttribute('aria-busy'), 'true');
    ui.setResponse(async () => ({ data: sample.slice(0, 1), error: null }));
    await ui.click('#dashboardNext');
    finish({ data: sample, error: null });
    await settle();
    assert.equal(ui.query('#dashboardRows').rows.length, 1);
    assert.equal(ui.query('#dashboardTotals').textContent, 'Total seleccionado85');
    assert.equal(ui.query('#dashboardResults').getAttribute('aria-busy'), 'false');
  } finally { ui.dom.window.close(); }
});

test('cambios en tiempo real refrescan indicadores y cerrar sesión borra los datos', async () => {
  const ui = await workspace();
  try {
    await ui.click('[data-section="dashboard"]');
    await ui.realtime();
    await settle();
    assert.equal(ui.calls.length, 2);
    let finish;
    ui.setResponse(() => new Promise(resolve => { finish = resolve; }));
    ui.window.loadDashboard();
    await ui.click('#logoutButton');
    finish({ data: sample, error: null });
    await settle();
    assert.equal(ui.query('#dashboardView').hidden, true);
    assert.equal(ui.query('#dashboardRows').textContent, '');
    assert.equal(ui.query('#dashboardTeams').textContent, '');
    assert.ok([...ui.window.document.querySelectorAll('.dashboard-only')].every(button => button.hidden));
  } finally { ui.dom.window.close(); }
});

test('contraseña temporal no permite abrir el dashboard', async () => {
  const ui = await workspace('supervisor', { profile: { must_change_password: true } });
  try {
    ui.window.showSection('dashboard');
    await settle();
    assert.equal(ui.calls.length, 0);
    assert.equal(ui.query('#dashboardView').hidden, true);
  } finally { ui.dom.window.close(); }
});
