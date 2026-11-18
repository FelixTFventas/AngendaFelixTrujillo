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
  const saved = [];
  let response = async () => ({ data: sample, error: null });
  let realtime;
  const client = {
    auth: {
      getSession: async () => ({ data: { session: null }, error: null }),
      signOut: async () => ({}),
    },
    from: table => {
      let mutation;
      let selectedId;
      const query = {
        select: () => query, order: () => query,
        eq: (column, value) => { if (column === 'id') selectedId = value; return query; },
        insert: payload => { mutation = { operation: 'insert', payload: { ...payload } }; return query; },
        update: payload => { mutation = { operation: 'update', payload: { ...payload } }; return query; },
        single: async () => {
          if (table === 'profiles') return { data: profile, error: null };
          if (mutation) {
            if (options.saveError) return { data: null, error: options.saveError };
            saved.push(mutation);
            return { data: { ...mutation.payload, id: selectedId || 'new-appointment',
              advisor_name: 'Ana', advisor_team: 'sales', advisor_color: 'blue' }, error: null };
          }
          return { data: null, error: null };
        },
        then: (resolve, reject) => Promise.resolve({
          data: table === 'appointments' ? options.appointments || [] : [], error: null,
        }).then(resolve, reject),
      };
      return query;
    },
    rpc: async (name, args) => {
      if (name === 'appointment_dashboard') {
        calls.push(JSON.parse(JSON.stringify(args)));
        return response();
      }
      if (name === 'list_advisors') return { data: options.advisors || [], error: null };
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
  return { dom, window, query, click, change, calls, saved, profile,
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

const subjectOptions = [
  'Visita comercial',
  'Recepción Propietario',
  'Previsita de inventario',
  'Previsita de devolución',
  'Devolución por el arrendatario',
  'Entrega al arrendatario',
  'Devolución al propietario',
];
const appointmentAdvisors = [{ id: 'advisor', full_name: 'Ana', team: 'sales', color: 'blue', role: 'advisor' }];
const oldAppointment = {
  id: 'old-appointment', appointment_date: '2026-11-18', appointment_time: '10:00',
  subject: 'Visita al apartamento <Centro>', client: 'Cliente', phone: '', property: '',
  status: 'pending', notes: 'Conservar estas notas', advisor_id: 'advisor',
  advisor_name: 'Ana', advisor_team: 'sales', advisor_color: 'blue',
};

test('nueva cita ofrece exactamente los siete asuntos y obliga a seleccionar uno', async () => {
  const ui = await workspace();
  try {
    await ui.click('#newAppointment');
    const subject = ui.query('#subject');
    assert.equal(subject.tagName, 'SELECT');
    assert.equal(subject.required, true);
    assert.equal(subject.value, '');
    assert.equal(subject.options[0].textContent, 'Selecciona el asunto');
    assert.equal(subject.checkValidity(), false);
    assert.deepEqual([...subject.options].slice(1).map(option => option.value), subjectOptions);
    assert.equal(ui.window.document.activeElement, subject);
    await ui.window.saveAppointment({ preventDefault() {} });
    assert.equal(ui.saved.length, 0);
    assert.equal(ui.query('#toast').textContent, 'Selecciona el asunto de la cita.');
    for (const value of subjectOptions) {
      subject.value = value;
      assert.equal(subject.checkValidity(), true);
    }
  } finally { ui.dom.window.close(); }
});

test('el asunto seleccionado se guarda y se muestra en la agenda y el detalle', async () => {
  const ui = await workspace('admin', { advisors: appointmentAdvisors });
  try {
    await ui.click('#newAppointment');
    await ui.change('#subject', 'Entrega al arrendatario');
    await ui.change('#team', 'sales');
    await ui.change('#advisor', 'advisor');
    await ui.change('#captureSource', 'WhatsApp');
    ui.query('#client').value = 'Cliente';
    assert.equal(ui.query('#appointmentForm').checkValidity(), true);
    await ui.window.saveAppointment({ preventDefault() {} });
    assert.equal(ui.saved.length, 1);
    assert.equal(ui.saved[0].operation, 'insert');
    assert.equal(ui.saved[0].payload.subject, 'Entrega al arrendatario');
    assert.ok(ui.query('#agendaList').textContent.includes('Entrega al arrendatario'));
    ui.window.openDetails('new-appointment');
    assert.equal(ui.query('#detailTitle').textContent, 'Entrega al arrendatario');
  } finally { ui.dom.window.close(); }
});

test('editar una cita antigua conserva su asunto y sus datos al guardar', async () => {
  const ui = await workspace('admin', { advisors: appointmentAdvisors, appointments: [oldAppointment] });
  try {
    ui.window.openAppointmentDialog(ui.window.mapAppointment(oldAppointment));
    const subject = ui.query('#subject');
    assert.equal(subject.value, oldAppointment.subject);
    assert.equal(subject.checkValidity(), true);
    assert.equal(subject.querySelectorAll('[data-legacy-subject]').length, 1);
    assert.equal(subject.querySelector('centro'), null, 'el asunto antiguo se trata como texto');
    await ui.window.saveAppointment({ preventDefault() {} });
    assert.equal(ui.saved[0].operation, 'update');
    assert.equal(ui.saved[0].payload.subject, oldAppointment.subject);
    assert.equal(ui.saved[0].payload.notes, oldAppointment.notes);
    assert.equal(ui.saved[0].payload.appointment_date, oldAppointment.appointment_date);
    assert.equal(ui.saved[0].payload.capture_source, null);
  } finally { ui.dom.window.close(); }
});

test('se puede reemplazar un asunto antiguo por una opción de la lista', async () => {
  const ui = await workspace('admin', { advisors: appointmentAdvisors, appointments: [oldAppointment] });
  try {
    ui.window.openAppointmentDialog(ui.window.mapAppointment(oldAppointment));
    await ui.change('#subject', 'Visita comercial');
    await ui.change('#captureSource', 'WhatsApp');
    await ui.window.saveAppointment({ preventDefault() {} });
    assert.equal(ui.saved[0].payload.subject, 'Visita comercial');
    ui.window.openAppointmentDialog(ui.window.mapAppointment({ ...oldAppointment, subject: 'Visita comercial' }));
    assert.equal(ui.query('#subject').value, 'Visita comercial');
    assert.equal(ui.query('#subject').options.length, 8, 'no se duplican asuntos del catálogo');
  } finally { ui.dom.window.close(); }
});

test('los asuntos antiguos no se acumulan ni se ofrecen al crear nuevas citas', async () => {
  const ui = await workspace();
  try {
    const appointment = ui.window.mapAppointment(oldAppointment);
    ui.window.openAppointmentDialog(appointment);
    ui.query('#appointmentDialog').close();
    ui.window.openAppointmentDialog({ ...appointment, subject: 'Segundo asunto antiguo' });
    assert.equal(ui.query('#subject').options.length, 9);
    assert.equal(ui.query('#subject').value, 'Segundo asunto antiguo');
    assert.equal([...ui.query('#subject').options].some(option => option.value === oldAppointment.subject), false);
    ui.query('#appointmentDialog').close();
    await ui.click('#newAppointment');
    assert.equal(ui.query('#subject').value, '');
    assert.equal(ui.query('#subject').options.length, 8);
    assert.equal(ui.query('#subject').checkValidity(), false);
  } finally { ui.dom.window.close(); }
});

const captureSources = ['WhatsApp', 'Fijo', 'Finca Raíz', 'Proppit', 'Ciencuadras', 'Facebook', 'Instagram'];

test('Captado está debajo del inmueble y solo se vuelve obligatorio al seleccionar Visita comercial', async () => {
  for (const role of ['admin', 'supervisor', 'advisor']) {
    const ui = await workspace(role);
    try {
      await ui.click('#newAppointment');
      const source = ui.query('#captureSource');
      assert.equal(source.tagName, 'SELECT');
      assert.equal(ui.query('#property').parentElement.nextElementSibling.querySelector('select'), source);
      assert.equal(source.required, false);
      assert.equal(source.checkValidity(), true);
      assert.deepEqual([...source.options].slice(1).map(option => option.value), captureSources);
      await ui.change('#subject', 'Visita comercial');
      assert.equal(source.required, true);
      assert.equal(source.options[0].disabled, true);
      assert.equal(source.options[0].textContent, 'Selecciona el medio');
      assert.equal(source.value, '');
      assert.equal(source.checkValidity(), false);
      await ui.window.saveAppointment({ preventDefault() {} });
      assert.equal(ui.saved.length, 0);
      assert.equal(ui.query('#toast').textContent, 'Selecciona por dónde fue captada la cita.');
      assert.equal(ui.window.document.activeElement, source);
    } finally { ui.dom.window.close(); }
  }
});

test('cada medio de captación se guarda, aparece en detalle y se recupera al editar', async () => {
  const ui = await workspace('admin', { advisors: appointmentAdvisors });
  try {
    for (const value of captureSources) {
      await ui.click('#newAppointment');
      await ui.change('#subject', 'Visita comercial');
      await ui.change('#team', 'sales');
      await ui.change('#advisor', 'advisor');
      await ui.change('#captureSource', value);
      ui.query('#client').value = 'Cliente';
      assert.equal(ui.query('#appointmentForm').checkValidity(), true);
      await ui.window.saveAppointment({ preventDefault() {} });
      assert.equal(ui.saved.at(-1).payload.capture_source, value);
      ui.window.openDetails('new-appointment');
      const sourceDetail = [...ui.query('#detailContent').querySelectorAll('.detail-item')]
        .find(item => item.querySelector('.detail-label').textContent === 'Captado');
      assert.equal(sourceDetail.querySelector('.detail-value').textContent, value);
      await ui.click('#editAppointment');
      assert.equal(ui.query('#captureSource').value, value);
      assert.equal(ui.query('#captureSource').required, true);
      ui.query('#appointmentDialog').close();
    }
  } finally { ui.dom.window.close(); }
});

test('las citas antiguas sin Captado muestran Sin registrar y pueden editarse sin completar el medio', async () => {
  const ui = await workspace('admin', { advisors: appointmentAdvisors, appointments: [oldAppointment] });
  try {
    ui.window.openDetails(oldAppointment.id);
    assert.ok(ui.query('#detailContent').textContent.includes('Sin registrar'));
    await ui.click('#editAppointment');
    const source = ui.query('#captureSource');
    assert.equal(source.value, '');
    assert.equal(source.required, false);
    assert.equal(source.options[0].disabled, false);
    assert.equal(source.options[0].textContent, 'Sin registrar');
    assert.equal(source.checkValidity(), true);
    await ui.window.saveAppointment({ preventDefault() {} });
    assert.equal(ui.saved[0].operation, 'update');
    assert.equal(ui.saved[0].payload.capture_source, null);
    await ui.click('#newAppointment');
    assert.equal(source.value, '');
    assert.equal(source.required, false);
    await ui.change('#subject', 'Visita comercial');
    assert.equal(source.required, true, 'no se hereda la excepción de las citas antiguas');
    assert.equal(source.options[0].disabled, true);
  } finally { ui.dom.window.close(); }
});

test('una visita comercial con medio ya registrado permite cambiarlo pero no eliminarlo', async () => {
  const appointment = { ...oldAppointment, subject: 'Visita comercial', capture_source: 'Finca Raíz' };
  const ui = await workspace('admin', { advisors: appointmentAdvisors, appointments: [appointment] });
  try {
    ui.window.openAppointmentDialog(ui.window.mapAppointment(appointment));
    assert.equal(ui.query('#captureSource').value, 'Finca Raíz');
    await ui.change('#captureSource', '');
    await ui.window.saveAppointment({ preventDefault() {} });
    assert.equal(ui.saved.length, 0);
    assert.equal(ui.query('#captureSource').checkValidity(), false);
    await ui.change('#captureSource', 'Proppit');
    await ui.window.saveAppointment({ preventDefault() {} });
    assert.equal(ui.saved[0].payload.capture_source, 'Proppit');
  } finally { ui.dom.window.close(); }
});

test('se puede completar el medio en una cita antigua y se conserva al volver a editar', async () => {
  const ui = await workspace('admin', { advisors: appointmentAdvisors, appointments: [oldAppointment] });
  try {
    ui.window.openAppointmentDialog(ui.window.mapAppointment(oldAppointment));
    await ui.change('#captureSource', 'Facebook');
    await ui.window.saveAppointment({ preventDefault() {} });
    assert.equal(ui.saved[0].payload.capture_source, 'Facebook');
    ui.window.openDetails(oldAppointment.id);
    await ui.click('#editAppointment');
    assert.equal(ui.query('#captureSource').value, 'Facebook');
    assert.equal(ui.query('#captureSource').required, false);
  } finally { ui.dom.window.close(); }
});

test('los demás asuntos permiten crear citas sin medio de captación', async () => {
  const ui = await workspace('admin', { advisors: appointmentAdvisors });
  try {
    for (const subject of subjectOptions.filter(value => value !== 'Visita comercial')) {
      await ui.click('#newAppointment');
      await ui.change('#subject', subject);
      await ui.change('#team', 'sales');
      await ui.change('#advisor', 'advisor');
      ui.query('#client').value = 'Cliente';
      assert.equal(ui.query('#captureSource').required, false);
      assert.equal(ui.query('#appointmentForm').checkValidity(), true);
      await ui.window.saveAppointment({ preventDefault() {} });
      assert.equal(ui.saved.at(-1).payload.subject, subject);
      assert.equal(ui.saved.at(-1).payload.capture_source, null);
    }
  } finally { ui.dom.window.close(); }
});

test('cambiar el asunto adapta la validación sin borrar el medio seleccionado', async () => {
  const ui = await workspace();
  try {
    await ui.click('#newAppointment');
    await ui.change('#subject', 'Visita comercial');
    await ui.change('#captureSource', 'Instagram');
    await ui.change('#subject', 'Entrega al arrendatario');
    const source = ui.query('#captureSource');
    assert.equal(source.required, false);
    assert.equal(source.value, 'Instagram');
    assert.equal(source.options[0].disabled, false);
    await ui.change('#captureSource', '');
    assert.equal(source.checkValidity(), true);
    await ui.change('#subject', 'Visita comercial');
    assert.equal(source.required, true);
    assert.equal(source.checkValidity(), false);
  } finally { ui.dom.window.close(); }
});

test('cambiar otro asunto a Visita comercial exige Captado también al editar', async () => {
  const ui = await workspace('admin', { advisors: appointmentAdvisors, appointments: [oldAppointment] });
  try {
    ui.window.openAppointmentDialog(ui.window.mapAppointment(oldAppointment));
    await ui.change('#subject', 'Visita comercial');
    assert.equal(ui.query('#captureSource').required, true);
    await ui.window.saveAppointment({ preventDefault() {} });
    assert.equal(ui.saved.length, 0);
    await ui.change('#captureSource', 'Fijo');
    await ui.window.saveAppointment({ preventDefault() {} });
    assert.equal(ui.saved[0].payload.capture_source, 'Fijo');
  } finally { ui.dom.window.close(); }
});

test('las visitas comerciales antiguas sin Captado conservan la excepción al editar', async () => {
  const appointment = { ...oldAppointment, subject: 'Visita comercial' };
  const ui = await workspace('admin', { advisors: appointmentAdvisors, appointments: [appointment] });
  try {
    ui.window.openAppointmentDialog(ui.window.mapAppointment(appointment));
    assert.equal(ui.query('#captureSource').required, false);
    assert.equal(ui.query('#captureSource').options[0].textContent, 'Sin registrar');
    await ui.window.saveAppointment({ preventDefault() {} });
    assert.equal(ui.saved[0].payload.capture_source, null);
    assert.equal(ui.saved[0].payload.subject, 'Visita comercial');
  } finally { ui.dom.window.close(); }
});

test('al cambiar una visita comercial a otro asunto se puede dejar Captado vacío', async () => {
  const appointment = { ...oldAppointment, subject: 'Visita comercial', capture_source: 'WhatsApp' };
  const ui = await workspace('admin', { advisors: appointmentAdvisors, appointments: [appointment] });
  try {
    ui.window.openAppointmentDialog(ui.window.mapAppointment(appointment));
    await ui.change('#subject', 'Previsita de inventario');
    await ui.change('#captureSource', '');
    assert.equal(ui.query('#captureSource').required, false);
    await ui.window.saveAppointment({ preventDefault() {} });
    assert.equal(ui.saved[0].payload.subject, 'Previsita de inventario');
    assert.equal(ui.saved[0].payload.capture_source, null);
  } finally { ui.dom.window.close(); }
});

test('si falta la migración, se indica el script SQL y se conservan los datos del formulario', async () => {
  const ui = await workspace('admin', {
    advisors: appointmentAdvisors,
    saveError: { code: 'PGRST204', message: "Could not find the 'capture_source' column" },
  });
  try {
    await ui.click('#newAppointment');
    await ui.change('#subject', 'Visita comercial');
    await ui.change('#team', 'sales');
    await ui.change('#advisor', 'advisor');
    await ui.change('#captureSource', 'Instagram');
    ui.query('#client').value = 'Cliente';
    await ui.window.saveAppointment({ preventDefault() {} });
    assert.equal(ui.saved.length, 0);
    assert.ok(ui.query('#toast').textContent.includes('SUPABASE-SETUP.md'));
    assert.equal(ui.query('#appointmentDialog').open, true);
    assert.equal(ui.query('#captureSource').value, 'Instagram');
    assert.equal(ui.query('#captureSource').disabled, false);
  } finally { ui.dom.window.close(); }
});
