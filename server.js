'use strict';

/**
 * Holiday Leave Tracker — secure backend
 * Express + SQLite + bcrypt + JWT (httpOnly cookie).
 */
require('dotenv').config();

const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const PROD = process.env.NODE_ENV === 'production';
const COOKIE = 'hlt_token';

// --- JWT secret: persisted so sessions survive restarts ---
const secretFile = path.join(__dirname, 'data', '.jwt-secret');
let JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  if (fs.existsSync(secretFile)) {
    JWT_SECRET = fs.readFileSync(secretFile, 'utf8').trim();
  } else {
    JWT_SECRET = crypto.randomBytes(48).toString('hex');
    fs.writeFileSync(secretFile, JWT_SECRET, { mode: 0o600 });
  }
}

const PALETTE = ['#6366f1', '#ec4899', '#10b981', '#f59e0b', '#0ea5e9', '#8b5cf6', '#ef4444', '#14b8a6'];

/* ----------------------------------------------------------------
   Middleware
   ---------------------------------------------------------------- */
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
    },
  },
}));
app.use(express.json({ limit: '64kb' }));
app.use(cookieParser());

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please try again later.' },
});

/* ----------------------------------------------------------------
   Helpers
   ---------------------------------------------------------------- */
const uid = () => crypto.randomBytes(9).toString('hex');
const now = () => Date.now();

function publicUser(u) {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    totalLeaveDays: u.total_leave_days,
    color: u.color,
    isAdmin: !!u.is_admin,
    carryoverDays: u.carryover_days || 0,
    carryoverExpiry: u.carryover_expiry || '',
    allowanceYear: u.allowance_year || new Date().getFullYear(),
    createdAt: u.created_at,
  };
}

const LEAVE_TYPES = ['holiday', 'sick', 'remote', 'other'];
// Only these types draw down the annual allowance / carryover pool.
const COUNTING_TYPES = new Set(['holiday']);

function publicLeave(l) {
  return {
    id: l.id,
    userId: l.user_id,
    startDate: l.start_date,
    endDate: l.end_date,
    note: l.note || '',
    type: LEAVE_TYPES.includes(l.type) ? l.type : 'holiday',
  };
}

function setAuthCookie(res, userId) {
  const token = jwt.sign({ uid: userId }, JWT_SECRET, { expiresIn: '30d' });
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: PROD,
    maxAge: 30 * 24 * 60 * 60 * 1000,
    path: '/',
  });
}

function auth(req, res, next) {
  const token = req.cookies[COOKIE];
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.uid);
    if (!user) return res.status(401).json({ error: 'Session no longer valid' });
    req.user = applyRollover(user);
    next();
  } catch {
    return res.status(401).json({ error: 'Session no longer valid' });
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function validDate(s) {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(s + 'T00:00:00');
  return !isNaN(d.getTime());
}

/* ----------------------------------------------------------------
   Working-day calculation (mirrors the frontend, incl. SI holidays)
   Used by the automatic year-end carryover rollover.
   ---------------------------------------------------------------- */
const pad2 = (n) => String(n).padStart(2, '0');
const fmtDate = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const parseISO = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };

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
  const set = new Set();
  const add = (mo, d) => set.add(fmtDate(new Date(year, mo - 1, d)));
  add(1, 1); add(1, 2); add(2, 8); add(4, 27); add(5, 1); add(5, 2);
  add(6, 25); add(8, 15); add(10, 31); add(11, 1); add(12, 25); add(12, 26);
  const easter = easterSunday(year);
  set.add(fmtDate(easter));
  const em = new Date(easter); em.setDate(easter.getDate() + 1); set.add(fmtDate(em));
  const wh = new Date(easter); wh.setDate(easter.getDate() + 49); set.add(fmtDate(wh));
  holidayCache[year] = set;
  return set;
}
const isHolidayDate = (d) => slovenianHolidays(d.getFullYear()).has(fmtDate(d));
const isWeekendDate = (d) => { const x = d.getDay(); return x === 0 || x === 6; };

function workingDays(startStr, endStr) {
  const start = parseISO(startStr), end = parseISO(endStr);
  if (!start || !end || end < start) return 0;
  let count = 0;
  const cur = new Date(start);
  while (cur <= end) {
    if (!isWeekendDate(cur) && !isHolidayDate(cur)) count++;
    cur.setDate(cur.getDate() + 1);
  }
  return count;
}

/* ----------------------------------------------------------------
   Prepared statements
   ---------------------------------------------------------------- */
const Q = {
  userCount: db.prepare('SELECT COUNT(*) AS c FROM users'),
  userByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
  userById: db.prepare('SELECT * FROM users WHERE id = ?'),
  insertUser: db.prepare(`INSERT INTO users (id, name, email, password_hash, total_leave_days, color, is_admin, carryover_days, carryover_expiry, allowance_year, created_at)
                          VALUES (@id, @name, @email, @password_hash, @total_leave_days, @color, @is_admin, @carryover_days, @carryover_expiry, @allowance_year, @created_at)`),
  updateUser: db.prepare('UPDATE users SET name = @name, total_leave_days = @total_leave_days, color = @color, carryover_days = @carryover_days, carryover_expiry = @carryover_expiry WHERE id = @id'),
  updateCarryover: db.prepare('UPDATE users SET carryover_days = @carryover_days, carryover_expiry = @carryover_expiry, allowance_year = @allowance_year WHERE id = @id'),
  allUsers: db.prepare('SELECT * FROM users ORDER BY created_at ASC'),

  allLeaves: db.prepare('SELECT * FROM leaves ORDER BY start_date ASC'),
  leavesByUser: db.prepare('SELECT * FROM leaves WHERE user_id = ?'),
  leaveById: db.prepare('SELECT * FROM leaves WHERE id = ?'),
  insertLeave: db.prepare(`INSERT INTO leaves (id, user_id, start_date, end_date, note, type, created_at)
                           VALUES (@id, @user_id, @start_date, @end_date, @note, @type, @created_at)`),
  updateLeave: db.prepare('UPDATE leaves SET start_date = @start_date, end_date = @end_date, note = @note, type = @type WHERE id = @id'),
  deleteLeave: db.prepare('DELETE FROM leaves WHERE id = ?'),

  inviteByToken: db.prepare('SELECT * FROM invites WHERE token = ?'),
  insertInvite: db.prepare(`INSERT INTO invites (token, created_by, used, used_by, created_at)
                            VALUES (@token, @created_by, 0, NULL, @created_at)`),
  useInvite: db.prepare('UPDATE invites SET used = 1, used_by = ? WHERE token = ?'),
  invitesByCreator: db.prepare('SELECT * FROM invites WHERE created_by = ? ORDER BY created_at DESC'),
};

/* ----------------------------------------------------------------
   Year-end carryover rollover
   When a new calendar year begins, whatever is left of a user's annual
   allowance becomes their carryover for the new year. Last year's
   carryover that wasn't used is forfeited (it expired). The carryover's
   expiry rolls to the same month/day in the new year.
   ---------------------------------------------------------------- */
function countingWorkingDaysForYear(userId, year) {
  const leaves = Q.leavesByUser.all(userId);
  let sum = 0;
  for (const l of leaves) {
    const type = l.type || 'holiday';
    if (!COUNTING_TYPES.has(type)) continue;
    if (parseInt(String(l.start_date).slice(0, 4), 10) !== year) continue;
    sum += workingDays(l.start_date, l.end_date);
  }
  return sum;
}

function applyRollover(user) {
  const currentYear = new Date().getFullYear();
  let allowanceYear = user.allowance_year || 0;
  if (!allowanceYear) {
    allowanceYear = currentYear;
    Q.updateCarryover.run({
      id: user.id,
      carryover_days: user.carryover_days || 0,
      carryover_expiry: user.carryover_expiry || null,
      allowance_year: currentYear,
    });
    user.allowance_year = currentYear;
    return user;
  }
  if (allowanceYear >= currentYear) return user;

  let carry = user.carryover_days || 0;
  let expiry = user.carryover_expiry || null;
  for (let y = allowanceYear; y < currentYear; y++) {
    const used = countingWorkingDaysForYear(user.id, y);
    // Carryover is consumed first, then the annual allowance.
    const annualUsed = Math.max(0, used - carry);
    const annualRemaining = Math.max(0, (user.total_leave_days || 0) - annualUsed);
    carry = annualRemaining; // leftover annual becomes next year's carryover
    expiry = (expiry && DATE_RE.test(expiry)) ? `${y + 1}${expiry.slice(4)}` : null;
  }

  Q.updateCarryover.run({
    id: user.id,
    carryover_days: carry,
    carryover_expiry: expiry,
    allowance_year: currentYear,
  });
  user.carryover_days = carry;
  user.carryover_expiry = expiry;
  user.allowance_year = currentYear;
  return user;
}

/* ================================================================
   AUTH ROUTES
   ================================================================ */

// Public status — does the team already have users?
app.get('/api/status', (req, res) => {
  const hasUsers = Q.userCount.get().c > 0;
  res.json({ hasUsers });
});

// Validate an invite token (used by the registration link)
app.get('/api/invites/:token/valid', (req, res) => {
  const invite = Q.inviteByToken.get(req.params.token);
  res.json({ valid: !!invite && !invite.used });
});

app.post('/api/auth/register', authLimiter, async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    let totalLeaveDays = parseInt(req.body.totalLeaveDays, 10);
    let carryoverDays = parseInt(req.body.carryoverDays, 10);
    let carryoverExpiry = String(req.body.carryoverExpiry || '').trim();
    const inviteToken = String(req.body.inviteToken || '').trim();

    if (!name || name.length > 80) return res.status(400).json({ error: 'Please enter your name.' });
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Please enter a valid email.' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    if (isNaN(totalLeaveDays) || totalLeaveDays < 0 || totalLeaveDays > 366) totalLeaveDays = 25;
    if (isNaN(carryoverDays) || carryoverDays < 0 || carryoverDays > 366) carryoverDays = 0;
    if (carryoverExpiry && !validDate(carryoverExpiry)) carryoverExpiry = '';

    const count = Q.userCount.get().c;
    const isFirst = count === 0;

    let invite = null;
    if (!isFirst) {
      invite = Q.inviteByToken.get(inviteToken);
      if (!invite || invite.used) {
        return res.status(403).json({ error: 'A valid, unused invite link is required to register.' });
      }
    }

    if (Q.userByEmail.get(email)) {
      return res.status(409).json({ error: 'An account with that email already exists.' });
    }

    const password_hash = await bcrypt.hash(password, 12);
    const user = {
      id: uid(),
      name,
      email,
      password_hash,
      total_leave_days: totalLeaveDays,
      color: PALETTE[count % PALETTE.length],
      is_admin: isFirst ? 1 : 0,
      carryover_days: carryoverDays,
      carryover_expiry: carryoverExpiry || null,
      allowance_year: new Date().getFullYear(),
      created_at: now(),
    };

    const tx = db.transaction(() => {
      Q.insertUser.run(user);
      if (invite) Q.useInvite.run(user.id, invite.token);
    });
    tx();

    setAuthCookie(res, user.id);
    res.status(201).json({ user: publicUser(user) });
  } catch (err) {
    console.error('register error', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

app.post('/api/auth/login', authLimiter, async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const user = Q.userByEmail.get(email);
    // Always run a compare to reduce timing differences / user enumeration.
    const hash = user ? user.password_hash : '$2a$12$0000000000000000000000000000000000000000000000000000';
    const ok = await bcrypt.compare(password, hash);
    if (!user || !ok) return res.status(401).json({ error: 'Incorrect email or password.' });

    setAuthCookie(res, user.id);
    res.json({ user: publicUser(applyRollover(user)) });
  } catch (err) {
    console.error('login error', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie(COOKIE, { path: '/' });
  res.json({ ok: true });
});

app.get('/api/auth/me', auth, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

/* ================================================================
   USERS
   ================================================================ */
app.get('/api/users', auth, (req, res) => {
  res.json({ users: Q.allUsers.all().map(publicUser) });
});

app.patch('/api/users/me', auth, (req, res) => {
  const name = String(req.body.name || '').trim();
  let totalLeaveDays = parseInt(req.body.totalLeaveDays, 10);
  const color = String(req.body.color || req.user.color);
  let carryoverDays = parseInt(req.body.carryoverDays, 10);
  let carryoverExpiry = String(req.body.carryoverExpiry || '').trim();

  if (!name || name.length > 80) return res.status(400).json({ error: 'Please enter a valid name.' });
  if (isNaN(totalLeaveDays) || totalLeaveDays < 0 || totalLeaveDays > 366) totalLeaveDays = req.user.total_leave_days;
  if (!/^#[0-9a-fA-F]{6}$/.test(color)) return res.status(400).json({ error: 'Invalid colour.' });
  if (isNaN(carryoverDays) || carryoverDays < 0 || carryoverDays > 366) carryoverDays = req.user.carryover_days || 0;
  if (carryoverExpiry && !validDate(carryoverExpiry)) return res.status(400).json({ error: 'Invalid carryover expiry date.' });

  Q.updateUser.run({
    id: req.user.id,
    name,
    total_leave_days: totalLeaveDays,
    color,
    carryover_days: carryoverDays,
    carryover_expiry: carryoverExpiry || null,
  });
  res.json({ user: publicUser(Q.userById.get(req.user.id)) });
});

/* ================================================================
   LEAVES
   ================================================================ */
app.get('/api/leaves', auth, (req, res) => {
  res.json({ leaves: Q.allLeaves.all().map(publicLeave) });
});

function validateLeaveBody(req, res) {
  const startDate = String(req.body.startDate || '');
  const endDate = String(req.body.endDate || '');
  const note = String(req.body.note || '').trim().slice(0, 80);
  let type = String(req.body.type || 'holiday').trim().toLowerCase();
  if (!LEAVE_TYPES.includes(type)) type = 'holiday';
  if (!validDate(startDate) || !validDate(endDate)) {
    res.status(400).json({ error: 'Invalid dates.' });
    return null;
  }
  if (endDate < startDate) {
    res.status(400).json({ error: 'End date must be on or after the start date.' });
    return null;
  }
  return { startDate, endDate, note, type };
}

app.post('/api/leaves', auth, (req, res) => {
  const data = validateLeaveBody(req, res);
  if (!data) return;
  const leave = {
    id: uid(),
    user_id: req.user.id,
    start_date: data.startDate,
    end_date: data.endDate,
    note: data.note,
    type: data.type,
    created_at: now(),
  };
  Q.insertLeave.run(leave);
  res.status(201).json({ leave: publicLeave(leave) });
});

app.patch('/api/leaves/:id', auth, (req, res) => {
  const existing = Q.leaveById.get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Leave not found.' });
  if (existing.user_id !== req.user.id) return res.status(403).json({ error: 'You can only edit your own leave.' });

  const data = validateLeaveBody(req, res);
  if (!data) return;
  Q.updateLeave.run({ id: existing.id, start_date: data.startDate, end_date: data.endDate, note: data.note, type: data.type });
  res.json({ leave: publicLeave(Q.leaveById.get(existing.id)) });
});

app.delete('/api/leaves/:id', auth, (req, res) => {
  const existing = Q.leaveById.get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Leave not found.' });
  if (existing.user_id !== req.user.id && !req.user.is_admin) {
    return res.status(403).json({ error: 'You can only delete your own leave.' });
  }
  Q.deleteLeave.run(existing.id);
  res.json({ ok: true });
});

/* ================================================================
   INVITES
   ================================================================ */
app.get('/api/invites', auth, (req, res) => {
  const invites = Q.invitesByCreator.all(req.user.id)
    .map(i => ({ token: i.token, used: !!i.used, createdAt: i.created_at }));
  res.json({ invites });
});

app.post('/api/invites', auth, (req, res) => {
  const invite = {
    token: crypto.randomBytes(18).toString('base64url'),
    created_by: req.user.id,
    created_at: now(),
  };
  Q.insertInvite.run(invite);
  res.status(201).json({ token: invite.token });
});

/* ================================================================
   STATIC FRONTEND
   ================================================================ */
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n  Holiday Leave Tracker running at http://localhost:${PORT}\n`);
});
