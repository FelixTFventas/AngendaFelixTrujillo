const { url: SUPABASE_URL, publishableKey: SUPABASE_KEY } = window.SUPABASE_CONFIG;
const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

const teams = { rental: 'Arrendamientos', sales: 'Ventas' };
const roleLabels = { admin: 'Administrador', supervisor: 'Supervisora', advisor: 'Asesor' };
const statusLabel = { pending: 'Pendiente', confirmed: 'Confirmada', completed: 'Realizada', rented: 'Arrendado', cancelled: 'Cancelado' };
const appointmentOutcomeValues = ['completed', 'rented', 'cancelled'];

let appointments = [];
let appointmentsRequest = 0;
let appointmentsSession = 0;
let appointmentWriteRequest = 0;
let appointmentSaving = false;
const APPOINTMENTS_PAGE_SIZE = 500;
let advisors = [];
let appointmentCreators = new Map();
let reservedAdvisorColors = new Set();
let currentProfile = null;
let currentUser = null;
let appointmentsChannel = null;
let currentView = 'week';
let cursorDate = startOfDay(new Date());
let selectedDate = new Date(cursorDate);
let activeAppointmentId = null;
let dashboardMode = 'week';
let dashboardDate = startOfDay(new Date());
let dashboardData = [];
let dashboardSubjects = [];
let dashboardSources = [];
let dashboardRequest = 0;
let dashboardLoaded = false;

const authView = document.querySelector('#authView');
const appView = document.querySelector('#appView');
const loginForm = document.querySelector('#loginForm');
const loginMessage = document.querySelector('#loginMessage');
const grid = document.querySelector('#calendarGrid');
const agenda = document.querySelector('#agendaList');
const teamFilter = document.querySelector('#teamFilter');
const advisorFilter = document.querySelector('#advisorFilter');
const formTeam = document.querySelector('#team');
const formAdvisor = document.querySelector('#advisor');
const appointmentDialog = document.querySelector('#appointmentDialog');
const detailDialog = document.querySelector('#detailDialog');
const passwordDialog = document.querySelector('#passwordDialog');
const appointmentForm = document.querySelector('#appointmentForm');
const agendaView = document.querySelector('#agendaView');
const advisorsView = document.querySelector('#advisorsView');
const adminView = document.querySelector('#adminView');
const dashboardView = document.querySelector('#dashboardView');
const dashboardTeam = document.querySelector('#dashboardTeam');
const dashboardAdvisor = document.querySelector('#dashboardAdvisor');
const periodLabel = document.querySelector('#periodLabel');
const dayLabel = document.querySelector('#dayLabel');
const propertyPicker = new window.SimiPropertyPicker({
  client: supabaseClient,
  form: appointmentForm,
  getContext: () => ({ subject: appointmentForm.elements.subject.value, team: formTeam.value, profile: currentProfile }),
});

function startOfDay(date) { return new Date(date.getFullYear(), date.getMonth(), date.getDate()); }
function addDays(date, amount) { const result = new Date(date); result.setDate(result.getDate() + amount); return result; }
function startOfWeek(date) { return addDays(startOfDay(date), -((date.getDay() + 6) % 7)); }
function dateKey(date) { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; }
function parseDate(value) { const [year, month, day] = value.split('-').map(Number); return new Date(year, month - 1, day); }
function sameDay(first, second) { return dateKey(first) === dateKey(second); }
function capitalize(value) { return value.charAt(0).toUpperCase() + value.slice(1); }
function formatTime(value) {
  const match = String(value || '').match(/^(\d{1,2}):(\d{2})/);
  if (!match) return String(value || '');
  const hour = Number(match[1]);
  if (hour > 23) return String(value || '');
  return `${hour % 12 || 12}:${match[2]} ${hour < 12 ? 'a. m.' : 'p. m.'}`;
}
function moveMonth(date, amount) {
  const lastDay = new Date(date.getFullYear(), date.getMonth() + amount + 1, 0).getDate();
  return new Date(date.getFullYear(), date.getMonth() + amount, Math.min(date.getDate(), lastDay));
}
function escapeHTML(value) {
  return String(value ?? '').replace(/[&<>'"]/g, character => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' })[character]);
}
function initials(name) { return String(name || '').split(/\s+/).filter(Boolean).map(part => part[0]).join('').slice(0, 2).toUpperCase(); }
function isGlobalAppointmentManager() { return ['admin', 'supervisor'].includes(currentProfile?.role); }
function canManageOwnTeamAppointments() { return currentProfile?.can_manage_team_appointments === true && Boolean(currentProfile.team); }
function canAssignAppointments() { return isGlobalAppointmentManager() || canManageOwnTeamAppointments(); }
function canManageAppointment(appointment) {
  return isGlobalAppointmentManager()
    || (canManageOwnTeamAppointments() && appointment?.team === currentProfile.team);
}
function canDeleteAppointment(appointment) { return canManageAppointment(appointment); }
function advisorColor(advisorName, savedColor = '') {
  return savedColor || advisors.find(advisor => advisor.name === advisorName)?.color || 'neutral';
}
function isAdvisorColorConflict(message) {
  return /advisors_color_unique|duplicate key.*color|color.*already.*assigned|color.*ya est[aá] asignado/i.test(String(message || ''));
}
function readableError(error, fallback = 'No fue posible completar la acción.') {
  const message = error?.message || error?.error_description || fallback;
  if (/invalid login credentials/i.test(message)) return 'Correo o contraseña incorrectos.';
  if (/failed to fetch/i.test(message)) return 'No fue posible conectar con el servidor.';
  if (isAdvisorColorConflict(message)) return 'Ese color ya está asignado a otro asesor.';
  if (/duplicate|already been registered|already exists/i.test(message)) return 'Ya existe un usuario con ese correo.';
  return message;
}
function setBusy(form, busy) {
  form.querySelectorAll('button, input, select, textarea').forEach(control => {
    if (busy) {
      control.dataset.wasDisabled = String(control.disabled);
      control.disabled = true;
    } else {
      control.disabled = control.dataset.wasDisabled === 'true';
      delete control.dataset.wasDisabled;
    }
  });
}
function showToast(message) {
  const toast = document.querySelector('#toast');
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(window.toastTimer);
  window.toastTimer = setTimeout(() => toast.classList.remove('show'), 3000);
}

function mapAppointment(row) {
  return {
    id: row.id,
    date: row.appointment_date,
    time: String(row.appointment_time).slice(0, 5),
    subject: row.subject,
    client: row.client,
    phone: row.phone || '',
    property: row.property || '',
    captureSource: row.capture_source || '',
    simiPropertyCode: row.simi_property_code || null,
    simiPropertyURL: row.simi_property_url || '',
    status: row.status,
    notes: row.notes || '',
    advisorId: row.advisor_id,
    advisor: row.advisor_name,
    team: row.advisor_team,
    color: row.advisor_color,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
  };
}

async function startSession(user) {
  resetAppointments();
  const session = appointmentsSession;
  currentProfile = null;
  propertyPicker.reset();
  resetDashboard();
  currentUser = user;
  const { data: profile, error } = await supabaseClient.from('profiles').select('*').eq('id', user.id).single();
  if (session !== appointmentsSession) return;
  if (error || !profile) {
    await supabaseClient.auth.signOut();
    loginForm.elements.password.value = '';
    resetPasswordFields(loginForm);
    showAuth(readableError(error, 'El perfil todavía no está configurado. Ejecuta la configuración de Supabase.'));
    return;
  }
  if (!profile.active) {
    await supabaseClient.auth.signOut();
    loginForm.elements.password.value = '';
    resetPasswordFields(loginForm);
    showAuth('Este usuario está desactivado. Comunícate con el administrador.');
    return;
  }

  currentProfile = profile;
  appointmentCreators = new Map([[profile.id, profile.full_name]]);
  authView.hidden = true;
  appView.hidden = false;
  document.querySelector('#currentUserName').textContent = profile.full_name;
  document.querySelector('#currentUserRole').textContent = roleLabels[profile.role];
  document.querySelector('#logoutButton').textContent = initials(profile.full_name);
  document.querySelector('#logoutButton').setAttribute('aria-label', `Cerrar sesión de ${profile.full_name}`);
  document.querySelectorAll('.admin-only').forEach(control => { control.hidden = profile.role !== 'admin'; });
  document.querySelectorAll('.dashboard-only').forEach(control => { control.hidden = !window.AppointmentDashboard.canView(profile); });

  showSection('agenda');
  if (profile.must_change_password) {
    appointments = [];
    advisors = [];
    renderAdvisors();
    render();
    if (!passwordDialog.open) passwordDialog.showModal();
    return;
  }
  await activateWorkspace();
}

async function activateWorkspace() {
  const session = appointmentsSession;
  document.querySelectorAll('.dashboard-only').forEach(control => { control.hidden = !window.AppointmentDashboard.canView(currentProfile); });
  await Promise.all([loadAdvisors(), loadAppointments(), loadAppointmentCreators()]);
  if (session !== appointmentsSession || !currentProfile?.active || currentProfile.must_change_password) return;
  setAdvisorOptions(advisorFilter, 'all', 'all', true);
  renderAdvisors();
  render();
  subscribeToAppointments();
}

function showAuth(message = '') {
  resetAppointments();
  propertyPicker.reset();
  resetDashboard();
  currentProfile = null;
  currentUser = null;
  appointmentCreators = new Map();
  appView.hidden = true;
  authView.hidden = false;
  loginMessage.textContent = message;
}

function resetAppointments() {
  appointmentsSession += 1;
  appointmentsRequest += 1;
  appointments = [];
  if (appointmentSaving) {
    appointmentWriteRequest += 1;
    appointmentSaving = false;
    setBusy(appointmentForm, false);
  }
  render();
}

async function loadAdvisors() {
  const session = appointmentsSession;
  const { data, error } = await supabaseClient.rpc('list_advisors');
  if (session !== appointmentsSession) return;
  if (error) {
    advisors = [];
    showToast(readableError(error, 'No fue posible cargar los asesores.'));
    return;
  }
  advisors = (data || []).map(advisor => ({
    id: advisor.id,
    name: advisor.full_name,
    team: advisor.team,
    color: advisor.color || 'neutral',
    role: advisor.role || 'advisor',
  }));
}

async function loadAppointments() {
  if (!currentProfile?.active || currentProfile.must_change_password) return false;
  const request = ++appointmentsRequest;
  const session = appointmentsSession;
  const isCurrent = () => request === appointmentsRequest && session === appointmentsSession;
  const rows = [];
  const seen = new Set();
  let total = null;
  try {
    for (;;) {
      const offset = rows.length;
      const { data, count, error } = await supabaseClient
        .from('appointments')
        .select('*', { count: 'exact' })
        .order('appointment_date')
        .order('appointment_time')
        .order('id')
        .range(offset, offset + APPOINTMENTS_PAGE_SIZE - 1);
      if (!isCurrent()) return false;
      if (error) throw error;
      if (!Array.isArray(data) || !Number.isSafeInteger(count) || count < 0
        || (total !== null && count !== total) || offset + data.length > count
        || (!data.length && offset < count)) {
        throw new Error('La lectura de citas está incompleta o cambió durante la actualización.');
      }
      total = count;
      for (const row of data) {
        if (!row || typeof row.id !== 'string' || !row.id || seen.has(row.id)) {
          throw new Error('La lectura de citas contiene registros repetidos o no válidos.');
        }
        seen.add(row.id);
        rows.push(row);
      }
      // Avanzar por las filas recibidas también admite un límite de servidor menor.
      if (rows.length === total) break;
    }
    if (!isCurrent()) return false;
    // Solo reemplazar la agenda al tener la lectura completa, nunca con una página parcial.
    appointments = rows.map(mapAppointment);
    render();
    invalidateDashboard();
    return true;
  } catch {
    if (isCurrent()) showToast('No fue posible actualizar la agenda completa. Se conserva la última lista disponible; vuelve a recargar la agenda.');
    return false;
  }
}

async function loadAppointmentCreators() {
  const session = appointmentsSession;
  const { data, error } = await supabaseClient.rpc('list_appointment_creators');
  if (session !== appointmentsSession) return;
  if (error) {
    appointmentCreators = new Map(currentProfile ? [[currentProfile.id, currentProfile.full_name]] : []);
    showToast(readableError(error, 'No fue posible cargar los usuarios que crearon las citas.'));
    return;
  }
  appointmentCreators = new Map((data || []).map(profile => [profile.id, profile.full_name]));
  if (currentProfile) appointmentCreators.set(currentProfile.id, currentProfile.full_name);
}

function subscribeToAppointments() {
  const session = appointmentsSession;
  if (appointmentsChannel) supabaseClient.removeChannel(appointmentsChannel);
  appointmentsChannel = supabaseClient
    .channel('appointments-live')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'appointments' }, () => {
      if (session !== appointmentsSession || !currentProfile?.active || currentProfile.must_change_password) return Promise.resolve();
      return Promise.all([loadAppointments(), loadAppointmentCreators()]);
    })
    .subscribe();
}

function filteredAppointments() {
  return appointments.filter(appointment => {
    const matchesTeam = teamFilter.value === 'all' || appointment.team === teamFilter.value;
    const matchesAdvisor = advisorFilter.value === 'all' || appointment.advisorId === advisorFilter.value;
    return matchesTeam && matchesAdvisor;
  });
}

function setAdvisorOptions(select, team, selectedValue = '', allowAll = false) {
  let available = advisors.filter(advisor => team === 'all' || advisor.team === team);
  if (!allowAll && currentProfile) {
    if (canManageOwnTeamAppointments() && !isGlobalAppointmentManager()) {
      available = available.filter(advisor => advisor.team === currentProfile.team);
    } else if (!canAssignAppointments()) {
      available = available.filter(advisor => advisor.id === currentProfile.id);
    }
  }
  const firstOption = allowAll
    ? '<option value="all">Todos</option>'
    : `<option value="">${team ? 'Selecciona un asesor' : 'Selecciona primero un equipo'}</option>`;
  select.innerHTML = firstOption + available.map(advisor => `<option value="${advisor.id}">${escapeHTML(advisor.name)}</option>`).join('');
  select.disabled = !allowAll && (!team || !canAssignAppointments());
  if ([...select.options].some(option => option.value === selectedValue)) select.value = selectedValue;
}

function refreshAdvisorUI(selectedAdvisor = advisorFilter.value) {
  setAdvisorOptions(advisorFilter, teamFilter.value, selectedAdvisor, true);
  renderAdvisors();
  render();
  invalidateDashboard();
}

function renderAdvisors() {
  document.querySelector('#advisorsByTeam').innerHTML = Object.entries(teams).map(([team, label]) => {
    const members = advisors.filter(advisor => advisor.team === team);
    return `<section class="advisor-group" aria-labelledby="team-${team}">
      <div class="advisor-group-head"><h2 id="team-${team}">${label}</h2><span>${members.length} asesores</span></div>
      <div class="advisors-grid">${members.map(advisor => `<button class="advisor-card advisor-color ${advisor.color}" type="button" data-advisor-id="${advisor.id}" data-team="${team}"><span class="advisor-name">${escapeHTML(advisor.name)}</span><span class="advisor-team"><span class="advisor-swatch" aria-hidden="true"></span>${label} · ${roleLabels[advisor.role] || 'Asesor'}</span></button>`).join('')}</div>
    </section>`;
  }).join('');
}

function renderWeek(filtered) {
  const days = Array.from({ length: 7 }, (_, index) => addDays(startOfWeek(cursorDate), index));
  grid.className = 'week';
  grid.setAttribute('aria-label', 'Calendario semanal');
  grid.innerHTML = days.map(day => {
    const key = dateKey(day);
    const events = filtered.filter(appointment => appointment.date === key).sort((a, b) => a.time.localeCompare(b.time));
    const isToday = sameDay(day, startOfDay(new Date()));
    const isSelected = sameDay(day, selectedDate);
    const classes = ['day', isToday ? 'today' : '', isSelected ? 'selected' : ''].filter(Boolean).join(' ');
    const formattedDate = capitalize(new Intl.DateTimeFormat('es', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(day));
    const appointmentLabel = `${events.length} ${events.length === 1 ? 'cita' : 'citas'}`;
    const indicator = events.length > 1
      ? `<span class="day-count">${events.length}</span>`
      : events.length === 1 ? '<span class="day-dot"></span>' : '';
    return `<div class="${classes}" data-date="${key}">
      <button class="day-head" type="button" data-date="${key}" aria-label="${formattedDate}, ${appointmentLabel}" aria-pressed="${isSelected}"><span class="day-name">${capitalize(new Intl.DateTimeFormat('es', { weekday: 'short' }).format(day).replace('.', ''))}</span><span class="day-number">${day.getDate()}</span><span class="day-indicator" aria-hidden="true">${indicator}</span></button>
      <div class="day-body">${events.map(event => `<button class="event ${event.team} advisor-color ${advisorColor(event.advisor, event.color)}" data-date="${event.date}" data-appointment-id="${event.id}"><time>${escapeHTML(formatTime(event.time))}</time><strong>${escapeHTML(event.subject)}</strong><span>${escapeHTML(event.client)}</span></button>`).join('')}</div>
    </div>`;
  }).join('');
  const first = days[0];
  const last = days[6];
  const sameMonth = first.getMonth() === last.getMonth() && first.getFullYear() === last.getFullYear();
  periodLabel.textContent = sameMonth
    ? `${first.getDate()}–${last.getDate()} de ${new Intl.DateTimeFormat('es', { month: 'long', year: 'numeric' }).format(last)}`
    : `${new Intl.DateTimeFormat('es', { day: 'numeric', month: 'short' }).format(first)} – ${new Intl.DateTimeFormat('es', { day: 'numeric', month: 'short', year: 'numeric' }).format(last)}`;
}

function renderMonth(filtered) {
  const firstOfMonth = new Date(cursorDate.getFullYear(), cursorDate.getMonth(), 1);
  const calendarStart = startOfWeek(firstOfMonth);
  const days = Array.from({ length: 42 }, (_, index) => addDays(calendarStart, index));
  grid.className = 'week month-view';
  grid.setAttribute('aria-label', 'Calendario mensual');
  grid.innerHTML = `<div class="month-weekdays" aria-hidden="true">${['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'].map(day => `<span>${day}</span>`).join('')}</div>${days.map(day => {
    const key = dateKey(day);
    const events = filtered.filter(appointment => appointment.date === key).sort((a, b) => a.time.localeCompare(b.time));
    const classes = ['month-day', day.getMonth() !== cursorDate.getMonth() ? 'outside' : '', sameDay(day, startOfDay(new Date())) ? 'today' : '', sameDay(day, selectedDate) ? 'selected' : ''].filter(Boolean).join(' ');
    return `<div class="${classes}" data-date="${key}"><span class="month-day-number">${day.getDate()}</span>
      ${events.slice(0, 3).map(event => `<button class="month-event ${event.team} advisor-color ${advisorColor(event.advisor, event.color)}" data-date="${event.date}" data-appointment-id="${event.id}" title="${escapeHTML(`${formatTime(event.time)} · ${event.subject} · ${event.client}`)}">${escapeHTML(formatTime(event.time))} · ${escapeHTML(event.subject)}</button>`).join('')}
      ${events.length > 3 ? `<span class="more-events">+${events.length - 3} citas</span>` : ''}</div>`;
  }).join('')}`;
  periodLabel.textContent = capitalize(new Intl.DateTimeFormat('es', { month: 'long', year: 'numeric' }).format(cursorDate));
}

function renderAgenda(filtered) {
  const key = dateKey(selectedDate);
  const selectedEvents = filtered.filter(appointment => appointment.date === key).sort((a, b) => a.time.localeCompare(b.time));
  dayLabel.textContent = capitalize(new Intl.DateTimeFormat('es', { weekday: 'long', day: 'numeric', month: 'long' }).format(selectedDate));
  agenda.innerHTML = selectedEvents.length ? selectedEvents.map((event, index) => `<li class="agenda-item"><button class="agenda-item-button advisor-color ${advisorColor(event.advisor, event.color)}" type="button" data-appointment-id="${event.id}"><span class="agenda-time">${escapeHTML(formatTime(event.time))}<span>${teams[event.team]}</span></span><span class="agenda-copy"><strong>${escapeHTML(event.subject)}</strong><span>${escapeHTML(event.client)}</span><span class="meta"><span class="mini-avatar">${initials(event.advisor)}</span>${escapeHTML(event.advisor)} · ${teams[event.team]}</span></span></button></li>`).join('') : '<li class="empty">No hay citas para esta fecha y filtros seleccionados.</li>';
}

function render() {
  if (!grid || !agenda) return;
  const filtered = filteredAppointments();
  if (currentView === 'month') renderMonth(filtered); else renderWeek(filtered);
  renderAgenda(filtered);
}

function resetDashboard() {
  dashboardRequest += 1;
  dashboardData = [];
  dashboardSubjects = [];
  dashboardSources = [];
  dashboardLoaded = false;
  dashboardMode = 'week';
  dashboardDate = startOfDay(new Date());
  dashboardView.hidden = true;
  dashboardTeam.value = 'all';
  dashboardAdvisor.innerHTML = '<option value="all">Todos</option>';
  document.querySelectorAll('.dashboard-only').forEach(control => { control.hidden = true; });
  document.querySelector('#dashboardTeams').replaceChildren();
  document.querySelector('#dashboardRows').replaceChildren();
  document.querySelector('#dashboardTotals').replaceChildren();
  document.querySelector('#dashboardSubjectsRows').replaceChildren();
  document.querySelector('#dashboardSourcesRows').replaceChildren();
  document.querySelector('#dashboardUnresolved').textContent = '';
  document.querySelector('#dashboardStatus').textContent = '';
  document.querySelector('#dashboardRetry').hidden = true;
  document.querySelector('#dashboardResults').setAttribute('aria-busy', 'false');
}

function updateDashboardPeriod() {
  const { start, end } = window.AppointmentDashboard.period(dashboardDate, dashboardMode);
  const first = parseDate(start);
  const last = addDays(parseDate(end), -1);
  const format = new Intl.DateTimeFormat('es', { day: 'numeric', month: 'short', year: 'numeric' });
  document.querySelector('#dashboardPeriodLabel').textContent = dashboardMode === 'month'
    ? capitalize(new Intl.DateTimeFormat('es', { month: 'long', year: 'numeric' }).format(first))
    : `${format.format(first)} – ${format.format(last)}`;
  const input = document.querySelector('#dashboardDate');
  input.type = dashboardMode === 'month' ? 'month' : 'date';
  input.value = dashboardMode === 'month' ? start.slice(0, 7) : dateKey(dashboardDate);
  document.querySelector('#dashboardDateLabel').textContent = dashboardMode === 'month' ? 'Mes' : 'Fecha de la semana';
  document.querySelector('#dashboardPrevious').setAttribute('aria-label', dashboardMode === 'month' ? 'Mes anterior' : 'Semana anterior');
  document.querySelector('#dashboardNext').setAttribute('aria-label', dashboardMode === 'month' ? 'Mes siguiente' : 'Semana siguiente');
  document.querySelectorAll('#dashboardPeriodSwitcher button').forEach(button => {
    const active = button.dataset.period === dashboardMode;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
}

function updateDashboardAdvisorOptions() {
  const selected = dashboardAdvisor.value;
  const available = new Map();
  window.AppointmentDashboard.filterRows(dashboardData, dashboardTeam.value).forEach(row => {
    available.set(row.advisor_id, row);
  });
  const sorted = [...available.values()].sort((a, b) => a.advisor_name.localeCompare(b.advisor_name, 'es'));
  dashboardAdvisor.innerHTML = '<option value="all">Todos</option>' + sorted.map(row =>
    `<option value="${escapeHTML(row.advisor_id)}">${escapeHTML(row.advisor_name)}${row.active ? '' : ' (inactivo)'}</option>`).join('');
  if (available.has(selected)) dashboardAdvisor.value = selected;
}

function renderDashboard() {
  if (!window.AppointmentDashboard.canView(currentProfile)) return;
  const { filterRows, totals, groupCategories } = window.AppointmentDashboard;
  const rows = filterRows(dashboardData, dashboardTeam.value, dashboardAdvisor.value);
  const number = value => new Intl.NumberFormat('es-CO').format(value);
  const cells = counts => ['total', 'completed', 'rented', 'cancelled']
    .map(key => `<td class="numeric" data-metric="${key}">${number(counts[key])}</td>`).join('');
  document.querySelector('#dashboardTeams').innerHTML = Object.entries(teams)
    .filter(([team]) => dashboardTeam.value === 'all' || dashboardTeam.value === team)
    .map(([team, label]) => {
      const counts = totals(filterRows(rows, team));
      return `<article class="dashboard-team ${team}"><h2>${label}</h2><dl class="dashboard-counts">${[
        ['total', 'Total de citas'], ['completed', 'Realizadas'], ['rented', 'Arrendadas'], ['cancelled', 'Canceladas'],
      ].map(([key, title]) => `<div><dt>${title}</dt><dd class="${key}">${dashboardLoaded ? number(counts[key]) : '—'}</dd></div>`).join('')}</dl><p class="dashboard-team-note">${dashboardLoaded ? `${number(counts.unresolved)} citas sin resultado todavía.` : 'Esperando indicadores.'}</p></article>`;
    }).join('');
  const sorted = [...rows].sort((a, b) => a.team.localeCompare(b.team) || a.advisor_name.localeCompare(b.advisor_name, 'es'));
  document.querySelector('#dashboardRows').innerHTML = dashboardLoaded
    ? sorted.length ? sorted.map(row => `<tr><th scope="row">${escapeHTML(row.advisor_name)}${row.active ? '' : ' <span class="dashboard-inactive">(inactivo)</span>'}</th><td>${escapeHTML(teams[row.team] || row.team)}</td>${cells(row)}</tr>`).join('')
      : '<tr><td colspan="6" class="empty">No hay asesores para este periodo y filtros.</td></tr>'
    : '<tr><td colspan="6" class="empty">Sin datos disponibles.</td></tr>';
  const counts = totals(rows);
  document.querySelector('#dashboardTotals').innerHTML = dashboardLoaded
    ? `<tr><th scope="row" colspan="2">Total seleccionado</th>${cells(counts)}</tr>` : '';
  for (const [selector, data] of [['#dashboardSubjectsRows', dashboardSubjects], ['#dashboardSourcesRows', dashboardSources]]) {
    const groups = groupCategories(data, dashboardTeam.value, dashboardAdvisor.value);
    document.querySelector(selector).innerHTML = dashboardLoaded && groups.length
      ? groups.map(row => `<tr><th scope="row">${escapeHTML(row.label)}</th>${cells(row)}</tr>`).join('')
      : `<tr><td colspan="5" class="empty">${dashboardLoaded ? 'No hay citas para estos filtros.' : 'Sin datos disponibles.'}</td></tr>`;
  }
  document.querySelector('#dashboardUnresolved').textContent = dashboardLoaded
    ? `${number(counts.unresolved)} citas del total todavía no tienen uno de los tres resultados. Se conserva su estado anterior, sin reclasificarlas.` : '';
  if (dashboardLoaded) {
    document.querySelector('#dashboardStatus').textContent = counts.total
      ? 'Indicadores actualizados para el periodo y filtros seleccionados.'
      : 'No hay citas en el periodo y filtros seleccionados.';
  }
}

async function loadDashboard() {
  if (!window.AppointmentDashboard.canView(currentProfile)) return;
  const request = ++dashboardRequest;
  const { start, end } = window.AppointmentDashboard.period(dashboardDate, dashboardMode);
  dashboardData = [];
  dashboardSubjects = [];
  dashboardSources = [];
  dashboardLoaded = false;
  updateDashboardPeriod();
  renderDashboard();
  const status = document.querySelector('#dashboardStatus');
  status.classList.remove('error');
  status.textContent = 'Cargando indicadores…';
  document.querySelector('#dashboardRetry').hidden = true;
  document.querySelector('#dashboardResults').setAttribute('aria-busy', 'true');
  try {
    const { data, error } = await supabaseClient.rpc('appointment_outcome_dashboard', { period_start: start, period_end: end });
    if (request !== dashboardRequest || !window.AppointmentDashboard.canView(currentProfile)) return;
    if (error) throw error;
    const metrics = window.AppointmentDashboard.normalize(data);
    dashboardData = metrics.advisors;
    dashboardSubjects = metrics.subjects;
    dashboardSources = metrics.sources;
    dashboardLoaded = true;
    updateDashboardAdvisorOptions();
    renderDashboard();
  } catch (error) {
    if (request !== dashboardRequest || !window.AppointmentDashboard.canView(currentProfile)) return;
    const missingFunction = ['PGRST202', '42883'].includes(error?.code) || error?.message === 'DASHBOARD_OUTCOMES_UPDATE';
    status.textContent = missingFunction
      ? 'Falta actualizar los resultados del dashboard. Ejecuta supabase/add-appointment-outcomes-dashboard.sql en SQL Editor.'
      : error?.message === 'DASHBOARD_OUTCOMES_FORMAT' ? 'Los indicadores no llegaron completos o sus totales no coinciden. Vuelve a intentar; no se muestran ceros engañosos.'
      : readableError(error, 'No fue posible cargar los indicadores.');
    status.classList.add('error');
    document.querySelector('#dashboardRetry').hidden = false;
  } finally {
    if (request === dashboardRequest) document.querySelector('#dashboardResults').setAttribute('aria-busy', 'false');
  }
}

function invalidateDashboard() {
  if (!dashboardView.hidden && window.AppointmentDashboard.canView(currentProfile)) loadDashboard();
}

function navigateDashboard(amount) {
  dashboardDate = dashboardMode === 'month'
    ? moveMonth(dashboardDate, amount) : addDays(dashboardDate, amount * 7);
  loadDashboard();
}

function requiresCaptureSource(subject, appointment = null) {
  return subject === 'Visita comercial'
    && (!appointment || appointment.subject !== 'Visita comercial' || Boolean(appointment.captureSource));
}

function updateCaptureSourceRequirement(appointment = appointments.find(item => item.id === appointmentForm.elements.id.value)) {
  const source = appointmentForm.elements.captureSource;
  const subject = appointmentForm.elements.subject.value;
  source.required = requiresCaptureSource(subject, appointment);
  source.options[0].disabled = source.required;
  source.options[0].textContent = source.required ? 'Selecciona el medio' : appointment ? 'Sin registrar' : 'Selecciona el medio (opcional)';
  document.querySelector('#captureSourceHint').textContent = source.required
    ? 'Obligatorio para “Visita comercial”.'
    : subject === 'Visita comercial'
      ? 'Esta cita antigua no tiene medio registrado. Puedes añadirlo de forma opcional.'
      : 'Opcional para este asunto. Solo es obligatorio para “Visita comercial”.';
}

function openAppointmentDialog(appointment = null) {
  if (appointment && !canManageAppointment(appointment)) return;
  appointmentForm.reset();
  const subject = appointmentForm.elements.subject;
  subject.querySelectorAll('[data-legacy-subject]').forEach(option => option.remove());
  if (appointment?.subject && ![...subject.options].some(option => option.value === appointment.subject)) {
    const legacyOption = new Option(appointment.subject, appointment.subject);
    legacyOption.dataset.legacySubject = 'true';
    subject.add(legacyOption);
  }
  appointmentForm.elements.captureSource.value = appointment?.captureSource || '';
  appointmentForm.elements.id.value = appointment?.id || '';
  document.querySelector('#formDialogTitle').textContent = appointment ? 'Editar cita' : 'Nueva cita';
  document.querySelector('#formDialogDescription').textContent = appointment ? 'Actualiza la información y guarda los cambios.' : 'Registra los datos de la cita con el cliente.';
  document.querySelector('#saveAppointment').textContent = appointment ? 'Guardar cambios' : 'Guardar cita';

  if (appointment) {
    ['subject', 'date', 'time', 'client', 'phone', 'property', 'notes'].forEach(name => { appointmentForm.elements[name].value = appointment[name] || ''; });
    formTeam.value = appointment.team;
    setAdvisorOptions(formAdvisor, appointment.team, appointment.advisorId);
    if (![...formAdvisor.options].some(option => option.value === appointment.advisorId)) {
      formAdvisor.add(new Option(`${appointment.advisor} (inactivo)`, appointment.advisorId, true, true), 1);
    }
  } else if (!canAssignAppointments()) {
    formTeam.value = currentProfile.team;
    setAdvisorOptions(formAdvisor, currentProfile.team, currentProfile.id);
    appointmentForm.elements.date.value = dateKey(selectedDate);
    appointmentForm.elements.time.value = '10:00';
    appointmentForm.elements.status.value = '';
  } else if (canManageOwnTeamAppointments() && !isGlobalAppointmentManager()) {
    formTeam.value = currentProfile.team;
    setAdvisorOptions(formAdvisor, currentProfile.team);
    appointmentForm.elements.date.value = dateKey(selectedDate);
    appointmentForm.elements.time.value = '10:00';
    appointmentForm.elements.status.value = '';
  } else {
    const initialTeam = teamFilter.value === 'all' ? '' : teamFilter.value;
    formTeam.value = initialTeam;
    setAdvisorOptions(formAdvisor, initialTeam);
    appointmentForm.elements.date.value = dateKey(selectedDate);
    appointmentForm.elements.time.value = '10:00';
    appointmentForm.elements.status.value = '';
  }

  formTeam.disabled = !isGlobalAppointmentManager();
  appointmentForm.elements.status.value = appointmentOutcomeValues.includes(appointment?.status) ? appointment.status : '';
  appointmentForm.elements.status.disabled = !canAssignAppointments();
  document.querySelector('#appointmentStatusHint').textContent = appointment && !appointmentOutcomeValues.includes(appointment.status)
    ? `Estado anterior: ${statusLabel[appointment.status] || 'Sin resultado'}. Se conserva al guardar si no eliges un resultado.`
    : 'Actualiza el resultado cuando se conozca; una cita futura no se marca como realizada automáticamente.';
  updateCaptureSourceRequirement(appointment);
  propertyPicker.open(appointment);
  appointmentDialog.showModal();
  appointmentForm.elements.subject.focus();
}

function openDetails(id) {
  const appointment = appointments.find(item => item.id === id);
  if (!appointment) return;
  activeAppointmentId = id;
  const status = statusLabel[appointment.status] ? appointment.status : 'pending';
  const formattedDate = capitalize(new Intl.DateTimeFormat('es', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(parseDate(appointment.date)));
  const formattedTime = formatTime(appointment.time);
  const creatorName = appointmentCreators.get(appointment.createdBy) || 'Usuario no disponible';
  const propertyURL = window.SimiPropertyPicker.safeURL(appointment.simiPropertyURL);
  document.querySelector('#detailTitle').textContent = appointment.subject;
  document.querySelector('#detailSubtitle').textContent = `${teams[appointment.team] || 'Cita'} · ${formattedDate} a las ${formattedTime}`;
  document.querySelector('#detailContent').innerHTML = `<span class="detail-status ${status}">${statusLabel[status]}</span><div class="detail-grid">
    <div class="detail-item"><span class="detail-label">Cliente</span><p class="detail-value">${escapeHTML(appointment.client || 'No registrado')}</p></div>
    <div class="detail-item"><span class="detail-label">Teléfono</span><p class="detail-value">${escapeHTML(appointment.phone || 'No registrado')}</p></div>
    <div class="detail-item"><span class="detail-label">Asesor responsable</span><p class="detail-value advisor-inline advisor-color ${advisorColor(appointment.advisor, appointment.color)}">${escapeHTML(appointment.advisor || 'No registrado')}</p></div>
    <div class="detail-item"><span class="detail-label">Equipo</span><p class="detail-value">${escapeHTML(teams[appointment.team] || 'No registrado')}</p></div>
    <div class="detail-item"><span class="detail-label">Fecha y hora</span><p class="detail-value">${escapeHTML(formattedDate)}, ${escapeHTML(formattedTime)}</p></div>
    <div class="detail-item"><span class="detail-label">Creada por</span><p class="detail-value">${escapeHTML(creatorName)}</p></div>
    <div class="detail-item full"><span class="detail-label">Inmueble o dirección</span><p class="detail-value">${escapeHTML(appointment.property || 'No registrado')}</p>${propertyURL ? `<a class="action-link" href="${escapeHTML(propertyURL)}" target="_blank" rel="noopener noreferrer">Ver inmueble ${escapeHTML(appointment.simiPropertyCode)}</a>` : ''}</div>
    <div class="detail-item full"><span class="detail-label">Captado</span><p class="detail-value">${escapeHTML(appointment.captureSource || 'Sin registrar')}</p></div>
    <div class="detail-item full"><span class="detail-label">Notas</span><p class="detail-value detail-notes">${escapeHTML(appointment.notes || 'Sin notas adicionales.')}</p></div>
  </div>`;
  const phone = String(appointment.phone || '').replace(/\D/g, '');
  const whatsapp = document.querySelector('#whatsappAppointment');
  whatsapp.hidden = !phone;
  if (phone) whatsapp.href = `https://wa.me/${phone}?text=${encodeURIComponent(`Hola ${appointment.client}, te contacto para confirmar la cita de ${appointment.subject} el ${formattedDate} a las ${formattedTime}.`)}`;
  document.querySelector('#editAppointment').hidden = !canManageAppointment(appointment);
  document.querySelector('#deleteAppointment').hidden = !canDeleteAppointment(appointment);
  detailDialog.showModal();
}

async function saveAppointment(event) {
  event.preventDefault();
  if (appointmentSaving || !currentProfile?.active || currentProfile.must_change_password) return;
  const existingId = appointmentForm.elements.id.value;
  const existing = appointments.find(appointment => appointment.id === existingId);
  const payload = {
    appointment_date: appointmentForm.elements.date.value,
    appointment_time: appointmentForm.elements.time.value,
    subject: appointmentForm.elements.subject.value.trim(),
    client: appointmentForm.elements.client.value.trim(),
    phone: appointmentForm.elements.phone.value.trim(),
    advisor_id: formAdvisor.value,
    property: appointmentForm.elements.property.value.trim(),
    capture_source: appointmentForm.elements.captureSource.value || null,
    status: appointmentForm.elements.status.value || existing?.status || 'pending',
    notes: appointmentForm.elements.notes.value.trim(),
  };
  if (!payload.subject) {
    showToast('Selecciona el asunto de la cita.');
    appointmentForm.elements.subject.focus();
    return;
  }
  if (requiresCaptureSource(payload.subject, existing) && !payload.capture_source) {
    showToast('Selecciona por dónde fue captada la cita.');
    appointmentForm.elements.captureSource.focus();
    return;
  }
  if (!payload.advisor_id) {
    showToast('Selecciona un asesor responsable.');
    return;
  }
  const selectedAdvisor = advisors.find(advisor => advisor.id === payload.advisor_id);
  if (!selectedAdvisor) {
    showToast('El asesor seleccionado no está disponible.');
    return;
  }
  if (existingId) {
    if (!existing || !canManageAppointment(existing)) {
      showToast('No tienes permiso para editar esta cita.');
      return;
    }
  } else if (!canAssignAppointments() && payload.advisor_id !== currentProfile.id) {
    showToast('Solo puedes crear citas asignadas a tu usuario.');
    return;
  }
  if (canManageOwnTeamAppointments() && !isGlobalAppointmentManager() && selectedAdvisor.team !== currentProfile.team) {
    showToast(`Solo puedes gestionar citas de ${teams[currentProfile.team]}.`);
    return;
  }
  const selectedProperty = propertyPicker.snapshot();
  if (selectedProperty || existing?.simiPropertyCode) {
    payload.simi_property_code = selectedProperty?.code || null;
    payload.simi_property_url = selectedProperty?.url || null;
  }

  const session = appointmentsSession;
  const write = ++appointmentWriteRequest;
  appointmentSaving = true;
  setBusy(appointmentForm, true);
  let data;
  let error;
  try {
    const query = existingId
      ? supabaseClient.from('appointments').update(payload).eq('id', existingId)
      : supabaseClient.from('appointments').insert(payload);
    ({ data, error } = await query.select().single());
  } catch (failure) {
    error = failure;
  } finally {
    if (write === appointmentWriteRequest) {
      setBusy(appointmentForm, false);
      appointmentSaving = false;
    }
  }
  if (session !== appointmentsSession || write !== appointmentWriteRequest) return;
  if (error) {
    if (error.code === '22P02' && /rented|appointment_status/i.test(error.message || '')) {
      showToast('Falta activar Arrendado en Supabase. Ejecuta supabase/add-appointment-outcomes-dashboard.sql. El formulario se conserva.');
      return;
    }
    if (['PGRST204', '42703'].includes(error.code) && /simi_property_(code|url)/i.test(error.message || '')) {
      showToast('Falta ejecutar supabase/add-simi-property-catalog.sql. Tu formulario se conserva; también puedes usar la dirección manual.');
      return;
    }
    const missingCaptureSource = ['PGRST204', '42703'].includes(error.code) && /capture_source/i.test(error.message || '');
    showToast(missingCaptureSource
      ? 'Falta activar Captado en Supabase. Sigue los dos scripts de captación indicados en SUPABASE-SETUP.md.'
      : readableError(error));
    return;
  }
  if (!data || typeof data.id !== 'string' || !data.id) {
    showToast('El servidor no confirmó los datos de la cita. Verifica la agenda antes de volver a guardarla para evitar duplicados.');
    return;
  }
  appointmentsRequest += 1;
  const saved = mapAppointment(data);
  const index = appointments.findIndex(item => item.id === saved.id);
  if (index >= 0) appointments[index] = saved; else appointments.push(saved);
  selectedDate = parseDate(saved.date);
  cursorDate = new Date(selectedDate);
  appointmentDialog.close();
  render();
  invalidateDashboard();
  showToast(existingId ? 'Los cambios fueron guardados.' : 'La cita quedó guardada en la agenda.');
  void loadAppointments();
}

async function deleteAppointment() {
  const appointment = appointments.find(item => item.id === activeAppointmentId);
  if (!appointment || !canDeleteAppointment(appointment) || !window.confirm(`¿Eliminar la cita "${appointment.subject}"? Esta acción no se puede deshacer.`)) return;
  const session = appointmentsSession;
  const { error } = await supabaseClient.from('appointments').delete().eq('id', appointment.id);
  if (session !== appointmentsSession) return;
  if (error) {
    showToast(readableError(error));
    return;
  }
  appointmentsRequest += 1;
  appointments = appointments.filter(item => item.id !== appointment.id);
  detailDialog.close();
  activeAppointmentId = null;
  render();
  invalidateDashboard();
  showToast('La cita fue eliminada.');
  void loadAppointments();
}

function showSection(section) {
  if (section === 'admin' && currentProfile?.role !== 'admin') section = 'agenda';
  if (section === 'dashboard' && !window.AppointmentDashboard.canView(currentProfile)) section = 'agenda';
  agendaView.hidden = section !== 'agenda';
  advisorsView.hidden = section !== 'advisors';
  adminView.hidden = section !== 'admin';
  dashboardView.hidden = section !== 'dashboard';
  document.querySelectorAll('[data-section]').forEach(button => {
    const active = button.dataset.section === section;
    button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
  });
  if (section === 'admin') {
    loadUsers();
    loadExternalAdvisors();
  }
  if (section === 'dashboard') loadDashboard();
}

async function loadUsers() {
  const usersList = document.querySelector('#usersList');
  usersList.innerHTML = '<li class="loading-state">Cargando usuarios...</li>';
  const { data, error } = await supabaseClient.from('profiles').select('*').order('full_name');
  if (error) {
    usersList.innerHTML = `<li class="loading-state">${escapeHTML(readableError(error))}</li>`;
    return;
  }
  usersList.innerHTML = data.length ? data.map(profile => `<li class="user-row">
    <div class="user-identity"><strong>${escapeHTML(profile.full_name)}</strong><span>${profile.team ? teams[profile.team] : 'Sin equipo'}</span></div>
    <div class="user-identity user-email"><span>${escapeHTML(profile.email)}</span></div>
    <span class="role-badge">${roleLabels[profile.role]}</span>
    <button class="ghost user-toggle" type="button" data-user-id="${profile.id}" data-active="${profile.active}" ${profile.id === currentProfile.id ? 'disabled' : ''}><span class="status-dot ${profile.active ? 'active' : ''}">${profile.active ? 'Activo' : 'Inactivo'}</span></button>
  </li>`).join('') : '<li class="loading-state">No hay usuarios registrados.</li>';
}

async function toggleUser(button) {
  const active = button.dataset.active === 'true';
  button.disabled = true;
  const { error } = await supabaseClient.from('profiles').update({ active: !active }).eq('id', button.dataset.userId);
  if (error) showToast(readableError(error)); else {
    showToast(active ? 'Usuario desactivado.' : 'Usuario activado.');
    await Promise.all([loadUsers(), loadAdvisors()]);
    refreshAdvisorUI();
  }
  button.disabled = false;
}

async function loadExternalAdvisors() {
  const advisorsList = document.querySelector('#externalAdvisorsList');
  advisorsList.innerHTML = '<li class="loading-state">Cargando asesores...</li>';
  const { data, error } = await supabaseClient
    .from('advisors')
    .select('id, profile_id, full_name, team, color, active')
    .order('full_name');
  if (error) {
    advisorsList.innerHTML = `<li class="loading-state">${escapeHTML(readableError(error))}</li>`;
    return;
  }
  reservedAdvisorColors = new Set(data.map(advisor => advisor.color));
  updateAvailableAdvisorColors();
  const externalAdvisors = data.filter(advisor => !advisor.profile_id);
  advisorsList.innerHTML = externalAdvisors.length ? externalAdvisors.map(advisor => `<li class="user-row external-advisor-row">
    <div class="user-identity"><strong>${escapeHTML(advisor.full_name)}</strong><span>Sin acceso al sistema</span></div>
    <span class="role-badge advisor-color ${advisor.color}">${escapeHTML(teams[advisor.team])}</span>
    <button class="ghost external-advisor-toggle" type="button" data-advisor-id="${advisor.id}" data-active="${advisor.active}"><span class="status-dot ${advisor.active ? 'active' : ''}">${advisor.active ? 'Activo' : 'Inactivo'}</span></button>
  </li>`).join('') : '<li class="loading-state">No hay asesores sin acceso registrados.</li>';
}

async function toggleExternalAdvisor(button) {
  const active = button.dataset.active === 'true';
  button.disabled = true;
  const { error } = await supabaseClient.from('advisors').update({ active: !active }).eq('id', button.dataset.advisorId);
  if (error) {
    showToast(readableError(error));
    button.disabled = false;
    return;
  }
  showToast(active ? 'Asesor desactivado.' : 'Asesor activado.');
  await Promise.all([loadExternalAdvisors(), loadAdvisors()]);
  refreshAdvisorUI();
}

async function createExternalAdvisor(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  const payload = {
    full_name: data.get('full_name').trim(),
    team: data.get('team'),
    color: data.get('color'),
  };
  const message = document.querySelector('#createExternalAdvisorMessage');
  message.textContent = '';
  if (!payload.full_name) {
    message.textContent = 'Escribe el nombre del asesor.';
    return;
  }
  if (!payload.color || reservedAdvisorColors.has(payload.color)) {
    message.textContent = 'Selecciona un color disponible.';
    return;
  }
  setBusy(form, true);
  const { error } = await supabaseClient.from('advisors').insert(payload);
  setBusy(form, false);
  if (error) {
    message.textContent = readableError(error);
    if (isAdvisorColorConflict(error.message)) await loadExternalAdvisors();
    return;
  }
  form.reset();
  showToast('Asesor agregado sin acceso al sistema.');
  await Promise.all([loadExternalAdvisors(), loadAdvisors()]);
  refreshAdvisorUI();
}

async function createUser(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  const role = data.get('role');
  const payload = {
    full_name: data.get('full_name').trim(),
    email: data.get('email').trim().toLowerCase(),
    role,
    team: role === 'advisor' ? data.get('team') : null,
    color: role === 'advisor' ? data.get('color') : null,
    temporary_password: data.get('temporary_password'),
  };
  const message = document.querySelector('#createUserMessage');
  message.textContent = '';
  if (role === 'advisor' && (!payload.color || reservedAdvisorColors.has(payload.color))) {
    message.textContent = 'Selecciona un color disponible.';
    return;
  }
  setBusy(form, true);
  const { error } = await supabaseClient.functions.invoke('admin-create-user', { body: payload });
  setBusy(form, false);
  if (error) {
    let functionMessage = error.message;
    try { functionMessage = (await error.context.json()).error || functionMessage; } catch {}
    message.textContent = readableError({ message: functionMessage });
    if (isAdvisorColorConflict(functionMessage)) await loadExternalAdvisors();
    return;
  }
  form.reset();
  updateCreateUserFields();
  showToast('Usuario creado con contraseña temporal.');
  await Promise.all([loadUsers(), loadExternalAdvisors(), loadAdvisors()]);
  refreshAdvisorUI();
}

function updateAvailableAdvisorColors() {
  document.querySelectorAll('#newUserColor, #externalAdvisorColor').forEach(select => {
    [...select.options].forEach(option => {
      const label = option.dataset.label || option.textContent.replace(/ · asignado$/, '');
      option.dataset.label = label;
      option.disabled = reservedAdvisorColors.has(option.value);
      option.textContent = option.disabled ? `${label} · asignado` : label;
    });
    const selectedOption = [...select.options].find(option => option.value === select.value);
    if (!selectedOption || selectedOption.disabled) {
      select.value = [...select.options].find(option => !option.disabled)?.value || '';
    }
  });

  const externalColor = document.querySelector('#externalAdvisorColor');
  const hasAvailableColor = [...externalColor.options].some(option => !option.disabled);
  externalColor.disabled = !hasAvailableColor;
  document.querySelector('#createExternalAdvisorForm button[type="submit"]').disabled = !hasAvailableColor;
  const externalMessage = document.querySelector('#createExternalAdvisorMessage');
  const exhaustedMessage = 'No hay colores disponibles en la paleta.';
  if (!hasAvailableColor) externalMessage.textContent = exhaustedMessage;
  else if (externalMessage.textContent === exhaustedMessage) externalMessage.textContent = '';
  updateCreateUserFields();
}

function updateCreateUserFields() {
  const isAdvisor = document.querySelector('#newUserRole').value === 'advisor';
  const userColor = document.querySelector('#newUserColor');
  const hasAvailableColor = [...userColor.options].some(option => !option.disabled);
  document.querySelectorAll('.advisor-setting').forEach(field => {
    field.hidden = !isAdvisor;
    const select = field.querySelector('select');
    const hasAvailableOption = [...select.options].some(option => !option.disabled);
    select.disabled = !isAdvisor || !hasAvailableOption;
  });
  document.querySelector('#createUserForm button[type="submit"]').disabled = isAdvisor && !hasAvailableColor;
  const message = document.querySelector('#createUserMessage');
  const exhaustedMessage = 'No hay colores disponibles en la paleta.';
  if (isAdvisor && !hasAvailableColor) message.textContent = exhaustedMessage;
  else if (message.textContent === exhaustedMessage) message.textContent = '';
}

function generatePassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const values = crypto.getRandomValues(new Uint32Array(12));
  document.querySelector('#temporaryPassword').value = `Ftf-${[...values].map(value => alphabet[value % alphabet.length]).join('')}!7`;
}

function setPasswordVisibility(input, visible) {
  const toggle = document.querySelector(`[data-password-toggle="${input.id}"]`);
  input.type = visible ? 'text' : 'password';
  if (!toggle) return;
  const label = visible ? 'Ocultar contraseña' : 'Mostrar contraseña';
  toggle.setAttribute('aria-pressed', String(visible));
  toggle.setAttribute('aria-label', label);
  toggle.title = label;
}

function resetPasswordFields(form) {
  form.querySelectorAll('[data-password-input]').forEach(input => {
    setPasswordVisibility(input, false);
    const hint = document.querySelector(`#${input.dataset.capsLockHint}`);
    if (hint) hint.hidden = true;
  });
}

document.querySelectorAll('[data-password-toggle]').forEach(toggle => {
  toggle.addEventListener('pointerdown', event => event.preventDefault());
  toggle.addEventListener('click', () => {
    const input = document.querySelector(`#${toggle.dataset.passwordToggle}`);
    if (!input) return;
    setPasswordVisibility(input, input.type === 'password');
  });
});

document.querySelectorAll('[data-caps-lock-hint]').forEach(input => {
  const hint = document.querySelector(`#${input.dataset.capsLockHint}`);
  const updateCapsLock = event => {
    if (hint && typeof event.getModifierState === 'function') hint.hidden = !event.getModifierState('CapsLock');
  };
  input.addEventListener('keydown', updateCapsLock);
  input.addEventListener('keyup', updateCapsLock);
  input.addEventListener('blur', () => { if (hint) hint.hidden = true; });
});

async function changePassword(event) {
  event.preventDefault();
  const password = event.currentTarget.elements.password.value;
  const confirmation = event.currentTarget.elements.confirm_password.value;
  const message = document.querySelector('#passwordMessage');
  message.textContent = '';
  if (password !== confirmation) {
    message.textContent = 'Las contraseñas no coinciden.';
    return;
  }
  setBusy(event.currentTarget, true);
  const { error } = await supabaseClient.functions.invoke('change-password', { body: { password } });
  setBusy(event.currentTarget, false);
  if (error) {
    let functionMessage = error.message;
    try { functionMessage = (await error.context.json()).error || functionMessage; } catch {}
    message.textContent = readableError({ message: functionMessage });
    return;
  }
  currentProfile.must_change_password = false;
  passwordDialog.close();
  event.currentTarget.reset();
  resetPasswordFields(event.currentTarget);
  await activateWorkspace();
  showToast('Contraseña actualizada correctamente.');
}

loginForm.addEventListener('submit', async event => {
  event.preventDefault();
  loginMessage.textContent = '';
  setBusy(loginForm, true);
  const { data, error } = await supabaseClient.auth.signInWithPassword({
    email: loginForm.elements.email.value.trim().toLowerCase(),
    password: loginForm.elements.password.value,
  });
  setBusy(loginForm, false);
  if (error) {
    loginMessage.textContent = readableError(error);
    return;
  }
  await startSession(data.user);
});

document.querySelector('#logoutButton').addEventListener('click', async () => {
  const channel = appointmentsChannel;
  appointmentsChannel = null;
  showAuth();
  setBusy(loginForm, true);
  try {
    if (channel) await supabaseClient.removeChannel(channel);
    await supabaseClient.auth.signOut();
    loginForm.reset();
    resetPasswordFields(loginForm);
  } finally {
    setBusy(loginForm, false);
  }
});
document.querySelector('#newAppointment').addEventListener('click', () => openAppointmentDialog());
appointmentDialog.querySelector('.close').addEventListener('click', () => appointmentDialog.close());
appointmentDialog.querySelector('.close-secondary').addEventListener('click', () => appointmentDialog.close());
appointmentDialog.addEventListener('click', event => { if (event.target === appointmentDialog) appointmentDialog.close(); });
appointmentForm.addEventListener('submit', saveAppointment);
detailDialog.querySelector('.detail-close').addEventListener('click', () => detailDialog.close());
document.querySelector('#closeDetail').addEventListener('click', () => detailDialog.close());
detailDialog.addEventListener('click', event => { if (event.target === detailDialog) detailDialog.close(); });
document.querySelector('#editAppointment').addEventListener('click', () => {
  const appointment = appointments.find(item => item.id === activeAppointmentId);
  if (!appointment) return;
  detailDialog.close();
  openAppointmentDialog(appointment);
});
document.querySelector('#deleteAppointment').addEventListener('click', deleteAppointment);
passwordDialog.addEventListener('cancel', event => event.preventDefault());
document.querySelector('#passwordForm').addEventListener('submit', changePassword);
document.querySelectorAll('[data-section]').forEach(button => button.addEventListener('click', () => showSection(button.dataset.section)));
document.querySelectorAll('#dashboardPeriodSwitcher button').forEach(button => button.addEventListener('click', () => {
  dashboardMode = button.dataset.period;
  loadDashboard();
}));
document.querySelector('#dashboardPrevious').addEventListener('click', () => navigateDashboard(-1));
document.querySelector('#dashboardNext').addEventListener('click', () => navigateDashboard(1));
document.querySelector('#dashboardToday').addEventListener('click', () => {
  dashboardDate = startOfDay(new Date());
  loadDashboard();
});
document.querySelector('#dashboardDate').addEventListener('change', event => {
  if (!event.target.value || !event.target.validity.valid) return;
  dashboardDate = parseDate(dashboardMode === 'month' ? `${event.target.value}-01` : event.target.value);
  loadDashboard();
});
dashboardTeam.addEventListener('change', () => { updateDashboardAdvisorOptions(); renderDashboard(); });
dashboardAdvisor.addEventListener('change', renderDashboard);
document.querySelector('#dashboardRetry').addEventListener('click', loadDashboard);
document.querySelector('#advisorsByTeam').addEventListener('click', event => {
  const card = event.target.closest('[data-advisor-id]');
  if (!card) return;
  teamFilter.value = card.dataset.team;
  setAdvisorOptions(advisorFilter, card.dataset.team, card.dataset.advisorId, true);
  advisorFilter.value = card.dataset.advisorId;
  showSection('agenda');
  render();
  showToast(`Mostrando las citas de ${card.querySelector('.advisor-name').textContent}.`);
});
teamFilter.addEventListener('change', () => { setAdvisorOptions(advisorFilter, teamFilter.value, 'all', true); render(); });
advisorFilter.addEventListener('change', render);
formTeam.addEventListener('change', () => { setAdvisorOptions(formAdvisor, formTeam.value); propertyPicker.updateContext(); });
appointmentForm.elements.subject.addEventListener('change', () => { updateCaptureSourceRequirement(); propertyPicker.updateContext(); });
grid.addEventListener('click', event => {
  const appointmentTarget = event.target.closest('[data-appointment-id]');
  if (appointmentTarget) {
    selectedDate = parseDate(appointmentTarget.dataset.date);
    render();
    openDetails(appointmentTarget.dataset.appointmentId);
    return;
  }
  const target = event.target.closest('[data-date]');
  if (!target) return;
  selectedDate = parseDate(target.dataset.date);
  if (currentView === 'month' && selectedDate.getMonth() !== cursorDate.getMonth()) cursorDate = new Date(selectedDate);
  render();
});
agenda.addEventListener('click', event => {
  const target = event.target.closest('[data-appointment-id]');
  if (target) openDetails(target.dataset.appointmentId);
});
document.querySelector('#todayButton').addEventListener('click', () => {
  cursorDate = startOfDay(new Date());
  selectedDate = new Date(cursorDate);
  render();
});
document.querySelectorAll('#viewSwitcher button').forEach(button => button.addEventListener('click', () => {
  document.querySelectorAll('#viewSwitcher button').forEach(control => control.classList.remove('active'));
  button.classList.add('active');
  currentView = button.dataset.view;
  cursorDate = new Date(selectedDate);
  render();
}));
function navigatePeriod(amount) {
  if (currentView === 'month') {
    cursorDate = moveMonth(cursorDate, amount);
    selectedDate = moveMonth(selectedDate, amount);
  } else {
    cursorDate = addDays(cursorDate, amount * 7);
    selectedDate = addDays(selectedDate, amount * 7);
  }
  render();
}
document.querySelector('#prevWeek').addEventListener('click', () => navigatePeriod(-1));
document.querySelector('#nextWeek').addEventListener('click', () => navigatePeriod(1));
document.querySelector('#usersList').addEventListener('click', event => {
  const button = event.target.closest('.user-toggle');
  if (button) toggleUser(button);
});
document.querySelector('#externalAdvisorsList').addEventListener('click', event => {
  const button = event.target.closest('.external-advisor-toggle');
  if (button) toggleExternalAdvisor(button);
});
document.querySelector('#createUserForm').addEventListener('submit', createUser);
document.querySelector('#createExternalAdvisorForm').addEventListener('submit', createExternalAdvisor);
document.querySelector('#newUserRole').addEventListener('change', updateCreateUserFields);
document.querySelector('#generatePassword').addEventListener('click', generatePassword);

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/service-worker.js').catch(error => {
      console.warn('No fue posible activar el modo instalable.', error);
    });
  });
}

(async function initialize() {
  updateCreateUserFields();
  const { data: { session }, error } = await supabaseClient.auth.getSession();
  if (error || !session) {
    showAuth(error ? readableError(error) : '');
    return;
  }
  await startSession(session.user);
})();
