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
      rented: result.rented + Number(row.rented || 0),
      cancelled: result.cancelled + Number(row.cancelled || 0),
      unresolved: result.unresolved + Number(row.unresolved ?? (Number(row.total) - Number(row.completed) - Number(row.rented || 0) - Number(row.cancelled || 0))),
    }), { total: 0, completed: 0, rented: 0, cancelled: 0, unresolved: 0 });
  }

  const metrics = ['total', 'completed', 'rented', 'cancelled', 'unresolved'];
  function normalize(data) {
    if (!data || data.protocol !== 'outcomes-v1' || !['advisors', 'subjects', 'sources'].every(key => Array.isArray(data[key]))) {
      throw new Error('DASHBOARD_OUTCOMES_UPDATE');
    }
    const result = {};
    for (const group of ['advisors', 'subjects', 'sources']) {
      const seen = new Set();
      result[group] = data[group].map(row => {
        if (!row || typeof row.advisor_id !== 'string' || !row.advisor_id || !['rental', 'sales'].includes(row.team)
          || (group === 'advisors' ? typeof row.advisor_name !== 'string' || typeof row.active !== 'boolean'
            : typeof row.label !== 'string' || !row.label || row.label.length > 160)) throw new Error('DASHBOARD_OUTCOMES_FORMAT');
        const item = { advisor_id: row.advisor_id, team: row.team };
        if (group === 'advisors') Object.assign(item, { advisor_name: row.advisor_name, active: row.active });
        else item.label = row.label;
        for (const key of metrics) {
          const raw = row[key];
          const value = Number(raw);
          if (!['number', 'string'].includes(typeof raw) || (typeof raw === 'string' && !/^\d+$/.test(raw))
            || !Number.isSafeInteger(value) || value < 0) throw new Error('DASHBOARD_OUTCOMES_FORMAT');
          item[key] = value;
        }
        if (item.total !== item.completed + item.rented + item.cancelled + item.unresolved) throw new Error('DASHBOARD_OUTCOMES_FORMAT');
        const key = JSON.stringify([item.advisor_id, item.team, item.label]);
        if (seen.has(key)) throw new Error('DASHBOARD_OUTCOMES_FORMAT');
        seen.add(key);
        return item;
      });
    }
    const advisors = new Map(result.advisors.map(row => [JSON.stringify([row.advisor_id, row.team]), row]));
    for (const group of ['subjects', 'sources']) {
      const sums = new Map();
      for (const row of result[group]) {
        const key = JSON.stringify([row.advisor_id, row.team]);
        if (!advisors.has(key)) throw new Error('DASHBOARD_OUTCOMES_FORMAT');
        const sum = sums.get(key) || totals([]);
        for (const field of metrics) sum[field] += row[field];
        sums.set(key, sum);
      }
      for (const [key, advisor] of advisors) {
        const sum = sums.get(key) || totals([]);
        if (metrics.some(field => advisor[field] !== sum[field])) throw new Error('DASHBOARD_OUTCOMES_FORMAT');
      }
    }
    return result;
  }

  function groupCategories(rows, team = 'all', advisor = 'all') {
    const groups = new Map();
    for (const row of filterRows(rows, team, advisor)) {
      const counts = groups.get(row.label) || { label: row.label, ...totals([]) };
      for (const field of metrics) counts[field] += Number(row[field]);
      groups.set(row.label, counts);
    }
    return [...groups.values()].sort((a, b) => b.total - a.total || a.label.localeCompare(b.label, 'es'));
  }

  function canView(profile) {
    return profile?.active === true && profile.must_change_password === false
      && ['admin', 'supervisor'].includes(profile.role);
  }

  const dashboard = { period, filterRows, totals, normalize, groupCategories, canView };
  if (typeof module !== 'undefined' && module.exports) module.exports = dashboard;
  else root.AppointmentDashboard = dashboard;
})(globalThis);
