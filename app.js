const { url: SUPABASE_URL, publishableKey: SUPABASE_KEY } = window.SUPABASE_CONFIG;
const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

const teams = { rental: 'Arrendamientos', sales: 'Ventas' };
const roleLabels = { admin: 'Administrador', supervisor: 'Supervisora', advisor: 'Asesor' };
const statusLabel = { pending: 'Pendiente', confirmed: 'Confirmada', completed: 'Realizada', cancelled: 'Cancelada' };

let appointments = [];
let advisors = [];
let reservedAdvisorColors = new Set();
let currentProfile = null;
let currentUser = null;
let appointmentsChannel = null;
let currentView = 'week';
let cursorDate = startOfDay(new Date());
let selectedDate = new Date(cursorDate);
let activeAppointmentId = null;

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
const periodLabel = document.querySelector('#periodLabel');
const dayLabel = document.querySelector('#dayLabel');

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
  currentUser = user;
  const { data: profile, error } = await supabaseClient.from('profiles').select('*').eq('id', user.id).single();
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
  authView.hidden = true;
  appView.hidden = false;
  document.querySelector('#currentUserName').textContent = profile.full_name;
  document.querySelector('#currentUserRole').textContent = roleLabels[profile.role];
  document.querySelector('#logoutButton').textContent = initials(profile.full_name);
  document.querySelector('#logoutButton').setAttribute('aria-label', `Cerrar sesión de ${profile.full_name}`);
  document.querySelectorAll('.admin-only').forEach(control => { control.hidden = profile.role !== 'admin'; });

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
  await Promise.all([loadAdvisors(), loadAppointments()]);
  setAdvisorOptions(advisorFilter, 'all', 'all', true);
  renderAdvisors();
  render();
  subscribeToAppointments();
}

function showAuth(message = '') {
  currentProfile = null;
  currentUser = null;
  appView.hidden = true;
  authView.hidden = false;
  loginMessage.textContent = message;
}

async function loadAdvisors() {
  const { data, error } = await supabaseClient.rpc('list_advisors');
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
  const { data, error } = await supabaseClient
    .from('appointments')
    .select('*')
    .order('appointment_date')
    .order('appointment_time');
  if (error) {
    appointments = [];
    showToast(readableError(error, 'No fue posible cargar las citas.'));
    return;
  }
  appointments = (data || []).map(mapAppointment);
  render();
}

function subscribeToAppointments() {
  if (appointmentsChannel) supabaseClient.removeChannel(appointmentsChannel);
  appointmentsChannel = supabaseClient
    .channel('appointments-live')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'appointments' }, () => loadAppointments())
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

function openAppointmentDialog(appointment = null) {
  if (appointment && !canManageAppointment(appointment)) return;
  appointmentForm.reset();
  appointmentForm.elements.id.value = appointment?.id || '';
  document.querySelector('#formDialogTitle').textContent = appointment ? 'Editar cita' : 'Nueva cita';
  document.querySelector('#formDialogDescription').textContent = appointment ? 'Actualiza la información y guarda los cambios.' : 'Registra los datos de la cita con el cliente.';
  document.querySelector('#saveAppointment').textContent = appointment ? 'Guardar cambios' : 'Guardar cita';

  if (appointment) {
    ['subject', 'date', 'time', 'client', 'phone', 'property', 'status', 'notes'].forEach(name => { appointmentForm.elements[name].value = appointment[name] || ''; });
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
    appointmentForm.elements.status.value = 'pending';
  } else if (canManageOwnTeamAppointments() && !isGlobalAppointmentManager()) {
    formTeam.value = currentProfile.team;
    setAdvisorOptions(formAdvisor, currentProfile.team);
    appointmentForm.elements.date.value = dateKey(selectedDate);
    appointmentForm.elements.time.value = '10:00';
    appointmentForm.elements.status.value = 'pending';
  } else {
    const initialTeam = teamFilter.value === 'all' ? '' : teamFilter.value;
    formTeam.value = initialTeam;
    setAdvisorOptions(formAdvisor, initialTeam);
    appointmentForm.elements.date.value = dateKey(selectedDate);
    appointmentForm.elements.time.value = '10:00';
    appointmentForm.elements.status.value = 'pending';
  }

  formTeam.disabled = !isGlobalAppointmentManager();
  appointmentForm.elements.status.disabled = !canAssignAppointments();
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
  document.querySelector('#detailTitle').textContent = appointment.subject;
  document.querySelector('#detailSubtitle').textContent = `${teams[appointment.team] || 'Cita'} · ${formattedDate} a las ${formattedTime}`;
  document.querySelector('#detailContent').innerHTML = `<span class="detail-status ${status}">${statusLabel[status]}</span><div class="detail-grid">
    <div class="detail-item"><span class="detail-label">Cliente</span><p class="detail-value">${escapeHTML(appointment.client || 'No registrado')}</p></div>
    <div class="detail-item"><span class="detail-label">Teléfono</span><p class="detail-value">${escapeHTML(appointment.phone || 'No registrado')}</p></div>
    <div class="detail-item"><span class="detail-label">Asesor responsable</span><p class="detail-value advisor-inline advisor-color ${advisorColor(appointment.advisor, appointment.color)}">${escapeHTML(appointment.advisor || 'No registrado')}</p></div>
    <div class="detail-item"><span class="detail-label">Equipo</span><p class="detail-value">${escapeHTML(teams[appointment.team] || 'No registrado')}</p></div>
    <div class="detail-item"><span class="detail-label">Fecha y hora</span><p class="detail-value">${escapeHTML(formattedDate)}, ${escapeHTML(formattedTime)}</p></div>
    <div class="detail-item full"><span class="detail-label">Inmueble o dirección</span><p class="detail-value">${escapeHTML(appointment.property || 'No registrado')}</p></div>
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
  const existingId = appointmentForm.elements.id.value;
  const payload = {
    appointment_date: appointmentForm.elements.date.value,
    appointment_time: appointmentForm.elements.time.value,
    subject: appointmentForm.elements.subject.value.trim(),
    client: appointmentForm.elements.client.value.trim(),
    phone: appointmentForm.elements.phone.value.trim(),
    advisor_id: formAdvisor.value,
    property: appointmentForm.elements.property.value.trim(),
    status: appointmentForm.elements.status.value,
    notes: appointmentForm.elements.notes.value.trim(),
  };
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
    const existing = appointments.find(appointment => appointment.id === existingId);
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

  setBusy(appointmentForm, true);
  const query = existingId
    ? supabaseClient.from('appointments').update(payload).eq('id', existingId)
    : supabaseClient.from('appointments').insert(payload);
  const { data, error } = await query.select().single();
  setBusy(appointmentForm, false);
  if (error) {
    showToast(readableError(error));
    return;
  }
  const saved = mapAppointment(data);
  const index = appointments.findIndex(item => item.id === saved.id);
  if (index >= 0) appointments[index] = saved; else appointments.push(saved);
  selectedDate = parseDate(saved.date);
  cursorDate = new Date(selectedDate);
  appointmentDialog.close();
  render();
  showToast(existingId ? 'Los cambios fueron guardados.' : 'La cita quedó guardada en la agenda.');
}

async function deleteAppointment() {
  const appointment = appointments.find(item => item.id === activeAppointmentId);
  if (!appointment || !canDeleteAppointment(appointment) || !window.confirm(`¿Eliminar la cita "${appointment.subject}"? Esta acción no se puede deshacer.`)) return;
  const { error } = await supabaseClient.from('appointments').delete().eq('id', appointment.id);
  if (error) {
    showToast(readableError(error));
    return;
  }
  appointments = appointments.filter(item => item.id !== appointment.id);
  detailDialog.close();
  activeAppointmentId = null;
  render();
  showToast('La cita fue eliminada.');
}

function showSection(section) {
  if (section === 'admin' && currentProfile?.role !== 'admin') section = 'agenda';
  agendaView.hidden = section !== 'agenda';
  advisorsView.hidden = section !== 'advisors';
  adminView.hidden = section !== 'admin';
  document.querySelectorAll('[data-section]').forEach(button => {
    const active = button.dataset.section === section;
    button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
  });
  if (section === 'admin') {
    loadUsers();
    loadExternalAdvisors();
  }
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
  if (appointmentsChannel) await supabaseClient.removeChannel(appointmentsChannel);
  await supabaseClient.auth.signOut();
  showAuth();
  loginForm.reset();
  resetPasswordFields(loginForm);
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
formTeam.addEventListener('change', () => setAdvisorOptions(formAdvisor, formTeam.value));
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
