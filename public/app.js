/* ============================================================
   Leave Tracker — frontend (talks to the secure backend API)
   ============================================================ */

(() => {
  'use strict';

  const THEME_KEY = 'hlt_theme';
  const PALETTE = ['#6366f1', '#ec4899', '#10b981', '#f59e0b', '#0ea5e9', '#8b5cf6', '#ef4444', '#14b8a6'];

  // Leave types. `counts` = whether it draws down the annual allowance.
  const LEAVE_TYPES = {
    holiday: { label: 'Holiday', icon: '🌴', color: '#6366f1', counts: true },
    sick:    { label: 'Sick',    icon: '🤒', color: '#ef4444', counts: false },
    remote:  { label: 'Remote',  icon: '🏠', color: '#0ea5e9', counts: false },
    other:   { label: 'Other',   icon: '📌', color: '#f59e0b', counts: false },
  };
  const leaveType = (t) => LEAVE_TYPES[t] || LEAVE_TYPES.holiday;

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  /* ---------- In-memory state (source of truth = server) ---------- */
  let currentUser = null;
  let allUsers = [];
  let allLeaves = [];

  let calCursor = startOfMonth(new Date()); // big calendar
  let mineOnly = false;

  /* ============================================================
     API helper
     ============================================================ */
  async function api(path, { method = 'GET', body } = {}) {
    const res = await fetch('/api' + path, {
      method,
      credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch { /* no body */ }
    if (!res.ok) {
      const msg = (data && data.error) || `Request failed (${res.status})`;
      const err = new Error(msg);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  /* ============================================================
     DATE / HOLIDAY UTILITIES
     ============================================================ */
  function startOfMonth(d) { const x = new Date(d); x.setDate(1); x.setHours(0, 0, 0, 0); return x; }
  const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  function parseDate(str) {
    if (!str) return null;
    const [y, m, d] = str.split('-').map(Number);
    if (!y || !m || !d) return null;
    return new Date(y, m - 1, d);
  }

  // Western (Gregorian) Easter — Anonymous Gregorian algorithm.
  function easterSunday(year) {
    const a = year % 19, b = Math.floor(year / 100), c = year % 100;
    const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
    const g = Math.floor((b - f + 1) / 3);
    const h = (19 * a + b - d - g + 15) % 30;
    const i = Math.floor(c / 4), k = c % 4;
    const l = (32 + 2 * e + 2 * i - h - k) % 7;
    const m = Math.floor((a + 11 * h + 22 * l) / 451);
    const month = Math.floor((h + l - 7 * m + 114) / 31);
    const day = ((h + l - 7 * m + 114) % 31) + 1;
    return new Date(year, month - 1, day);
  }

  const holidayCache = {};
  function slovenianHolidays(year) {
    if (holidayCache[year]) return holidayCache[year];
    const map = new Map();
    const add = (m, d, name) => map.set(fmt(new Date(year, m - 1, d)), name);
    add(1, 1, 'Novo leto'); add(1, 2, 'Novo leto');
    add(2, 8, 'Prešernov dan');
    add(4, 27, 'Dan upora proti okupatorju');
    add(5, 1, 'Praznik dela'); add(5, 2, 'Praznik dela');
    add(6, 25, 'Dan državnosti');
    add(8, 15, 'Marijino vnebovzetje');
    add(10, 31, 'Dan reformacije');
    add(11, 1, 'Dan spomina na mrtve');
    add(12, 25, 'Božič');
    add(12, 26, 'Dan samostojnosti in enotnosti');
    const easter = easterSunday(year);
    map.set(fmt(easter), 'Velika noč');
    const em = new Date(easter); em.setDate(easter.getDate() + 1); map.set(fmt(em), 'Velikonočni ponedeljek');
    const wh = new Date(easter); wh.setDate(easter.getDate() + 49); map.set(fmt(wh), 'Binkošti');
    holidayCache[year] = map;
    return map;
  }
  const isHoliday = (date) => slovenianHolidays(date.getFullYear()).get(fmt(date));
  const isWeekend = (date) => { const d = date.getDay(); return d === 0 || d === 6; };

  function workingDays(startStr, endStr) {
    const start = parseDate(startStr), end = parseDate(endStr);
    if (!start || !end || end < start) return 0;
    let count = 0;
    const cur = new Date(start);
    while (cur <= end) {
      if (!isWeekend(cur) && !isHoliday(cur)) count++;
      cur.setDate(cur.getDate() + 1);
    }
    return count;
  }

  /* ============================================================
     THEME
     ============================================================ */
  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem(THEME_KEY, theme);
    $$('.theme-choice').forEach(b => b.classList.toggle('active', b.dataset.themeSet === theme));
  }
  function initTheme() {
    const saved = localStorage.getItem(THEME_KEY) || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    applyTheme(saved);
  }

  /* ============================================================
     TOAST
     ============================================================ */
  let toastTimer;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    requestAnimationFrame(() => el.classList.add('show'));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.classList.remove('show');
      setTimeout(() => el.classList.add('hidden'), 300);
    }, 2600);
  }

  /* ============================================================
     HELPERS
     ============================================================ */
  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function initialsOf(name) {
    return name.split(/\s+/).filter(Boolean).slice(0, 2).map(p => p[0].toUpperCase()).join('');
  }
  function prettyRange(startStr, endStr) {
    const opts = { day: 'numeric', month: 'short', year: 'numeric' };
    const s = parseDate(startStr).toLocaleDateString('en-GB', opts);
    if (startStr === endStr) return s;
    const e = parseDate(endStr).toLocaleDateString('en-GB', opts);
    return `${s} → ${e}`;
  }
  const userById = (id) => allUsers.find(u => u.id === id);
  function myLeaves() {
    return allLeaves.filter(l => l.userId === currentUser.id).sort((a, b) => a.startDate.localeCompare(b.startDate));
  }

  /* ============================================================
     DATA LOADING
     ============================================================ */
  async function loadAll() {
    const [u, l] = await Promise.all([api('/users'), api('/leaves')]);
    allUsers = u.users;
    allLeaves = l.leaves;
  }

  /* ============================================================
     AUTH UI
     ============================================================ */
  function readInviteFromUrl() {
    return new URLSearchParams(location.search).get('invite');
  }

  function setupAuthTabs() {
    $$('.auth-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        $$('.auth-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        const isLogin = tab.dataset.tab === 'login';
        $('#login-form').classList.toggle('hidden', !isLogin);
        $('#register-form').classList.toggle('hidden', isLogin);
      });
    });
  }

  // Decide whether the register tab is available.
  async function configureAuthScreen() {
    const status = await api('/status');
    const hasUsers = status.hasUsers;
    const urlInvite = readInviteFromUrl();
    const registerTab = $('.auth-tab[data-tab="register"]');
    const inviteField = $('#invite-field');
    const banner = $('#invite-banner');
    const note = $('#first-user-note');

    banner.classList.add('hidden');
    banner.style.color = '';

    if (!hasUsers) {
      // First-ever user becomes admin; registration open, no invite needed.
      registerTab.classList.remove('hidden');
      inviteField.classList.add('hidden');
      note.textContent = 'You are the first user — this account becomes the team admin.';
      return;
    }

    // Team already exists → registration is invite-only.
    note.textContent = '';
    inviteField.classList.add('hidden'); // code comes from the link, not typed

    if (urlInvite) {
      let valid = false;
      try { valid = (await api(`/invites/${encodeURIComponent(urlInvite)}/valid`)).valid; } catch { valid = false; }
      if (valid) {
        registerTab.classList.remove('hidden');
        $('#reg-invite').value = urlInvite;
        banner.textContent = '✓ Valid invite detected — create your account below.';
        banner.classList.remove('hidden');
        registerTab.click();
      } else {
        // Invalid/used invite → no registration.
        registerTab.classList.add('hidden');
        $('#login-form').classList.remove('hidden');
        $('#register-form').classList.add('hidden');
        banner.textContent = '✗ This invite link is invalid or already used.';
        banner.style.color = 'var(--danger)';
      }
    } else {
      // No invite in URL and users exist → hide register entirely.
      registerTab.classList.add('hidden');
      $('.auth-tab[data-tab="login"]').classList.add('active');
      $('#login-form').classList.remove('hidden');
      $('#register-form').classList.add('hidden');
    }
  }

  async function handleLogin(e) {
    e.preventDefault();
    const err = $('#login-error');
    err.textContent = '';
    try {
      const { user } = await api('/auth/login', {
        method: 'POST',
        body: { email: $('#login-email').value.trim(), password: $('#login-password').value },
      });
      currentUser = user;
      await enterApp();
    } catch (ex) {
      err.textContent = ex.message;
    }
  }

  async function handleRegister(e) {
    e.preventDefault();
    const err = $('#register-error');
    err.textContent = '';
    try {
      const { user } = await api('/auth/register', {
        method: 'POST',
        body: {
          name: $('#reg-name').value.trim(),
          email: $('#reg-email').value.trim(),
          password: $('#reg-password').value,
          totalLeaveDays: parseInt($('#reg-leave').value, 10),
          carryoverDays: parseInt($('#reg-carry').value, 10) || 0,
          carryoverExpiry: $('#reg-carry-expiry').value || '',
          inviteToken: $('#reg-invite').value.trim(),
        },
      });
      currentUser = user;
      history.replaceState(null, '', location.pathname);
      await enterApp();
    } catch (ex) {
      err.textContent = ex.message;
    }
  }

  /* ============================================================
     APP NAVIGATION
     ============================================================ */
  async function enterApp() {
    await loadAll();
    $('#auth-screen').classList.add('hidden');
    $('#app-shell').classList.remove('hidden');
    paintUserChip();
    switchView('dashboard');
  }

  function showAuth() {
    $('#app-shell').classList.add('hidden');
    $('#auth-screen').classList.remove('hidden');
    configureAuthScreen();
  }

  function paintUserChip() {
    $('#user-name').textContent = currentUser.name;
    $('#user-email').textContent = currentUser.email;
    const av = $('#user-avatar');
    av.textContent = initialsOf(currentUser.name);
    av.style.background = currentUser.color;
  }

  const VIEW_META = {
    dashboard: ['Dashboard', 'Your leave at a glance'],
    calendar: ['Calendar', "Everyone's time off in one place"],
    team: ['Team', 'Invites and members'],
    settings: ['Settings', 'Profile, appearance and data'],
  };

  function switchView(view) {
    $$('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.view === view));
    $$('.view').forEach(v => v.classList.add('hidden'));
    $(`#view-${view}`).classList.remove('hidden');
    const [title, sub] = VIEW_META[view];
    $('#view-title').textContent = title;
    $('#view-subtitle').textContent = sub;
    if (view === 'dashboard') renderDashboard();
    if (view === 'calendar') renderCalendar();
    if (view === 'team') renderTeam();
    if (view === 'settings') renderSettings();
  }

  /* ============================================================
     DASHBOARD
     ============================================================ */
  /* ============================================================
     LEAVE ACCOUNTING (annual allowance + last-year carryover)
     ============================================================ */
  // Carryover days are spent first (they expire); the annual allowance
  // covers the rest. Only counting types (holiday) draw down either pool.
  function leaveSummary() {
    const year = currentUser.allowanceYear || new Date().getFullYear();
    const todayStr = fmt(new Date());
    const expiry = currentUser.carryoverExpiry || '';
    const expired = !!expiry && todayStr > expiry;
    const carryGranted = currentUser.carryoverDays || 0;

    const counting = myLeaves().filter(l =>
      leaveType(l.type).counts && parseInt(l.startDate.slice(0, 4), 10) === year);
    const usedThisYear = counting.reduce((s, l) => s + workingDays(l.startDate, l.endDate), 0);
    // Only leave taken on/before the expiry date may be paid from carryover.
    const eligible = counting
      .filter(l => !expiry || l.startDate <= expiry)
      .reduce((s, l) => s + workingDays(l.startDate, l.endDate), 0);

    const usedFromCarry = Math.min(carryGranted, eligible);
    const carryRemaining = expired ? 0 : Math.max(0, carryGranted - usedFromCarry);
    const annualUsed = Math.max(0, usedThisYear - usedFromCarry);
    const annualRemaining = currentUser.totalLeaveDays - annualUsed;
    const showCarry = carryGranted > 0 && !expired && carryRemaining > 0;

    return {
      year, expiry, expired, carryGranted, usedFromCarry, carryRemaining,
      usedThisYear, annualUsed, annualRemaining, showCarry,
    };
  }

  function renderDashboard() {
    const leaves = myLeaves();
    const s = leaveSummary();
    const total = currentUser.totalLeaveDays;

    $('#stat-total').textContent = total;
    $('#stat-used').textContent = s.annualUsed;
    $('#stat-remaining').textContent = s.annualRemaining;
    $('#stat-planned').textContent = leaves.length;

    const pct = total > 0 ? Math.min(100, Math.round((s.annualUsed / total) * 100)) : 0;
    $('#progress-pct').textContent = pct + '%';
    $('#progress-fill').style.width = pct + '%';
    $('#stat-remaining').style.color = s.annualRemaining < 0 ? 'var(--danger)' : '';

    renderCarryoverCard(s);

    const list = $('#leaves-list');
    if (leaves.length === 0) {
      list.innerHTML = `<div class="empty-state"><span class="big">🏖️</span>No leave booked yet.<br>Click "Add leave" to plan your first time off.</div>`;
    } else {
      list.innerHTML = leaves.map(l => {
        const days = workingDays(l.startDate, l.endDate);
        const t = leaveType(l.type);
        return `
          <div class="leave-row">
            <span class="leave-dot" style="background:${t.color}"></span>
            <div class="leave-info">
              <strong>${l.note ? escapeHtml(l.note) : t.label}</strong>
              <small>${prettyRange(l.startDate, l.endDate)}</small>
            </div>
            <span class="type-badge" style="background:${t.color}1a;color:${t.color}">${t.icon} ${t.label}</span>
            <span class="leave-days">${days} day${days !== 1 ? 's' : ''}</span>
            <button class="leave-edit" data-edit="${l.id}" title="Edit dates">✎</button>
            <button class="leave-del" data-del="${l.id}" title="Delete">🗑️</button>
          </div>`;
      }).join('');

      list.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => deleteLeave(b.dataset.del)));
      list.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => openModal(b.dataset.edit)));
    }

    renderAway();
  }

  // "Who's away soon" — upcoming team leave within the next 30 days,
  // with a clash flag when it overlaps your own time off.
  function renderAway() {
    const el = $('#away-list');
    if (!el) return;
    const today = fmt(new Date());
    const horizon = new Date(); horizon.setDate(horizon.getDate() + 30);
    const horizonStr = fmt(horizon);

    const mine = myLeaves();
    const overlapsMine = (l) => mine.some(m => l.startDate <= m.endDate && l.endDate >= m.startDate);

    const upcoming = allLeaves
      .filter(l => l.userId !== currentUser.id)
      .filter(l => l.endDate >= today && l.startDate <= horizonStr)
      .sort((a, b) => a.startDate.localeCompare(b.startDate))
      .slice(0, 8);

    if (upcoming.length === 0) {
      el.innerHTML = `<div class="empty-state small"><span class="big">🎉</span>No teammates are away in the next 30 days.</div>`;
      return;
    }
    el.innerHTML = upcoming.map(l => {
      const u = userById(l.userId);
      const t = leaveType(l.type);
      const clash = overlapsMine(l);
      return `
        <div class="away-row">
          <span class="avatar small" style="background:${u ? u.color : '#888'}">${u ? initialsOf(u.name) : '?'}</span>
          <div class="away-info">
            <strong>${escapeHtml(u ? u.name : 'Someone')} ${clash ? '<span class="badge clash">overlaps you</span>' : ''}</strong>
            <small>${t.icon} ${prettyRange(l.startDate, l.endDate)}</small>
          </div>
        </div>`;
    }).join('');
  }

  // Distinctive "last year" carryover counter — only visible while
  // carryover days remain and have not expired.
  function renderCarryoverCard(s) {
    const card = $('#carryover-card');
    if (!card) return;
    if (!s.showCarry) { card.classList.add('hidden'); return; }
    card.classList.remove('hidden');
    $('#carry-remaining').textContent = s.carryRemaining;
    const usedPct = s.carryGranted > 0 ? Math.min(100, Math.round((s.usedFromCarry / s.carryGranted) * 100)) : 0;
    $('#carry-fill').style.width = usedPct + '%';

    const note = $('#carry-expiry-note');
    if (s.expiry) {
      const exp = parseDate(s.expiry);
      const days = Math.ceil((exp - new Date(fmt(new Date()))) / 86400000);
      const dateTxt = exp.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
      note.textContent = days <= 0
        ? `Expires today — use them now!`
        : `Use by ${dateTxt} · ${days} day${days !== 1 ? 's' : ''} left`;
      note.classList.toggle('urgent', days <= 30);
    } else {
      note.textContent = 'No expiry date set';
      note.classList.remove('urgent');
    }
  }

  async function deleteLeave(id) {
    try {
      await api('/leaves/' + id, { method: 'DELETE' });
      allLeaves = allLeaves.filter(l => l.id !== id);
      toast('Leave removed');
      renderDashboard();
    } catch (ex) { toast(ex.message); }
  }

  /* ============================================================
     BIG CALENDAR
     ============================================================ */
  const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  function renderCalendar() {
    $('#cal-weekdays').innerHTML = WEEKDAYS.map(d => `<span>${d}</span>`).join('');
    const year = calCursor.getFullYear(), month = calCursor.getMonth();
    $('#cal-title').textContent = `${MONTHS[month]} ${year}`;

    const first = new Date(year, month, 1);
    const startOffset = (first.getDay() + 6) % 7;
    const gridStart = new Date(year, month, 1 - startOffset);
    const visible = allLeaves.filter(l => !mineOnly || l.userId === currentUser.id);
    const todayStr = fmt(new Date());

    const cells = [];
    for (let i = 0; i < 42; i++) {
      const date = new Date(gridStart); date.setDate(gridStart.getDate() + i);
      const dStr = fmt(date);
      const outside = date.getMonth() !== month;
      const holName = isHoliday(date);
      const dayLeaves = visible.filter(l => dStr >= l.startDate && dStr <= l.endDate);
      const bars = dayLeaves.map(l => {
        const u = userById(l.userId);
        const color = u ? u.color : '#888';
        const t = leaveType(l.type);
        const label = u ? u.name.split(/\s+/)[0] : 'Leave';
        return `<span class="cal-leave-bar" style="background:${color}" title="${escapeHtml((u ? u.name : '') + ' — ' + t.label + (l.note ? ' — ' + l.note : ''))}">${t.icon} ${escapeHtml(label)}</span>`;
      }).join('');

      const cls = ['cal-cell'];
      if (outside) cls.push('outside');
      if (isWeekend(date)) cls.push('weekend');
      if (holName) cls.push('holiday');
      if (dStr === todayStr) cls.push('today');
      cells.push(`
        <div class="${cls.join(' ')}" style="animation-delay:${i * 8}ms">
          <span class="cal-date">${date.getDate()}</span>
          ${holName ? `<span class="cal-holiday-name">${escapeHtml(holName)}</span>` : ''}
          <div class="cal-leaves">${bars}</div>
        </div>`);
    }
    $('#cal-grid').innerHTML = cells.join('');
    renderLegend();
  }

  function renderLegend() {
    const items = [
      `<div class="legend-item"><span class="legend-dot" style="background:var(--holiday); border:1px solid rgba(236,72,153,.5)"></span>Slovenian holiday</div>`,
      `<div class="legend-item"><span class="legend-dot" style="background:var(--weekend); border:1px solid var(--border)"></span>Weekend</div>`,
    ];
    const shown = mineOnly ? allUsers.filter(u => u.id === currentUser.id) : allUsers;
    shown.forEach(u => items.push(`<div class="legend-item"><span class="legend-dot" style="background:${u.color}"></span>${escapeHtml(u.name)}</div>`));
    $('#legend').innerHTML = items.join('');
  }

  /* ============================================================
     TEAM & INVITES
     ============================================================ */
  async function renderTeam() {
    const teamList = $('#team-list');
    teamList.innerHTML = allUsers.map(u => {
      const used = allLeaves.filter(l => l.userId === u.id).reduce((s, l) => s + (leaveType(l.type).counts ? workingDays(l.startDate, l.endDate) : 0), 0);
      return `
        <div class="team-member">
          <span class="avatar" style="background:${u.color}">${initialsOf(u.name)}</span>
          <div class="team-meta">
            <strong>${escapeHtml(u.name)} ${u.isAdmin ? '<span class="badge open">admin</span>' : ''} ${u.id === currentUser.id ? '<span class="badge open">you</span>' : ''}</strong>
            <small>${escapeHtml(u.email)}</small>
          </div>
          <div class="team-stat">${used}/${u.totalLeaveDays} days used</div>
        </div>`;
    }).join('');

    try {
      const { invites } = await api('/invites');
      const list = $('#invite-list');
      list.innerHTML = invites.length === 0
        ? `<p class="muted small">No invites generated yet.</p>`
        : invites.map(i => `
            <div class="invite-item">
              <code>${escapeHtml(i.token.slice(0, 10))}…</code>
              <span class="badge ${i.used ? 'used' : 'open'}">${i.used ? 'used' : 'open'}</span>
            </div>`).join('');
    } catch { /* ignore */ }
  }

  async function generateInvite() {
    try {
      const { token } = await api('/invites', { method: 'POST' });
      const link = `${location.origin}${location.pathname}?invite=${encodeURIComponent(token)}`;
      $('#invite-link').value = link;
      $('#invite-output').classList.remove('hidden');
      renderTeam();
      toast('Invite link created');
    } catch (ex) { toast(ex.message); }
  }

  /* ============================================================
     SETTINGS
     ============================================================ */
  function renderSettings() {
    $('#set-name').value = currentUser.name;
    $('#set-leave').value = currentUser.totalLeaveDays;
    $('#set-carry').value = currentUser.carryoverDays || 0;
    $('#set-carry-expiry').value = currentUser.carryoverExpiry || '';
    $('#set-color').value = currentUser.color;
    const saved = $('#settings-saved');
    saved.textContent = ''; saved.style.color = '';
    $$('.theme-choice').forEach(b => b.classList.toggle('active', b.dataset.themeSet === document.documentElement.getAttribute('data-theme')));
  }

  async function saveSettings() {
    const saved = $('#settings-saved');
    const name = $('#set-name').value.trim();
    if (!name) { saved.style.color = 'var(--danger)'; saved.textContent = 'Please enter a display name.'; return; }
    try {
      const { user } = await api('/users/me', {
        method: 'PATCH',
        body: {
          name,
          totalLeaveDays: parseInt($('#set-leave').value, 10),
          color: $('#set-color').value,
          carryoverDays: parseInt($('#set-carry').value, 10) || 0,
          carryoverExpiry: $('#set-carry-expiry').value || '',
        },
      });
      currentUser = user;
      const idx = allUsers.findIndex(u => u.id === user.id);
      if (idx !== -1) allUsers[idx] = user;
      paintUserChip();
      saved.style.color = 'var(--success)';
      saved.textContent = 'Saved ✓';
      toast('Settings updated');
    } catch (ex) {
      if (ex.status === 401) { return logout(); }
      saved.style.color = 'var(--danger)'; saved.textContent = ex.message;
    }
  }

  function exportCsv() {
    const mine = myLeaves();
    if (mine.length === 0) { toast('No leave to export'); return; }
    const esc = (v) => {
      const s = String(v == null ? '' : v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = ['Start date', 'End date', 'Type', 'Working days', 'Note'];
    const rows = mine.map(l => [
      l.startDate,
      l.endDate,
      leaveType(l.type).label,
      workingDays(l.startDate, l.endDate),
      l.note || '',
    ].map(esc).join(','));
    const csv = [header.join(','), ...rows].join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `leave-${currentUser.name.replace(/\s+/g, '-').toLowerCase()}-${fmt(new Date())}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast('CSV exported');
  }

  async function clearMyLeave() {
    if (!confirm('Delete all of your leave requests? This cannot be undone.')) return;
    try {
      const mine = myLeaves();
      await Promise.all(mine.map(l => api('/leaves/' + l.id, { method: 'DELETE' })));
      allLeaves = allLeaves.filter(l => l.userId !== currentUser.id);
      toast('All your leave was cleared');
      renderDashboard();
    } catch (ex) { toast(ex.message); }
  }

  async function logout() {
    try { await api('/auth/logout', { method: 'POST' }); } catch { /* ignore */ }
    currentUser = null; allUsers = []; allLeaves = [];
    showAuth();
  }

  /* ============================================================
     SMART CALENDAR RANGE PICKER (in modal)
     ============================================================ */
  const picker = {
    cursor: startOfMonth(new Date()),
    start: null,   // 'YYYY-MM-DD'
    end: null,     // 'YYYY-MM-DD'
    hover: null,   // 'YYYY-MM-DD' while choosing the end
    type: 'holiday',
    editingId: null,
  };

  function openModal(editId = null) {
    $('#leave-form').reset();
    $('#leave-error').textContent = '';
    picker.start = null; picker.end = null; picker.hover = null;
    picker.type = 'holiday';
    picker.editingId = null;

    if (editId) {
      const leave = allLeaves.find(l => l.id === editId);
      if (leave) {
        picker.editingId = editId;
        picker.start = leave.startDate;
        picker.end = leave.endDate;
        picker.type = leave.type || 'holiday';
        $('#leave-note').value = leave.note || '';
        picker.cursor = startOfMonth(parseDate(leave.startDate));
        $('#modal-title').textContent = 'Edit leave';
        $('#save-leave-btn').textContent = 'Save changes';
      }
    } else {
      picker.cursor = startOfMonth(new Date());
      $('#modal-title').textContent = 'Add leave';
      $('#save-leave-btn').textContent = 'Save leave';
    }

    $('#leave-modal').classList.remove('hidden');
    renderTypeChoices();
    renderPicker();
    updateLeavePreview();
  }
  function closeModal() { $('#leave-modal').classList.add('hidden'); }

  function renderTypeChoices() {
    const wrap = $('#type-choices');
    wrap.innerHTML = Object.entries(LEAVE_TYPES).map(([key, t]) => `
      <button type="button" class="type-choice ${key === picker.type ? 'active' : ''}" data-type="${key}"
        style="--type-color:${t.color}">
        <span class="type-ico">${t.icon}</span>${t.label}
      </button>`).join('');
    wrap.querySelectorAll('.type-choice').forEach(btn => {
      btn.addEventListener('click', () => {
        picker.type = btn.dataset.type;
        renderTypeChoices();
        updateLeavePreview();
      });
    });
  }

  function resetRange() {
    picker.start = null; picker.end = null; picker.hover = null;
    $('#leave-error').textContent = '';
    renderPicker();
    updateLeavePreview();
  }

  // Click logic mirrors common range pickers.
  function pickDate(dStr) {
    $('#leave-error').textContent = '';
    if (!picker.start || (picker.start && picker.end)) {
      // Begin a fresh selection.
      picker.start = dStr; picker.end = null; picker.hover = null;
    } else {
      // We have a start, no end yet.
      if (dStr < picker.start) {
        // Clicked before start → restart from this earlier date.
        picker.start = dStr;
      } else {
        picker.end = dStr;
      }
    }
    renderPicker();
    updateLeavePreview();
  }

  function renderPicker() {
    $('#pick-weekdays').innerHTML = WEEKDAYS.map(d => `<span>${d}</span>`).join('');
    const year = picker.cursor.getFullYear(), month = picker.cursor.getMonth();
    $('#pick-title').textContent = `${MONTHS[month]} ${year}`;

    const first = new Date(year, month, 1);
    const startOffset = (first.getDay() + 6) % 7;
    const gridStart = new Date(year, month, 1 - startOffset);
    const todayStr = fmt(new Date());

    const cells = [];
    for (let i = 0; i < 42; i++) {
      const date = new Date(gridStart); date.setDate(gridStart.getDate() + i);
      const dStr = fmt(date);
      const outside = date.getMonth() !== month;
      const holName = isHoliday(date);
      const weekend = isWeekend(date);

      const cls = ['pick-cell'];
      if (outside) cls.push('outside');
      if (weekend) cls.push('weekend');
      if (holName) cls.push('holiday');
      if (dStr === todayStr) cls.push('today');

      cells.push(`<button type="button" class="${cls.join(' ')}" data-d="${dStr}" title="${holName ? escapeHtml(holName) : ''}">${date.getDate()}</button>`);
    }
    const grid = $('#pick-grid');
    grid.innerHTML = cells.join('');
    grid.querySelectorAll('.pick-cell').forEach(btn => {
      btn.addEventListener('click', () => pickDate(btn.dataset.d));
      btn.addEventListener('mouseenter', () => {
        // Only repaint range classes on hover — never rebuild the grid,
        // otherwise the button under the cursor is destroyed mid-click.
        if (picker.start && !picker.end) { picker.hover = btn.dataset.d; paintPickerRange(); }
      });
    });

    paintPickerRange();
  }

  // Lightweight highlight update: toggles range classes on the existing
  // cells without recreating them (so clicks always register).
  function paintPickerRange() {
    const effEnd = picker.end || (picker.start && picker.hover && picker.hover >= picker.start ? picker.hover : null);
    $('#pick-grid').querySelectorAll('.pick-cell').forEach(btn => {
      const dStr = btn.dataset.d;
      const inRange = picker.start && effEnd && dStr >= picker.start && dStr <= effEnd;
      btn.classList.toggle('in-range', !!inRange);
      btn.classList.toggle('range-start', dStr === picker.start);
      // End cap: the chosen/previewed end, or the start itself when only one day is picked.
      const isEndCap = (effEnd && dStr === effEnd) || (picker.start && !picker.end && dStr === picker.start);
      btn.classList.toggle('range-end', !!isEndCap);
    });

    // Summary chips
    const sc = $('#chip-start strong'), ec = $('#chip-end strong');
    sc.textContent = picker.start ? parseDate(picker.start).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '—';
    ec.textContent = picker.end ? parseDate(picker.end).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '—';
    $('#chip-start').classList.toggle('active', !!picker.start);
    $('#chip-end').classList.toggle('active', !!picker.end);

    $('#picker-hint').textContent = !picker.start
      ? 'Click a start date, then click an end date.'
      : (!picker.end ? 'Now click the end date (or the same day for one day off).' : 'Range selected. Adjust or save.');
  }

  function updateLeavePreview() {
    const preview = $('#leave-preview');
    const start = picker.start;
    const end = picker.end || picker.start;
    if (!start) {
      preview.innerHTML = '<span class="muted">Pick a date range to see working days.</span>';
      return;
    }
    const totalCal = Math.round((parseDate(end) - parseDate(start)) / 86400000) + 1;
    const wd = workingDays(start, end);
    const t = leaveType(picker.type);
    const expiry = currentUser.carryoverExpiry || '';
    const expired = !!expiry && fmt(new Date()) > expiry;
    const activeCarry = expired ? 0 : (currentUser.carryoverDays || 0);
    const usedOther = myLeaves()
      .filter(l => l.id !== picker.editingId)
      .reduce((s, l) => s + (leaveType(l.type).counts ? workingDays(l.startDate, l.endDate) : 0), 0);
    const draw = t.counts ? wd : 0;
    // Carryover is consumed first, then the annual allowance.
    const totalUsedAfter = usedOther + draw;
    const carryUsedAfter = Math.min(activeCarry, totalUsedAfter);
    const carryAfter = activeCarry - carryUsedAfter;
    const annualAfter = currentUser.totalLeaveDays - (totalUsedAfter - carryUsedAfter);
    const remainingAfter = carryAfter + annualAfter;
    const usesCarry = t.counts && activeCarry > 0 && carryUsedAfter > (Math.min(activeCarry, usedOther));
    preview.innerHTML = `
      <div class="preview-grid">
        <div><span>Working days</span><strong class="accent">${wd}</strong></div>
        <div><span>Calendar days</span><strong>${totalCal}</strong></div>
        <div><span>Remaining after</span><strong style="color:${remainingAfter < 0 ? 'var(--danger)' : 'inherit'}">${remainingAfter}</strong></div>
      </div>
      ${!t.counts ? `<p class="muted small">${t.icon} ${t.label} does not count against your allowance.</p>`
        : (usesCarry ? `<p class="muted small">🎁 Uses your last-year carryover first (${carryAfter} carryover left after).</p>` : '')}`;
  }

  async function handleSaveLeave(e) {
    e.preventDefault();
    const err = $('#leave-error');
    err.textContent = '';
    if (!picker.start) { err.textContent = 'Please pick a start date.'; return; }
    const start = picker.start;
    const end = picker.end || picker.start;
    const note = $('#leave-note').value.trim();
    const type = picker.type;

    try {
      if (picker.editingId) {
        const { leave } = await api('/leaves/' + picker.editingId, { method: 'PATCH', body: { startDate: start, endDate: end, note, type } });
        const idx = allLeaves.findIndex(l => l.id === leave.id);
        if (idx !== -1) allLeaves[idx] = leave;
        toast('Leave updated ✓');
      } else {
        const { leave } = await api('/leaves', { method: 'POST', body: { startDate: start, endDate: end, note, type } });
        allLeaves.push(leave);
        toast('Leave added 🎉');
      }
      closeModal();
      renderDashboard();
    } catch (ex) {
      if (ex.status === 401) return logout();
      err.textContent = ex.message;
    }
  }

  /* ============================================================
     EVENT WIRING
     ============================================================ */
  function wireEvents() {
    setupAuthTabs();
    $('#login-form').addEventListener('submit', handleLogin);
    $('#register-form').addEventListener('submit', handleRegister);

    $$('.nav-item').forEach(n => n.addEventListener('click', () => switchView(n.dataset.view)));
    $('#logout-btn').addEventListener('click', logout);

    $('#theme-toggle').addEventListener('click', () => {
      const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      applyTheme(next);
    });
    $$('.theme-choice').forEach(b => b.addEventListener('click', () => applyTheme(b.dataset.themeSet)));

    // Big calendar
    $('#cal-prev').addEventListener('click', () => { calCursor.setMonth(calCursor.getMonth() - 1); renderCalendar(); });
    $('#cal-next').addEventListener('click', () => { calCursor.setMonth(calCursor.getMonth() + 1); renderCalendar(); });
    $('#cal-today').addEventListener('click', () => { calCursor = startOfMonth(new Date()); renderCalendar(); });
    $('#mine-only').addEventListener('change', (e) => { mineOnly = e.target.checked; renderCalendar(); });

    // Team
    $('#gen-invite').addEventListener('click', generateInvite);
    $('#copy-invite').addEventListener('click', () => {
      const input = $('#invite-link');
      input.select();
      navigator.clipboard.writeText(input.value).then(() => toast('Link copied')).catch(() => toast('Copied'));
    });

    // Settings
    $('#save-settings').addEventListener('click', saveSettings);
    $('#clear-data').addEventListener('click', clearMyLeave);
    $('#export-csv').addEventListener('click', exportCsv);

    // Modal + picker
    $('#add-leave-btn').addEventListener('click', () => openModal());
    $('#close-modal').addEventListener('click', closeModal);
    $('#cancel-leave').addEventListener('click', closeModal);
    $('#reset-range').addEventListener('click', resetRange);
    $('#leave-modal').addEventListener('click', (e) => { if (e.target.id === 'leave-modal') closeModal(); });
    $('#pick-prev').addEventListener('click', () => { picker.cursor.setMonth(picker.cursor.getMonth() - 1); renderPicker(); });
    $('#pick-next').addEventListener('click', () => { picker.cursor.setMonth(picker.cursor.getMonth() + 1); renderPicker(); });
    $('#pick-grid').addEventListener('mouseleave', () => { if (picker.start && !picker.end) { picker.hover = null; paintPickerRange(); } });
    $('#leave-form').addEventListener('submit', handleSaveLeave);

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !$('#leave-modal').classList.contains('hidden')) closeModal();
    });
  }

  /* ============================================================
     BOOT
     ============================================================ */
  async function boot() {
    initTheme();
    wireEvents();
    try {
      const { user } = await api('/auth/me');
      currentUser = user;
      await enterApp();
    } catch {
      showAuth();
    }
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
