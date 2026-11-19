const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { JSDOM } = require('jsdom');

const html = readFileSync(require.resolve('../index.html'), 'utf8');
const helpers = readFileSync(require.resolve('../dashboard.js'), 'utf8');
const pickerScript = readFileSync(require.resolve('../property-picker.js'), 'utf8');
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
  const propertyCalls = [];
  const functionCalls = [];
  const appointmentCalls = [];
  const appointmentStore = [...(options.appointments || [])];
  let appointmentResponse = async ({ from = 0, to = 499 }) => {
    const rows = [...appointmentStore].sort((a, b) =>
      a.appointment_date.localeCompare(b.appointment_date)
      || a.appointment_time.localeCompare(b.appointment_time) || a.id.localeCompare(b.id));
    return { data: rows.slice(from, Math.min(to + 1, from + (options.appointmentCap || 1000))), count: rows.length, error: null };
  };
  let functionResponse = async () => options.syncResponse || { data: { count: 25 }, error: null };
  let propertyResponse = async () => ({ data: {
    properties: [{
      code: '459-7337', title: 'Apartamento · Primavera Verde · Neiva', neighborhood: 'Primavera Verde',
      city: 'Neiva', address: '', rental: true, sales: false,
      url: 'https://felixtrujillofalla.com/inmuebles/arriendo/detalle/459-7337',
    }], last_synced_at: '2026-11-18T12:00:00Z',
  }, error: null });
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
      const read = { from: 0, to: 999, orders: [], selectOptions: null };
      const query = {
        select: (columns, selectOptions) => { read.selectOptions = selectOptions; return query; },
        order: column => { read.orders.push(column); return query; },
        range: (from, to) => { read.from = from; read.to = to; return query; },
        eq: (column, value) => { if (column === 'id') selectedId = value; return query; },
        insert: payload => { mutation = { operation: 'insert', payload: { ...payload } }; return query; },
        update: payload => { mutation = { operation: 'update', payload: { ...payload } }; return query; },
        delete: () => { mutation = { operation: 'delete' }; return query; },
        single: async () => {
          if (table === 'profiles') return { data: profile, error: null };
          if (mutation) {
            if (options.saveError) return { data: null, error: options.saveError };
            if (options.saveThrow) throw options.saveThrow;
            if (options.saveResponse) return options.saveResponse(mutation, selectedId, appointmentStore);
            saved.push(mutation);
            const previous = appointmentStore.find(row => row.id === selectedId);
            const row = { ...previous, ...mutation.payload, id: selectedId || 'new-appointment',
              advisor_name: 'Ana', advisor_team: 'sales', advisor_color: 'blue' };
            const index = appointmentStore.findIndex(item => item.id === row.id);
            if (index >= 0) appointmentStore[index] = row; else appointmentStore.push(row);
            return { data: row, error: null };
          }
          return { data: null, error: null };
        },
        then: (resolve, reject) => Promise.resolve().then(() => {
          if (table !== 'appointments') return { data: [], error: null };
          if (mutation?.operation === 'delete') {
            const index = appointmentStore.findIndex(row => row.id === selectedId);
            if (index >= 0) appointmentStore.splice(index, 1);
            return { data: null, error: null };
          }
          appointmentCalls.push({ ...read, orders: [...read.orders], selectOptions: read.selectOptions ? { ...read.selectOptions } : null });
          return appointmentResponse(read);
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
      if (name === 'search_simi_properties') {
        propertyCalls.push(JSON.parse(JSON.stringify(args)));
        return propertyResponse();
      }
      return { data: [], error: null };
    },
    functions: {
      invoke: async (name, args) => {
        functionCalls.push({ name, args: JSON.parse(JSON.stringify(args)) });
        return functionResponse();
      },
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
  window.eval(pickerScript);
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
  return { dom, window, query, click, change, calls, saved, profile, propertyCalls, functionCalls, appointmentCalls, appointmentStore,
    setAppointmentResponse: callback => { appointmentResponse = callback; },
    setPropertyResponse: callback => { propertyResponse = callback; },
    setFunctionResponse: callback => { functionResponse = callback; },
    setResponse: callback => { response = callback; }, realtime: () => realtime(), getRealtime: () => realtime };
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

async function searchProperty(ui, query = '7337') {
  ui.query('#simiPropertyQuery').value = query;
  await ui.click('#simiSearchButton');
}

test('solo Visita comercial muestra y consulta el catálogo; los demás asuntos son manuales', async () => {
  const ui = await workspace();
  try {
    await ui.click('#newAppointment');
    assert.equal(ui.query('#simiPropertyPicker').hidden, true);
    for (const subject of subjectOptions.filter(value => value !== 'Visita comercial')) {
      await ui.change('#subject', subject);
      await searchProperty(ui);
      await ui.click('#simiSyncButton');
      assert.equal(ui.query('#simiPropertyPicker').hidden, true);
    }
    assert.equal(ui.propertyCalls.length, 0);
    assert.equal(ui.functionCalls.length, 0);
    await ui.change('#subject', 'Visita comercial');
    assert.equal(ui.query('#simiPropertyPicker').hidden, false);
    assert.equal(ui.propertyCalls.length, 0, 'abrir el selector no hace consultas innecesarias');
    await searchProperty(ui);
    assert.equal(ui.propertyCalls.length, 1);
    assert.deepEqual(ui.propertyCalls[0], { query_text: '7337', target_team: 'all', appointment_subject: 'Visita comercial' });
  } finally { ui.dom.window.close(); }
});

test('la búsqueda filtra por equipo y la actualización de SIMI está reservada al administrador', async () => {
  for (const role of ['admin', 'supervisor', 'advisor']) {
    const ui = await workspace(role);
    try {
      await ui.click('#newAppointment');
      await ui.change('#subject', 'Visita comercial');
      await ui.change('#team', 'sales');
      await searchProperty(ui);
      assert.equal(ui.propertyCalls[0].target_team, 'sales');
      assert.equal(ui.query('#simiSyncButton').hidden, role !== 'admin');
      await ui.click('#simiSyncButton');
      assert.equal(ui.functionCalls.length, role === 'admin' ? 1 : 0);
      if (role === 'admin') {
        assert.deepEqual(ui.functionCalls[0], { name: 'simi-catalog-sync', args: { body: { appointment_subject: 'Visita comercial', sync_protocol: 'batch-v1' } } });
      }
    } finally { ui.dom.window.close(); }
  }
});

test('seleccionar un inmueble guarda una copia de sus datos y enlaza la publicación', async () => {
  const ui = await workspace('admin', { advisors: appointmentAdvisors });
  try {
    await ui.click('#newAppointment');
    await ui.change('#subject', 'Visita comercial');
    await ui.change('#team', 'sales');
    await ui.change('#advisor', 'advisor');
    await ui.change('#captureSource', 'WhatsApp');
    ui.query('#client').value = 'Cliente';
    await searchProperty(ui);
    await ui.click('[data-simi-code="459-7337"]');
    assert.ok(ui.query('#property').value.includes('459-7337'));
    assert.equal(ui.query('#simiPropertySelection').hidden, false);
    assert.equal(ui.query('#simiPropertyLink').hostname, 'felixtrujillofalla.com');
    await ui.window.saveAppointment({ preventDefault() {} });
    assert.equal(ui.saved[0].payload.simi_property_code, '459-7337');
    assert.equal(ui.saved[0].payload.simi_property_url, 'https://felixtrujillofalla.com/inmuebles/arriendo/detalle/459-7337');
    ui.window.openDetails('new-appointment');
    assert.ok(ui.query('#detailContent').textContent.includes('Ver inmueble 459-7337'));
    await ui.click('#editAppointment');
    assert.ok(ui.query('#property').value.includes('459-7337'));
    assert.equal(ui.query('#simiPropertySelection').hidden, false);
    assert.equal(ui.propertyCalls.length, 1, 'editar una cita no recarga ni cambia el inmueble histórico');
  } finally { ui.dom.window.close(); }
});

test('cambiar de asunto conserva el texto sin consultas y permite volver al inmueble seleccionado', async () => {
  const ui = await workspace();
  try {
    await ui.click('#newAppointment');
    await ui.change('#subject', 'Visita comercial');
    await searchProperty(ui);
    await ui.click('[data-simi-code="459-7337"]');
    const text = ui.query('#property').value;
    await ui.change('#subject', 'Recepción Propietario');
    assert.equal(ui.query('#simiPropertyPicker').hidden, true);
    assert.equal(ui.query('#property').value, text);
    await ui.change('#subject', 'Visita comercial');
    assert.equal(ui.query('#simiPropertySelection').hidden, false);
    assert.equal(ui.query('#property').value, text);
    assert.equal(ui.propertyCalls.length, 1);
  } finally { ui.dom.window.close(); }
});

test('la entrada manual funciona sin SIMI y no exige migrar para guardar una dirección', async () => {
  const ui = await workspace('admin', { advisors: appointmentAdvisors });
  try {
    await ui.click('#newAppointment');
    await ui.change('#subject', 'Visita comercial');
    await ui.change('#team', 'sales');
    await ui.change('#advisor', 'advisor');
    await ui.change('#captureSource', 'Fijo');
    ui.query('#client').value = 'Cliente';
    ui.query('#property').value = 'Calle 10 # 4-20';
    await ui.window.saveAppointment({ preventDefault() {} });
    assert.equal(ui.saved[0].payload.property, 'Calle 10 # 4-20');
    assert.equal('simi_property_code' in ui.saved[0].payload, false);
    assert.equal(ui.propertyCalls.length, 0);
  } finally { ui.dom.window.close(); }
});

test('un fallo del catálogo no borra la dirección y las respuestas antiguas no reaparecen al cambiar el asunto', async () => {
  const ui = await workspace();
  try {
    await ui.click('#newAppointment');
    await ui.change('#subject', 'Visita comercial');
    ui.query('#property').value = 'Dirección manual';
    ui.setPropertyResponse(async () => ({ error: { code: 'PGRST202' } }));
    await searchProperty(ui);
    assert.ok(ui.query('#simiPropertyStatus').textContent.includes('dirección manual'));
    assert.equal(ui.query('#property').value, 'Dirección manual');
    let finish;
    ui.setPropertyResponse(() => new Promise(resolve => { finish = resolve; }));
    await searchProperty(ui);
    await ui.change('#subject', 'Previsita de devolución');
    finish({ data: { properties: [{ code: '459-1', url: 'https://felixtrujillofalla.com/inmuebles/venta/detalle/459-1' }] } });
    await settle();
    assert.equal(ui.query('#simiPropertyResults').children.length, 0);
    assert.equal(ui.query('#simiPropertyPicker').hidden, true);
    assert.equal(ui.query('#property').value, 'Dirección manual');
  } finally { ui.dom.window.close(); }
});

test('los resultados se tratan como texto y rechazan enlaces ajenos o javascript', async () => {
  const ui = await workspace();
  try {
    ui.setPropertyResponse(async () => ({ data: {
      properties: [
        { code: '459-1', title: '<img src=x onerror=alert(1)>', url: 'https://felixtrujillofalla.com/inmuebles/venta/detalle/459-1' },
        { code: '459-2', title: 'Peligroso', url: 'javascript:alert(1)' },
        { code: '459-3', title: 'Ajeno', url: 'https://otro.example/inmuebles/venta/detalle/459-3' },
      ], last_synced_at: '2026-11-18T12:00:00Z',
    } }));
    await ui.click('#newAppointment');
    await ui.change('#subject', 'Visita comercial');
    await searchProperty(ui, 'Neiva');
    assert.equal(ui.query('#simiPropertyResults img'), null);
    assert.equal(ui.query('#simiPropertyResults').children.length, 1);
    assert.ok(ui.query('#simiPropertyResults').textContent.includes('<img'));
  } finally { ui.dom.window.close(); }
});

test('modificar la dirección manualmente desvincula un inmueble sin borrar el texto', async () => {
  const appointment = {
    ...oldAppointment, subject: 'Visita comercial', capture_source: 'WhatsApp',
    property: '459-7337 · Apartamento histórico', simi_property_code: '459-7337',
    simi_property_url: 'https://felixtrujillofalla.com/inmuebles/arriendo/detalle/459-7337',
  };
  const ui = await workspace('admin', { advisors: appointmentAdvisors, appointments: [appointment] });
  try {
    ui.window.openAppointmentDialog(ui.window.mapAppointment(appointment));
    ui.query('#property').value = 'Nueva dirección manual';
    ui.query('#property').dispatchEvent(new ui.window.Event('input'));
    assert.equal(ui.query('#simiPropertySelection').hidden, true);
    await ui.window.saveAppointment({ preventDefault() {} });
    assert.equal(ui.saved[0].payload.property, 'Nueva dirección manual');
    assert.equal(ui.saved[0].payload.simi_property_code, null);
    assert.equal(ui.saved[0].payload.simi_property_url, null);
  } finally { ui.dom.window.close(); }
});

test('Probar conexión es un GET separado, solo para administradores y visitas comerciales', async () => {
  for (const role of ['admin', 'supervisor', 'advisor']) {
    const ui = await workspace(role, { syncResponse: { data: { code: 'SIMI_OK', ok: true }, error: null } });
    try {
      await ui.click('#newAppointment');
      await ui.click('#simiProbeButton');
      assert.equal(ui.functionCalls.length, 0);
      await ui.change('#subject', 'Visita comercial');
      assert.equal(ui.query('#simiProbeButton').hidden, role !== 'admin');
      await ui.click('#simiProbeButton');
      assert.equal(ui.functionCalls.length, role === 'admin' ? 1 : 0);
      if (role === 'admin') {
        assert.deepEqual(ui.functionCalls[0], {
          name: 'simi-catalog-sync',
          args: { method: 'GET', headers: { 'x-simi-appointment-subject': 'Visita comercial' } },
        });
        assert.ok(ui.query('#simiPropertyStatus').textContent.includes('Conexión con SIMI comprobada'));
        assert.equal(ui.propertyCalls.length, 0);
      }
    } finally { ui.dom.window.close(); }
  }
});

test('el diagnóstico de la función muestra el código y la página sin borrar la dirección manual', async () => {
  const ui = await workspace('admin', { syncResponse: {
    error: { context: { json: async () => ({
      error: 'SIMI tardó más del tiempo permitido.', code: 'SIMI_TIMEOUT', diagnostic: { page: 1 },
    }) } },
  } });
  try {
    await ui.click('#newAppointment');
    await ui.change('#subject', 'Visita comercial');
    ui.query('#property').value = 'Dirección manual';
    await ui.click('#simiProbeButton');
    assert.ok(ui.query('#simiPropertyStatus').textContent.includes('SIMI_TIMEOUT, página 1'));
    assert.equal(ui.query('#property').value, 'Dirección manual');
    assert.equal(ui.query('#simiSyncButton').disabled, false);
    assert.equal(ui.query('#simiProbeButton').disabled, false);
  } finally { ui.dom.window.close(); }
});

test('no se lanzan pruebas y sincronizaciones simultáneas ni se aplican resultados a otro asunto', async () => {
  const ui = await workspace();
  try {
    let finish;
    ui.setFunctionResponse(() => new Promise(resolve => { finish = resolve; }));
    await ui.click('#newAppointment');
    await ui.change('#subject', 'Visita comercial');
    await ui.click('#simiProbeButton');
    assert.equal(ui.query('#simiProbeButton').disabled, true);
    assert.equal(ui.query('#simiSyncButton').disabled, true);
    await ui.click('#simiSyncButton');
    assert.equal(ui.functionCalls.length, 1);
    await ui.change('#subject', 'Previsita de devolución');
    finish({ data: { code: 'SIMI_OK' }, error: null });
    await settle();
    assert.equal(ui.query('#simiPropertyPicker').hidden, true);
    assert.equal(ui.query('#simiPropertyStatus').textContent.includes('Conexión con SIMI comprobada'), false);
  } finally { ui.dom.window.close(); }
});

test('continúa lotes sucesivos con cursor nuevo y muestra el progreso hasta publicar', async () => {
  const ui = await workspace();
  try {
    let batch = 0;
    ui.setFunctionResponse(async () => ({ data: ++batch === 1
      ? { status: 'pending', next_page: 6, received: 100, total: 200, total_pages: 10 }
      : { status: 'complete', next_page: 11, received: 200, count: 200, total: 200, total_pages: 10 },
    }));
    await ui.click('#newAppointment');
    await ui.change('#subject', 'Visita comercial');
    await ui.click('#simiSyncButton');
    assert.equal(ui.functionCalls.length, 2);
    assert.ok(ui.query('#simiPropertyStatus').textContent.includes('Catálogo completo publicado: 200'));
    assert.ok(ui.query('#simiBatchLabel').textContent.includes('200'));
    assert.equal(ui.query('#simiBatchBar').value, 1);
    assert.equal(ui.query('#simiPauseButton').hidden, true);
  } finally { ui.dom.window.close(); }
});

test('pausar termina el lote actual y Continuar retoma sin perder el progreso', async () => {
  const ui = await workspace();
  try {
    let finish;
    ui.setFunctionResponse(() => new Promise(resolve => { finish = resolve; }));
    await ui.click('#newAppointment');
    await ui.change('#subject', 'Visita comercial');
    await ui.click('#simiSyncButton');
    await ui.click('#simiPauseButton');
    finish({ data: { status: 'pending', next_page: 6, received: 100, total: 200, total_pages: 10 } });
    await settle();
    assert.equal(ui.functionCalls.length, 1);
    assert.equal(ui.query('#simiSyncButton').textContent, 'Continuar carga');
    assert.ok(ui.query('#simiPropertyStatus').textContent.includes('Carga pausada'));
    assert.equal(ui.query('#simiBatchBar').value, 100);
    ui.setFunctionResponse(async () => ({ data: { status: 'complete', next_page: 11, received: 200, count: 200 } }));
    await ui.click('#simiSyncButton');
    assert.equal(ui.functionCalls.length, 2);
    assert.ok(ui.query('#simiPropertyStatus').textContent.includes('Catálogo completo publicado'));
  } finally { ui.dom.window.close(); }
});

test('errores de red conservan el avance e interrupciones por cambio de asunto no encadenan más lotes', async () => {
  const ui = await workspace();
  try {
    ui.setFunctionResponse(async () => ({ error: { context: { json: async () => ({
      code: 'SIMI_NETWORK', error: 'Falló la red.', progress: { status: 'pending', next_page: 22, received: 420 },
    }) } } }));
    await ui.click('#newAppointment');
    await ui.change('#subject', 'Visita comercial');
    await ui.click('#simiSyncButton');
    assert.equal(ui.query('#simiSyncButton').textContent, 'Continuar carga');
    assert.ok(ui.query('#simiPropertyStatus').textContent.includes('página 22'));
    let finish;
    ui.setFunctionResponse(() => new Promise(resolve => { finish = resolve; }));
    await ui.click('#simiSyncButton');
    await ui.change('#subject', 'Entrega al arrendatario');
    finish({ data: { status: 'pending', next_page: 27, received: 520 } });
    await settle();
    assert.equal(ui.functionCalls.length, 2);
    assert.equal(ui.query('#simiPropertyPicker').hidden, true);
    assert.equal(ui.query('#simiBatchProgress').hidden, true);
  } finally { ui.dom.window.close(); }
});

test('reiniciar una carga fallida exige confirmación y manda la acción solo una vez', async () => {
  const ui = await workspace();
  try {
    ui.setFunctionResponse(async () => ({ error: { context: { json: async () => ({
      error: 'Catálogo cambiado.', code: 'SIMI_CHANGED', progress: { status: 'failed', next_page: 22, received: 420 },
    }) } } }));
    await ui.click('#newAppointment');
    await ui.change('#subject', 'Visita comercial');
    await ui.click('#simiSyncButton');
    assert.equal(ui.query('#simiRestartButton').hidden, false);
    ui.window.confirm = () => false;
    await ui.click('#simiRestartButton');
    assert.equal(ui.functionCalls.length, 1);
    let calls = 0;
    ui.window.confirm = () => true;
    ui.setFunctionResponse(async () => ({ data: ++calls === 1
      ? { status: 'pending', next_page: 6, received: 100 }
      : { status: 'complete', next_page: 11, received: 200, count: 200 },
    }));
    await ui.click('#simiRestartButton');
    assert.equal(ui.functionCalls[1].args.body.action, 'restart');
    assert.equal('action' in ui.functionCalls[2].args.body, false);
    assert.ok(ui.query('#simiPropertyStatus').textContent.includes('Catálogo completo publicado'));
  } finally { ui.dom.window.close(); }
});

test('un avance repetido no causa bucles y cada clic tiene un límite de lotes', async () => {
  const ui = await workspace();
  try {
    ui.setFunctionResponse(async () => ({ data: { status: 'pending', next_page: 1, received: 0 } }));
    await ui.click('#newAppointment');
    await ui.change('#subject', 'Visita comercial');
    await ui.click('#simiSyncButton');
    assert.equal(ui.functionCalls.length, 1);
    assert.ok(ui.query('#simiPropertyStatus').textContent.includes('no confirmó un avance nuevo'));
    let batch = 0;
    ui.setFunctionResponse(async () => ({ data: {
      status: 'pending', next_page: ++batch * 5 + 1, received: batch * 100,
    } }));
    await ui.click('#simiSyncButton');
    assert.equal(ui.functionCalls.length, 21);
    assert.ok(ui.query('#simiPropertyStatus').textContent.includes('Carga pausada'));
  } finally { ui.dom.window.close(); }
});

test('una actualización nueva puede empezar desde la primera página tras un catálogo completo', async () => {
  const ui = await workspace();
  try {
    await ui.click('#newAppointment');
    await ui.change('#subject', 'Visita comercial');
    ui.setFunctionResponse(async () => ({ data: { status: 'complete', next_page: 51, received: 1000, count: 1000 } }));
    await ui.click('#simiSyncButton');
    let batch = 0;
    ui.setFunctionResponse(async () => ({ data: ++batch === 1
      ? { status: 'pending', next_page: 6, received: 100 }
      : { status: 'complete', next_page: 11, received: 200, count: 200 },
    }));
    await ui.click('#simiSyncButton');
    assert.equal(ui.functionCalls.length, 3);
    assert.ok(ui.query('#simiPropertyStatus').textContent.includes('Catálogo completo publicado: 200'));
  } finally { ui.dom.window.close(); }
});

test('revisar una página fallida no reinicia, no encadena lotes y conserva el progreso', async () => {
  const ui = await workspace();
  const progress = { status: 'failed', next_page: 33, received: 628, error_code: 'SIMI_FORMAT' };
  try {
    ui.setFunctionResponse(async () => ({ error: { context: { json: async () => ({
      error: 'La carga necesita revisión.', code: 'SIMI_JOB_FAILED', progress,
    }) } } }));
    await ui.click('#newAppointment');
    await ui.change('#subject', 'Visita comercial');
    assert.equal(ui.query('#simiInspectButton').hidden, true);
    await ui.click('#simiSyncButton');
    assert.equal(ui.query('#simiInspectButton').hidden, false);
    ui.setFunctionResponse(async () => ({ data: {
      code: 'SIMI_INSPECTION', classification: 'no_results_notice', diagnostic: { page: 33 }, progress,
      raw: 'PRIVADO', message: 'PRIVADO',
    } }));
    await ui.click('#simiInspectButton');
    assert.equal(ui.functionCalls.length, 2);
    assert.deepEqual(ui.functionCalls[1].args.body, {
      appointment_subject: 'Visita comercial', sync_protocol: 'batch-v1', action: 'inspect',
    });
    const status = ui.query('#simiPropertyStatus').textContent;
    assert.ok(status.includes('página 33'));
    assert.ok(status.includes('no_results_notice'));
    assert.ok(status.includes('no confirma el final'));
    assert.ok(status.includes('No se ha publicado ni reiniciado'));
    assert.equal(status.includes('PRIVADO'), false);
    assert.ok(ui.query('#simiBatchLabel').textContent.includes('628'));
    assert.ok(ui.query('#simiBatchLabel').textContent.includes('32'));
    assert.equal(ui.query('#simiRestartButton').hidden, false);
    assert.equal(ui.query('#simiPauseButton').hidden, true);
  } finally { ui.dom.window.close(); }
});

test('el diagnóstico está oculto a otros roles, otros fallos y asuntos no comerciales', async () => {
  for (const role of ['admin', 'advisor', 'supervisor']) {
    const ui = await workspace(role);
    try {
      ui.setFunctionResponse(async () => ({ error: { context: { json: async () => ({
        error: 'Duplicados.', progress: { status: 'failed', next_page: 33, received: 628, error_code: 'SIMI_DUPLICATE' },
      }) } } }));
      await ui.click('#newAppointment');
      await ui.change('#subject', 'Visita comercial');
      if (role === 'admin') await ui.click('#simiSyncButton');
      assert.equal(ui.query('#simiInspectButton').hidden, true);
      await ui.click('#simiInspectButton');
      assert.equal(ui.functionCalls.length, role === 'admin' ? 1 : 0);
      await ui.change('#subject', 'Entrega al arrendatario');
      assert.equal(ui.query('#simiInspectButton').hidden, true);
    } finally { ui.dom.window.close(); }
  }
});

test('durante una revisión no se ejecutan otras acciones y una respuesta tardía no aparece en otro asunto', async () => {
  const ui = await workspace();
  try {
    ui.setFunctionResponse(async () => ({ error: { context: { json: async () => ({
      error: 'Formato.', progress: { status: 'failed', next_page: 33, received: 628, error_code: 'SIMI_FORMAT' },
    }) } } }));
    await ui.click('#newAppointment');
    await ui.change('#subject', 'Visita comercial');
    await ui.click('#simiSyncButton');
    let finish;
    ui.setFunctionResponse(() => new Promise(resolve => { finish = resolve; }));
    await ui.click('#simiInspectButton');
    assert.equal(ui.query('#simiInspectButton').disabled, true);
    assert.equal(ui.query('#simiRestartButton').disabled, true);
    await ui.click('#simiSyncButton');
    await ui.click('#simiProbeButton');
    await ui.click('#simiInspectButton');
    assert.equal(ui.functionCalls.length, 2);
    await ui.change('#subject', 'Entrega al arrendatario');
    finish({ data: { code: 'SIMI_INSPECTION', classification: 'no_results_notice', diagnostic: { page: 33 } } });
    await settle();
    assert.equal(ui.query('#simiPropertyPicker').hidden, true);
    assert.equal(ui.query('#simiInspectButton').hidden, true);
    assert.equal(ui.query('#simiPropertyStatus').textContent.includes('SIMI_INSPECTION'), false);
  } finally { ui.dom.window.close(); }
});

test('un error de revisión no causa reintentos ni pierde los inmuebles guardados', async () => {
  const ui = await workspace();
  try {
    const progress = { status: 'failed', next_page: 33, received: 628, error_code: 'SIMI_FORMAT' };
    ui.setFunctionResponse(async () => ({ error: { context: { json: async () => ({ error: 'Formato.', progress }) } } }));
    await ui.click('#newAppointment');
    await ui.change('#subject', 'Visita comercial');
    await ui.click('#simiSyncButton');
    ui.setFunctionResponse(async () => ({ error: { context: { json: async () => ({
      error: 'Tiempo de espera agotado.', code: 'SIMI_TIMEOUT', diagnostic: { page: 33 }, progress,
    }) } } }));
    await ui.click('#simiInspectButton');
    assert.equal(ui.functionCalls.length, 2);
    assert.ok(ui.query('#simiBatchLabel').textContent.includes('628'));
    assert.ok(ui.query('#simiPropertyStatus').textContent.includes('SIMI_TIMEOUT'));
    assert.equal(ui.query('#simiInspectButton').disabled, false);
  } finally { ui.dom.window.close(); }
});

async function reviewedPublication(count = 628) {
  const ui = await workspace();
  const progress = { status: 'failed', next_page: 33, received: count, total: null, total_pages: null,
    error_code: 'SIMI_FORMAT', snapshot_ref: 'a'.repeat(32) };
  ui.setFunctionResponse(async () => ({ error: { context: { json: async () => ({ error: 'Formato.', progress }) } } }));
  await ui.click('#newAppointment');
  await ui.change('#subject', 'Visita comercial');
  await ui.click('#simiSyncButton');
  assert.equal(ui.query('#simiPublicationTools').hidden, true);
  ui.setFunctionResponse(async () => ({ data: { code: 'SIMI_INSPECTION', classification: 'no_results_notice',
    diagnostic: { page: 33 }, progress } }));
  await ui.click('#simiInspectButton');
  return { ...ui, publicationProgress: progress };
}

test('el cierre requiere escribir el total independiente y confirmar; cancelar no hace consultas', async () => {
  const ui = await reviewedPublication();
  try {
    assert.equal(ui.query('#simiPublicationTools').hidden, false);
    assert.equal(ui.query('#simiConfirmedTotal').value, '', 'no se rellena con el contador descargado');
    ui.window.confirm = () => { assert.fail('un total inválido no debe pedir confirmación'); };
    for (const value of ['', '627', '10001', '628.0', '-628', 'PRIVADO']) {
      ui.query('#simiConfirmedTotal').value = value;
      await ui.click('#simiPublishButton');
      assert.equal(ui.functionCalls.length, 2);
    }
    ui.query('#simiConfirmedTotal').value = '628';
    ui.window.confirm = () => false;
    await ui.click('#simiPublishButton');
    assert.equal(ui.functionCalls.length, 2);
    assert.ok(ui.query('#simiBatchLabel').textContent.includes('628'));
  } finally { ui.dom.window.close(); }
});

test('publicar manda una sola confirmación ligada al trabajo revisado y muestra el catálogo completo', async () => {
  for (const count of [628, 4]) {
    const ui = await reviewedPublication(count);
    try {
      ui.window.confirm = message => { assert.ok(message.includes(String(count))); return true; };
      ui.query('#simiConfirmedTotal').value = String(count);
      ui.setFunctionResponse(async () => ({ data: { code: 'SIMI_PUBLISHED', status: 'complete', next_page: 33,
        received: count, count, total: count, total_pages: 32, snapshot_ref: 'a'.repeat(32) } }));
      await ui.click('#simiPublishButton');
      assert.equal(ui.functionCalls.length, 3);
      assert.deepEqual(ui.functionCalls.at(-1).args.body, {
        appointment_subject: 'Visita comercial', sync_protocol: 'batch-v1', action: 'publish',
        confirmed: true, confirmed_total: count, expected_snapshot: 'a'.repeat(32), expected_next_page: 33,
      });
      assert.ok(ui.query('#simiPropertyStatus').textContent.includes(`Catálogo completo publicado: ${count}`));
      assert.equal(ui.query('#simiPublicationTools').hidden, true);
      assert.equal(ui.query('#simiRestartButton').hidden, true);
      assert.equal(ui.query('#simiBatchBar').value, 1);
    } finally { ui.dom.window.close(); }
  }
});

test('un cambio de trabajo o de asunto invalida la revisión y oculta el cierre', async () => {
  const ui = await reviewedPublication();
  try {
    ui.query('#simiConfirmedTotal').value = '628';
    ui.setFunctionResponse(async () => ({ error: { context: { json: async () => ({
      error: 'Otro trabajo.', progress: { ...ui.publicationProgress, snapshot_ref: 'b'.repeat(32) },
    }) } } }));
    await ui.click('#simiSyncButton');
    assert.equal(ui.query('#simiPublicationTools').hidden, true);
    assert.equal(ui.query('#simiConfirmedTotal').value, '');
    const calls = ui.functionCalls.length;
    await ui.click('#simiPublishButton');
    assert.equal(ui.functionCalls.length, calls);
    await ui.change('#subject', 'Entrega al arrendatario');
    assert.equal(ui.query('#simiPublicationTools').hidden, true);
  } finally { ui.dom.window.close(); }
});

test('un fallo al cerrar conserva el progreso, no reintenta y exige revisar otra vez antes de publicar', async () => {
  const ui = await reviewedPublication();
  try {
    ui.window.confirm = () => true;
    ui.query('#simiConfirmedTotal').value = '628';
    ui.setFunctionResponse(async () => ({ error: { context: { json: async () => ({
      error: 'La última página cambió.', code: 'SIMI_CHANGED', progress: ui.publicationProgress,
    }) } } }));
    await ui.click('#simiPublishButton');
    assert.equal(ui.functionCalls.length, 3);
    assert.ok(ui.query('#simiBatchLabel').textContent.includes('628'));
    assert.ok(ui.query('#simiPropertyStatus').textContent.includes('SIMI_CHANGED'));
    assert.equal(ui.query('#simiPublicationTools').hidden, true);
    assert.equal(ui.query('#simiInspectButton').hidden, false);
  } finally { ui.dom.window.close(); }
});

test('mientras publica bloquea otras acciones y no aplica una respuesta tardía a otro asunto', async () => {
  const ui = await reviewedPublication();
  try {
    ui.window.confirm = () => true;
    ui.query('#simiConfirmedTotal').value = '628';
    let finish;
    ui.setFunctionResponse(() => new Promise(resolve => { finish = resolve; }));
    await ui.click('#simiPublishButton');
    assert.equal(ui.query('#simiPublishButton').disabled, true);
    assert.equal(ui.query('#simiConfirmedTotal').disabled, true);
    assert.equal(ui.query('#simiPauseButton').hidden, true);
    await ui.click('#simiInspectButton');
    await ui.click('#simiSyncButton');
    assert.equal(ui.functionCalls.length, 3);
    await ui.change('#subject', 'Entrega al arrendatario');
    finish({ data: { code: 'SIMI_PUBLISHED', status: 'complete', next_page: 33, received: 628, count: 628 } });
    await settle();
    assert.equal(ui.query('#simiPublicationTools').hidden, true);
    assert.equal(ui.query('#simiPropertyStatus').textContent.includes('Catálogo completo publicado'), false);
  } finally { ui.dom.window.close(); }
});

test('el minuto de espera conserva la confirmación revisada y no obliga a repetir la inspección', async () => {
  const ui = await reviewedPublication();
  try {
    ui.window.confirm = () => true;
    ui.query('#simiConfirmedTotal').value = '628';
    ui.setFunctionResponse(async () => ({ error: { context: { json: async () => ({
      error: 'Espera un minuto antes de publicar.', code: 'SIMI_BATCH_BUSY',
      progress: { ...ui.publicationProgress, status: 'waiting', restart_required: true },
    }) } } }));
    await ui.click('#simiPublishButton');
    assert.equal(ui.query('#simiPublicationTools').hidden, false);
    assert.equal(ui.query('#simiConfirmedTotal').value, '628');
    assert.equal(ui.functionCalls.length, 3);
    ui.setFunctionResponse(async () => ({ data: { code: 'SIMI_PUBLISHED', status: 'complete', next_page: 33,
      received: 628, count: 628, total: 628, total_pages: 32 } }));
    await ui.click('#simiPublishButton');
    assert.equal(ui.functionCalls.length, 4);
    assert.equal(ui.functionCalls.at(-1).args.body.action, 'publish');
    assert.ok(ui.query('#simiPropertyStatus').textContent.includes('Catálogo completo publicado: 628'));
  } finally { ui.dom.window.close(); }
});

function agendaRows(amount = 1018) {
  return Array.from({ length: amount }, (_, index) => ({
    ...oldAppointment, id: `appointment-${String(index + 1).padStart(6, '0')}`,
    appointment_date: index < 1000 ? '2026-01-01' : '2026-11-24',
    subject: 'Entrega al arrendatario', client: `Cliente de prueba ${index + 1}`,
  }));
}
function storeResponse(ui) {
  return ({ from, to }) => ({ data: [...ui.appointmentStore].sort((a, b) =>
    a.appointment_date.localeCompare(b.appointment_date) || a.appointment_time.localeCompare(b.appointment_time)
    || a.id.localeCompare(b.id)).slice(from, to + 1), count: ui.appointmentStore.length, error: null });
}
async function fillNewAppointment(ui, subject = 'Entrega al arrendatario') {
  await ui.click('#newAppointment');
  await ui.change('#subject', subject);
  await ui.change('#team', 'sales');
  await ui.change('#advisor', 'advisor');
  await ui.change('#captureSource', 'WhatsApp');
  ui.query('#date').value = '2026-11-24';
  ui.query('#client').value = 'Cliente nuevo de prueba';
}

test('la agenda carga las 1018 citas con rangos explícitos y orden único estable', async () => {
  const ui = await workspace('admin', { appointments: agendaRows(), advisors: appointmentAdvisors });
  try {
    assert.equal(ui.window.filteredAppointments().length, 1018);
    assert.ok(ui.window.filteredAppointments().some(row => row.id === 'appointment-001018'));
    assert.deepEqual(ui.appointmentCalls.map(call => [call.from, call.to]), [[0, 499], [500, 999], [1000, 1499]]);
    for (const call of ui.appointmentCalls) {
      assert.deepEqual(call.orders, ['appointment_date', 'appointment_time', 'id']);
      assert.deepEqual(call.selectOptions, { count: 'exact' });
    }
  } finally { ui.dom.window.close(); }
});

test('también lee todo con un límite menor del servidor y no pide una página sobrante al completar el total', async () => {
  for (const options of [{ amount: 1018, cap: 120, requests: 9 }, { amount: 1000, cap: 1000, requests: 2 }]) {
    const ui = await workspace('admin', { appointments: agendaRows(options.amount), appointmentCap: options.cap });
    try {
      assert.equal(ui.window.filteredAppointments().length, options.amount);
      assert.equal(ui.appointmentCalls.length, options.requests);
      assert.equal(ui.appointmentCalls.at(-1).from, options.cap === 120 ? 960 : 500);
    } finally { ui.dom.window.close(); }
  }
});

test('una cita nueva permanece visible tras la actualización en tiempo real cuando ya hay más de mil', async () => {
  const ui = await workspace('admin', { appointments: agendaRows(), advisors: appointmentAdvisors });
  try {
    await fillNewAppointment(ui, 'Visita comercial');
    await ui.window.saveAppointment({ preventDefault() {} });
    await settle();
    await ui.realtime();
    assert.equal(ui.appointmentStore.length, 1019);
    assert.equal(ui.window.filteredAppointments().length, 1019);
    assert.ok(ui.window.filteredAppointments().some(row => row.id === 'new-appointment'));
    assert.ok(ui.query('#agendaList').textContent.includes('Cliente nuevo de prueba'));
    assert.equal(ui.saved.length, 1, 'no duplica el guardado para recuperar la visibilidad');
  } finally { ui.dom.window.close(); }
});

test('una actualización anterior que termina después de guardar no borra la cita nueva ni muestra un fallo antiguo', async () => {
  for (const response of [{ data: [], count: 0, error: null }, { data: null, error: { message: 'OLD_ERROR' } }]) {
    const ui = await workspace('admin', { advisors: appointmentAdvisors });
    try {
      let finish;
      ui.setAppointmentResponse(() => new Promise(resolve => { finish = resolve; }));
      const oldLoad = ui.window.loadAppointments();
      await settle();
      ui.setAppointmentResponse(storeResponse(ui));
      await fillNewAppointment(ui);
      await ui.window.saveAppointment({ preventDefault() {} });
      await settle();
      finish(response);
      assert.equal(await oldLoad, false);
      assert.equal(ui.window.filteredAppointments().length, 1);
      assert.equal(ui.window.filteredAppointments()[0].id, 'new-appointment');
      assert.ok(ui.query('#agendaList').textContent.includes('Cliente nuevo de prueba'));
      assert.equal(ui.query('#toast').textContent.includes('No fue posible actualizar'), false);
    } finally { ui.dom.window.close(); }
  }
});

test('solo aplica la actualización más reciente y no mezcla páginas de dos solicitudes', async () => {
  const ui = await workspace('admin', { appointments: [oldAppointment] });
  try {
    const rows = agendaRows();
    let finish;
    ui.setAppointmentResponse(({ from, to }) => from === 0
      ? { data: rows.slice(from, to + 1), count: rows.length, error: null }
      : new Promise(resolve => { finish = resolve; }));
    const oldLoad = ui.window.loadAppointments();
    await settle();
    assert.equal(ui.window.filteredAppointments().length, 1, 'no sustituye la agenda con las primeras 500');
    const fresh = { ...oldAppointment, id: 'fresh', subject: 'Recepción Propietario' };
    ui.setAppointmentResponse(() => ({ data: [fresh], count: 1, error: null }));
    assert.equal(await ui.window.loadAppointments(), true);
    finish({ data: rows.slice(500, 1000), count: rows.length, error: null });
    assert.equal(await oldLoad, false);
    assert.deepEqual(Array.from(ui.window.filteredAppointments(), row => row.id), ['fresh']);
  } finally { ui.dom.window.close(); }
});

test('un fallo de red o de una página posterior conserva la agenda anterior sin aplicar datos parciales', async () => {
  for (const mode of ['throw', 'page_error', 'changed_count', 'duplicate', 'missing_count', 'early_empty']) {
    const ui = await workspace('admin', { appointments: [oldAppointment] });
    try {
      const rows = agendaRows();
      const calls = ui.appointmentCalls.length;
      ui.setAppointmentResponse(({ from, to }) => {
        if (mode === 'throw') throw new Error('TEST_NETWORK');
        if (mode === 'missing_count') return { data: [], error: null };
        if (mode === 'early_empty') return { data: [], count: 1018, error: null };
        if (from === 0) return { data: rows.slice(from, to + 1), count: 1018, error: null };
        if (mode === 'page_error') return { data: null, count: null, error: { message: 'TEST_PAGE_ERROR' } };
        if (mode === 'changed_count') return { data: rows.slice(from, to + 1), count: 1019, error: null };
        return { data: [rows[0]], count: 1018, error: null };
      });
      assert.equal(await ui.window.loadAppointments(), false);
      assert.deepEqual(Array.from(ui.window.filteredAppointments(), row => row.id), ['old-appointment']);
      assert.ok(ui.query('#toast').textContent.includes('Se conserva la última lista'));
      assert.ok(ui.appointmentCalls.length - calls <= 2, 'no reintenta fallos ni sigue pidiendo páginas');
    } finally { ui.dom.window.close(); }
  }
});

test('cerrar sesión invalida respuestas pendientes y eventos antiguos; no reaparecen datos de la sesión anterior', async () => {
  const ui = await workspace('admin', { appointments: [oldAppointment] });
  try {
    const oldEvent = ui.getRealtime();
    let finish;
    ui.setAppointmentResponse(() => new Promise(resolve => { finish = resolve; }));
    const oldLoad = ui.window.loadAppointments();
    await settle();
    await ui.click('#logoutButton');
    finish({ data: [oldAppointment], count: 1, error: null });
    assert.equal(await oldLoad, false);
    assert.equal(ui.window.filteredAppointments().length, 0);
    assert.equal(ui.query('#appView').hidden, true);
    ui.setAppointmentResponse(() => ({ data: [], count: 0, error: null }));
    await ui.window.startSession({ id: 'user' });
    const calls = ui.appointmentCalls.length;
    await oldEvent();
    assert.equal(ui.appointmentCalls.length, calls);
    assert.equal(ui.window.filteredAppointments().length, 0);
  } finally { ui.dom.window.close(); }
});

test('una respuesta anterior a una edición o eliminación no restaura datos desactualizados', async () => {
  for (const action of ['edit', 'delete']) {
    const ui = await workspace('admin', { appointments: [oldAppointment], advisors: appointmentAdvisors });
    try {
      let finish;
      ui.setAppointmentResponse(() => new Promise(resolve => { finish = resolve; }));
      const oldLoad = ui.window.loadAppointments();
      await settle();
      ui.setAppointmentResponse(storeResponse(ui));
      if (action === 'edit') {
        ui.window.openAppointmentDialog(ui.window.mapAppointment(oldAppointment));
        await ui.change('#subject', 'Entrega al arrendatario');
        await ui.window.saveAppointment({ preventDefault() {} });
      } else {
        ui.window.confirm = () => true;
        ui.window.openDetails(oldAppointment.id);
        await ui.window.deleteAppointment();
      }
      await settle();
      finish({ data: [oldAppointment], count: 1, error: null });
      await oldLoad;
      const rows = ui.window.filteredAppointments();
      if (action === 'edit') assert.equal(rows[0].subject, 'Entrega al arrendatario');
      else assert.equal(rows.length, 0);
    } finally { ui.dom.window.close(); }
  }
});

test('una excepción al guardar libera el formulario y no anuncia éxito ni elimina citas previas', async () => {
  const ui = await workspace('admin', { appointments: [oldAppointment], advisors: appointmentAdvisors,
    saveThrow: new Error('Failed to fetch') });
  try {
    await fillNewAppointment(ui);
    await ui.window.saveAppointment({ preventDefault() {} });
    assert.equal(ui.query('#saveAppointment').disabled, false);
    assert.equal(ui.query('#appointmentDialog').open, true);
    assert.equal(ui.query('#client').value, 'Cliente nuevo de prueba');
    assert.equal(ui.query('#toast').textContent, 'No fue posible conectar con el servidor.');
    assert.deepEqual(Array.from(ui.window.filteredAppointments(), row => row.id), ['old-appointment']);
  } finally { ui.dom.window.close(); }
});

test('un guardado que termina después de cerrar sesión no añade datos a la sesión cerrada', async () => {
  let finish;
  const ui = await workspace('admin', { advisors: appointmentAdvisors,
    saveResponse: () => new Promise(resolve => { finish = resolve; }) });
  try {
    await fillNewAppointment(ui);
    const saving = ui.window.saveAppointment({ preventDefault() {} });
    await settle();
    assert.equal(ui.query('#saveAppointment').disabled, true);
    await ui.click('#logoutButton');
    assert.equal(ui.query('#saveAppointment').disabled, false);
    finish({ data: { ...oldAppointment, id: 'late-save' }, error: null });
    await saving;
    assert.equal(ui.window.filteredAppointments().length, 0);
    assert.equal(ui.query('#appView').hidden, true);
  } finally { ui.dom.window.close(); }
});

test('la paginación mantiene la lectura para todos los roles activos y no consulta con contraseña temporal', async () => {
  for (const role of ['admin', 'supervisor', 'advisor']) {
    const ui = await workspace(role, { appointments: agendaRows() });
    try {
      assert.equal(ui.window.filteredAppointments().length, 1018);
      assert.equal(ui.appointmentCalls.length, 3);
    } finally { ui.dom.window.close(); }
  }
  const temporary = await workspace('advisor', { profile: { must_change_password: true }, appointments: agendaRows() });
  try {
    assert.equal(await temporary.window.loadAppointments(), false);
    assert.equal(temporary.appointmentCalls.length, 0);
    assert.equal(temporary.window.filteredAppointments().length, 0);
  } finally { temporary.dom.window.close(); }
});

test('una agenda vacía confirmada por Supabase sí sustituye la lista anterior', async () => {
  const ui = await workspace('admin', { appointments: [oldAppointment] });
  try {
    ui.setAppointmentResponse(() => ({ data: [], count: 0, error: null }));
    assert.equal(await ui.window.loadAppointments(), true);
    assert.equal(ui.window.filteredAppointments().length, 0);
    assert.equal(ui.query('#toast').textContent.includes('No fue posible actualizar'), false);
  } finally { ui.dom.window.close(); }
});

test('una respuesta de guardado sin registro confirmado no muestra éxito ni borra datos o formulario', async () => {
  const ui = await workspace('admin', { appointments: [oldAppointment], advisors: appointmentAdvisors,
    saveResponse: async () => ({ data: null, error: null }) });
  try {
    await fillNewAppointment(ui);
    await ui.window.saveAppointment({ preventDefault() {} });
    assert.equal(ui.query('#saveAppointment').disabled, false);
    assert.equal(ui.query('#appointmentDialog').open, true);
    assert.equal(ui.window.filteredAppointments().length, 1);
    assert.ok(ui.query('#toast').textContent.includes('evitar duplicados'));
  } finally { ui.dom.window.close(); }
});
