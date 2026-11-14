(function (root) {
  function dateKey(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }

  function period(date, mode) {
    const start = new Date(date.getFullYear(), date.getMonth(), mode === 'month' ? 1 : date.getDate());
    if (mode !== 'month') start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
    const end = new Date(start);
    if (mode === 'month') end.setMonth(end.getMonth() + 1);
    else end.setDate(end.getDate() + 7);
    return { start: dateKey(start), end: dateKey(end) };
  }

  function filterRows(rows, team = 'all', advisor = 'all') {
    return rows.filter(row => (team === 'all' || row.team === team)
      && (advisor === 'all' || row.advisor_id === advisor));
  }

  function totals(rows) {
    return rows.reduce((result, row) => ({
      total: result.total + Number(row.total),
      completed: result.completed + Number(row.completed),
    }), { total: 0, completed: 0 });
  }

  function canView(profile) {
    return profile?.active === true && profile.must_change_password === false
      && ['admin', 'supervisor'].includes(profile.role);
  }

  const dashboard = { period, filterRows, totals, canView };
  if (typeof module !== 'undefined' && module.exports) module.exports = dashboard;
  else root.AppointmentDashboard = dashboard;
})(globalThis);
