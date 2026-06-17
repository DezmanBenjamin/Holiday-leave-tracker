/* ============================================================
   Leave Tracker — application logic
   All data is stored locally in the browser (localStorage).
   ============================================================ */

(() => {
  'use strict';

  /* ---------- Storage keys ---------- */
  const KEYS = {
    users: 'hlt_users',
    leaves: 'hlt_leaves',
    invites: 'hlt_invites',
    session: 'hlt_session',
    theme: 'hlt_theme',
  };

  const PALETTE = ['#6366f1', '#ec4899', '#10b981', '#f59e0b', '#0ea5e9', '#8b5cf6', '#ef4444', '#14b8a6'];

  /* ---------- Tiny storage helpers ---------- */
  const load = (k, fallback) => {
    try { return JSON.parse(localStorage.getItem(k)) ?? fallback; }
    catch { return fallback; }
  };
  const save = (k, v) => localStorage.setItem(k, JSON.stringify(v));

  const getUsers = () => load(KEYS.users, []);
  const getLeaves = () => load(KEYS.leaves, []);
  const getInvites = () => load(KEYS.invites, []);
  const setUsers = (u) => save(KEYS.users, u);
  const setLeaves = (l) => save(KEYS.leaves, l);
  const setInvites = (i) => save(KEYS.invites, i);

  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  /* ---------- Password hashing (SHA-256) ---------- */
  async function hashPassword(pw) {
    const data = new TextEncoder().encode(pw + '::hlt-salt');
    const buf = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  /* ============================================================
     SLOVENIAN HOLIDAYS (dela prosti dnevi)
     ============================================================ */
  // Western (Gregorian) Easter — Anonymous Gregorian algorithm.
  function easterSunday(year) {
    const a = year % 19;
    const b = Math.floor(year / 100);
    const c = year % 100;
    const d = Math.floor(b / 4);
    const e = b % 4;
    const f = Math.floor((b + 8) / 25);
    const g = Math.floor((b - f + 1) / 3);
    const h = (19 * a + b - d - g + 15) % 30;
    const i = Math.floor(c / 4);
    const k = c % 4;
    const l = (32 + 2 * e + 2 * i - h - k) % 7;
    const m = Math.floor((a + 11 * h + 22 * l) / 451);
    const month = Math.floor((h + l - 7 * m + 114) / 31); // 3=March, 4=April
    const day = ((h + l - 7 * m + 114) % 31) + 1;
    return new Date(year, month - 1, day);
  }

  const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  // Returns a Map of "YYYY-MM-DD" -> holiday name for the given year.
  const holidayCache = {};
  function slovenianHolidays(year) {
    if (holidayCache[year]) return holidayCache[year];
    const map = new Map();
    const add = (m, d, name) => map.set(fmt(new Date(year, m - 1, d)), name);

    add(1, 1, 'Novo leto');
    add(1, 2, 'Novo leto');
    add(2, 8, 'Prešernov dan');
    add(4, 27, 'Dan upora proti okupatorju');
    add(5, 1, 'Praznik dela');
    add(5, 2, 'Praznik dela');
    add(6, 25, 'Dan državnosti');
    add(8, 15, 'Marijino vnebovzetje');
    add(10, 31, 'Dan reformacije');
    add(11, 1, 'Dan spomina na mrtve');
    add(12, 25, 'Božič');
    add(12, 26, 'Dan samostojnosti in enotnosti');

    // Movable feasts based on Easter.
    const easter = easterSunday(year);
    map.set(fmt(easter), 'Velika noč');
    const easterMon = new Date(easter); easterMon.setDate(easter.getDate() + 1);
    map.set(fmt(easterMon), 'Velikonočni ponedeljek');
    const whit = new Date(easter); whit.setDate(easter.getDate() + 49); // Pentecost
    map.set(fmt(whit), 'Binkošti');

    holidayCache[year] = map;
    return map;
  }

  function isHoliday(date) {
    return slovenianHolidays(date.getFullYear()).get(fmt(date));
  }
  function isWeekend(date) {
    const d = date.getDay();
    return d === 0 || d === 6;
  }

  // Count working days between two YYYY-MM-DD strings (inclusive),
  // excluding weekends and Slovenian public holidays.
  function workingDays(startStr, endStr) {
    const start = parseDate(startStr);
    const end = parseDate(endStr);
    if (!start || !end || end < start) return 0;
    let count = 0;
    const cur = new Date(start);
    while (cur <= end) {
      if (!isWeekend(cur) && !isHoliday(cur)) count++;
      cur.setDate(cur.getDate() + 1);
    }
    return count;
  }

  function parseDate(str) {
    if (!str) return null;
    const [y, m, d] = str.split('-').map(Number);
    if (!y || !m || !d) return null;
    return new Date(y, m - 1, d);
  }

  /* ============================================================
     SESSION & STATE
     ============================================================ */
  let currentUser = null;
  let calCursor = new Date(); // first-of-month cursor for calendar
  calCursor.setDate(1);
  let mineOnly = false;

  function setSession(userId) { save(KEYS.session, userId); }
  function clearSession() { localStorage.removeItem(KEYS.session); }

  function refreshCurrentUser() {
    const id = load(KEYS.session, null);
    currentUser = getUsers().find(u => u.id === id) || null;
    return currentUser;
  }

  /* ============================================================
     THEME
     ============================================================ */
  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    save(KEYS.theme, theme);
    $$('.theme-choice').forEach(b => b.classList.toggle('active', b.dataset.themeSet === theme));
  }
  function initTheme() {
    const saved = load(KEYS.theme, null) || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
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
     AUTH UI
     ============================================================ */
  function initialsOf(name) {
    return name.split(/\s+/).filter(Boolean).slice(0, 2).map(p => p[0].toUpperCase()).join('');
  }

  function readInviteFromUrl() {
    const params = new URLSearchParams(location.search);
    return params.get('invite');
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

  function refreshRegisterFormMode() {
    const users = getUsers();
    const isFirst = users.length === 0;
    const inviteField = $('#invite-field');
    const note = $('#first-user-note');
    const banner = $('#invite-banner');
    const urlInvite = readInviteFromUrl();

    if (isFirst) {
      inviteField.classList.add('hidden');
      note.textContent = 'You are the first user — this account becomes the team admin.';
    } else {
      inviteField.classList.remove('hidden');
      note.textContent = '';
    }

    if (urlInvite && !isFirst) {
      const invite = getInvites().find(i => i.token === urlInvite && !i.used);
      if (invite) {
        $('#reg-invite').value = urlInvite;
        banner.textContent = '✓ Valid invite detected — you can register.';
        banner.classList.remove('hidden');
        // Auto-switch to register tab.
        $('.auth-tab[data-tab="register"]').click();
      } else {
        banner.textContent = '✗ This invite link is invalid or already used.';
        banner.style.color = 'var(--danger)';
        banner.classList.remove('hidden');
      }
    }
  }

  async function handleLogin(e) {
    e.preventDefault();
    const err = $('#login-error');
    err.textContent = '';
    const email = $('#login-email').value.trim().toLowerCase();
    const pw = $('#login-password').value;
    const user = getUsers().find(u => u.email === email);
    if (!user) { err.textContent = 'No account found with that email.'; return; }
    const hash = await hashPassword(pw);
    if (hash !== user.passwordHash) { err.textContent = 'Incorrect password.'; return; }
    setSession(user.id);
    enterApp();
  }

  async function handleRegister(e) {
    e.preventDefault();
    const err = $('#register-error');
    err.textContent = '';
    const users = getUsers();
    const isFirst = users.length === 0;

    const name = $('#reg-name').value.trim();
    const email = $('#reg-email').value.trim().toLowerCase();
    const pw = $('#reg-password').value;
    const leaveDays = parseInt($('#reg-leave').value, 10);
    const inviteToken = $('#reg-invite').value.trim();

    if (pw.length < 6) { err.textContent = 'Password must be at least 6 characters.'; return; }
    if (users.some(u => u.email === email)) { err.textContent = 'An account with that email already exists.'; return; }

    let usedInvite = null;
    if (!isFirst) {
      usedInvite = getInvites().find(i => i.token === inviteToken && !i.used);
      if (!usedInvite) { err.textContent = 'A valid, unused invite code is required to register.'; return; }
    }

    const user = {
      id: uid(),
      name,
      email,
      passwordHash: await hashPassword(pw),
      totalLeaveDays: isNaN(leaveDays) ? 25 : leaveDays,
      color: PALETTE[users.length % PALETTE.length],
      isAdmin: isFirst,
      createdAt: Date.now(),
    };
    users.push(user);
    setUsers(users);

    if (usedInvite) {
      const invites = getInvites();
      const idx = invites.findIndex(i => i.token === usedInvite.token);
      invites[idx].used = true;
      invites[idx].usedBy = user.id;
      setInvites(invites);
    }

    setSession(user.id);
    // Clean invite param from URL.
    history.replaceState(null, '', location.pathname);
    enterApp();
  }

  /* ============================================================
     APP NAVIGATION
     ============================================================ */
  function enterApp() {
    refreshCurrentUser();
    if (!currentUser) { showAuth(); return; }
    $('#auth-screen').classList.add('hidden');
    $('#app-shell').classList.remove('hidden');
    paintUserChip();
    switchView('dashboard');
  }

  function showAuth() {
    $('#app-shell').classList.add('hidden');
    $('#auth-screen').classList.remove('hidden');
    refreshRegisterFormMode();
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
    calendar: ['Calendar', 'Everyone\'s time off in one place'],
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
  function userLeaves(userId) {
    return getLeaves().filter(l => l.userId === userId)
      .sort((a, b) => a.startDate.localeCompare(b.startDate));
  }

  function renderDashboard() {
    const leaves = userLeaves(currentUser.id);
    const used = leaves.reduce((s, l) => s + workingDays(l.startDate, l.endDate), 0);
    const total = currentUser.totalLeaveDays;
    const remaining = total - used;

    $('#stat-total').textContent = total;
    $('#stat-used').textContent = used;
    $('#stat-remaining').textContent = remaining;
    $('#stat-planned').textContent = leaves.length;

    const pct = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0;
    $('#progress-pct').textContent = pct + '%';
    $('#progress-fill').style.width = pct + '%';
    if (remaining < 0) $('#stat-remaining').style.color = 'var(--danger)';
    else $('#stat-remaining').style.color = '';

    const list = $('#leaves-list');
    if (leaves.length === 0) {
      list.innerHTML = `<div class="empty-state"><span class="big">🏖️</span>No leave booked yet.<br>Click "Add leave" to plan your first time off.</div>`;
      return;
    }
    list.innerHTML = leaves.map(l => {
      const days = workingDays(l.startDate, l.endDate);
      return `
        <div class="leave-row">
          <span class="leave-dot" style="background:${currentUser.color}"></span>
          <div class="leave-info">
            <strong>${l.note ? escapeHtml(l.note) : 'Leave'}</strong>
            <small>${prettyRange(l.startDate, l.endDate)}</small>
          </div>
          <span class="leave-days">${days} day${days !== 1 ? 's' : ''}</span>
          <button class="leave-del" data-del="${l.id}" title="Delete">🗑️</button>
        </div>`;
    }).join('');

    list.querySelectorAll('[data-del]').forEach(btn => {
      btn.addEventListener('click', () => deleteLeave(btn.dataset.del));
    });
  }

  function deleteLeave(id) {
    const leaves = getLeaves().filter(l => l.id !== id);
    setLeaves(leaves);
    toast('Leave removed');
    renderDashboard();
  }

  /* ============================================================
     CALENDAR
     ============================================================ */
  const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  function renderCalendar() {
    const wk = $('#cal-weekdays');
    wk.innerHTML = WEEKDAYS.map(d => `<span>${d}</span>`).join('');

    const year = calCursor.getFullYear();
    const month = calCursor.getMonth();
    $('#cal-title').textContent = `${MONTHS[month]} ${year}`;

    // Build grid starting Monday.
    const first = new Date(year, month, 1);
    let startOffset = (first.getDay() + 6) % 7; // 0 = Monday
    const gridStart = new Date(year, month, 1 - startOffset);

    const users = getUsers();
    const visibleLeaves = getLeaves().filter(l => !mineOnly || l.userId === currentUser.id);
    const todayStr = fmt(new Date());

    const cells = [];
    for (let i = 0; i < 42; i++) {
      const date = new Date(gridStart);
      date.setDate(gridStart.getDate() + i);
      const dStr = fmt(date);
      const outside = date.getMonth() !== month;
      const weekend = isWeekend(date);
      const holName = isHoliday(date);

      const dayLeaves = visibleLeaves.filter(l => dStr >= l.startDate && dStr <= l.endDate);
      const bars = dayLeaves.map(l => {
        const u = users.find(x => x.id === l.userId);
        const color = u ? u.color : '#888';
        const label = u ? u.name.split(/\s+/)[0] : 'Leave';
        return `<span class="cal-leave-bar" style="background:${color}" title="${escapeHtml((u?u.name:'')+ (l.note? ' — '+l.note:''))}">${escapeHtml(label)}</span>`;
      }).join('');

      const classes = ['cal-cell'];
      if (outside) classes.push('outside');
      if (weekend) classes.push('weekend');
      if (holName) classes.push('holiday');
      if (dStr === todayStr) classes.push('today');

      cells.push(`
        <div class="${classes.join(' ')}" style="animation-delay:${i * 8}ms">
          <span class="cal-date">${date.getDate()}</span>
          ${holName ? `<span class="cal-holiday-name">${escapeHtml(holName)}</span>` : ''}
          <div class="cal-leaves">${bars}</div>
        </div>`);
    }
    $('#cal-grid').innerHTML = cells.join('');

    renderLegend();
  }

  function renderLegend() {
    const users = getUsers();
    const items = [
      `<div class="legend-item"><span class="legend-dot" style="background:var(--holiday); border:1px solid rgba(236,72,153,.5)"></span>Slovenian holiday</div>`,
      `<div class="legend-item"><span class="legend-dot" style="background:var(--weekend); border:1px solid var(--border)"></span>Weekend</div>`,
    ];
    const shown = mineOnly ? users.filter(u => u.id === currentUser.id) : users;
    shown.forEach(u => {
      items.push(`<div class="legend-item"><span class="legend-dot" style="background:${u.color}"></span>${escapeHtml(u.name)}</div>`);
    });
    $('#legend').innerHTML = items.join('');
  }

  /* ============================================================
     TEAM & INVITES
     ============================================================ */
  function renderTeam() {
    // Members
    const users = getUsers();
    const teamList = $('#team-list');
    teamList.innerHTML = users.map(u => {
      const used = userLeaves(u.id).reduce((s, l) => s + workingDays(l.startDate, l.endDate), 0);
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

    // Invites
    const invites = getInvites().filter(i => i.createdBy === currentUser.id);
    const list = $('#invite-list');
    if (invites.length === 0) {
      list.innerHTML = `<p class="muted small">No invites generated yet.</p>`;
    } else {
      list.innerHTML = invites.map(i => `
        <div class="invite-item">
          <code>${i.token}</code>
          <span class="badge ${i.used ? 'used' : 'open'}">${i.used ? 'used' : 'open'}</span>
        </div>`).join('');
    }
  }

  function generateInvite() {
    const token = uid().toUpperCase();
    const invites = getInvites();
    invites.push({ token, createdBy: currentUser.id, used: false, usedBy: null, createdAt: Date.now() });
    setInvites(invites);
    const link = `${location.origin}${location.pathname}?invite=${token}`;
    $('#invite-link').value = link;
    $('#invite-output').classList.remove('hidden');
    renderTeam();
    toast('Invite link created');
  }

  /* ============================================================
     SETTINGS
     ============================================================ */
  function renderSettings() {
    $('#set-name').value = currentUser.name;
    $('#set-leave').value = currentUser.totalLeaveDays;
    $('#set-color').value = currentUser.color;
    $('#settings-saved').textContent = '';
    $$('.theme-choice').forEach(b => b.classList.toggle('active', b.dataset.themeSet === document.documentElement.getAttribute('data-theme')));
  }

  function saveSettings() {
    const name = $('#set-name').value.trim();
    const leaveDays = parseInt($('#set-leave').value, 10);
    const color = $('#set-color').value;
    if (!name) {
      $('#settings-saved').textContent = 'Please enter a display name.';
      $('#settings-saved').style.color = 'var(--danger)';
      return;
    }

    const users = getUsers();
    const idx = users.findIndex(u => u.id === currentUser.id);
    if (idx === -1) {
      // Session is out of sync with storage (e.g. data was cleared in another tab).
      toast('Your session expired — please sign in again');
      clearSession();
      currentUser = null;
      showAuth();
      return;
    }
    users[idx].name = name;
    users[idx].totalLeaveDays = isNaN(leaveDays) ? users[idx].totalLeaveDays : leaveDays;
    users[idx].color = color;
    setUsers(users);
    refreshCurrentUser();
    paintUserChip();
    $('#settings-saved').style.color = 'var(--success)';
    $('#settings-saved').textContent = 'Saved ✓';
    toast('Settings updated');
  }

  function clearMyLeave() {
    if (!confirm('Delete all of your leave requests? This cannot be undone.')) return;
    setLeaves(getLeaves().filter(l => l.userId !== currentUser.id));
    toast('All your leave was cleared');
    renderDashboard();
  }

  /* ============================================================
     ADD LEAVE MODAL
     ============================================================ */
  function openModal() {
    $('#leave-form').reset();
    $('#leave-error').textContent = '';
    $('#leave-preview').innerHTML = '<span class="muted">Pick a date range to see working days.</span>';
    $('#leave-modal').classList.remove('hidden');
  }
  function closeModal() { $('#leave-modal').classList.add('hidden'); }

  function updateLeavePreview() {
    const start = $('#leave-start').value;
    const end = $('#leave-end').value;
    const preview = $('#leave-preview');
    if (!start || !end) {
      preview.innerHTML = '<span class="muted">Pick a date range to see working days.</span>';
      return;
    }
    if (parseDate(end) < parseDate(start)) {
      preview.innerHTML = '<span class="muted" style="color:var(--danger)">End date is before start date.</span>';
      return;
    }
    const totalCal = Math.round((parseDate(end) - parseDate(start)) / 86400000) + 1;
    const wd = workingDays(start, end);
    const used = userLeaves(currentUser.id).reduce((s, l) => s + workingDays(l.startDate, l.endDate), 0);
    const remainingAfter = currentUser.totalLeaveDays - used - wd;
    preview.innerHTML = `
      <div class="preview-grid">
        <div><span>Working days</span><strong class="accent">${wd}</strong></div>
        <div><span>Calendar days</span><strong>${totalCal}</strong></div>
        <div><span>Remaining after</span><strong style="color:${remainingAfter < 0 ? 'var(--danger)' : 'inherit'}">${remainingAfter}</strong></div>
      </div>`;
  }

  function handleSaveLeave(e) {
    e.preventDefault();
    const err = $('#leave-error');
    err.textContent = '';
    const start = $('#leave-start').value;
    const end = $('#leave-end').value;
    const note = $('#leave-note').value.trim();
    if (!start || !end) { err.textContent = 'Please choose both dates.'; return; }
    if (parseDate(end) < parseDate(start)) { err.textContent = 'End date must be after start date.'; return; }

    const leaves = getLeaves();
    leaves.push({ id: uid(), userId: currentUser.id, startDate: start, endDate: end, note });
    setLeaves(leaves);
    closeModal();
    toast('Leave added 🎉');
    renderDashboard();
  }

  /* ============================================================
     HELPERS
     ============================================================ */
  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function prettyRange(startStr, endStr) {
    const opts = { day: 'numeric', month: 'short', year: 'numeric' };
    const s = parseDate(startStr).toLocaleDateString('en-GB', opts);
    if (startStr === endStr) return s;
    const e = parseDate(endStr).toLocaleDateString('en-GB', opts);
    return `${s} → ${e}`;
  }

  /* ============================================================
     EVENT WIRING
     ============================================================ */
  function wireEvents() {
    setupAuthTabs();
    $('#login-form').addEventListener('submit', handleLogin);
    $('#register-form').addEventListener('submit', handleRegister);

    $$('.nav-item').forEach(n => n.addEventListener('click', () => switchView(n.dataset.view)));
    $('#logout-btn').addEventListener('click', () => { clearSession(); currentUser = null; showAuth(); });

    // Theme
    $('#theme-toggle').addEventListener('click', () => {
      const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      applyTheme(next);
    });
    $$('.theme-choice').forEach(b => b.addEventListener('click', () => applyTheme(b.dataset.themeSet)));

    // Calendar nav
    $('#cal-prev').addEventListener('click', () => { calCursor.setMonth(calCursor.getMonth() - 1); renderCalendar(); });
    $('#cal-next').addEventListener('click', () => { calCursor.setMonth(calCursor.getMonth() + 1); renderCalendar(); });
    $('#cal-today').addEventListener('click', () => { calCursor = new Date(); calCursor.setDate(1); renderCalendar(); });
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

    // Modal
    $('#add-leave-btn').addEventListener('click', openModal);
    $('#close-modal').addEventListener('click', closeModal);
    $('#cancel-leave').addEventListener('click', closeModal);
    $('#leave-modal').addEventListener('click', (e) => { if (e.target.id === 'leave-modal') closeModal(); });
    $('#leave-start').addEventListener('change', updateLeavePreview);
    $('#leave-end').addEventListener('change', updateLeavePreview);
    $('#leave-form').addEventListener('submit', handleSaveLeave);
  }

  /* ============================================================
     BOOT
     ============================================================ */
  function boot() {
    initTheme();
    wireEvents();
    if (refreshCurrentUser()) enterApp();
    else showAuth();
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
