/**
 * server.js
 * 
 * Unified Node.js server that:
 * 1. Serves the public website (Vite built files from /dist)
 * 2. Provides the private /admin panel, protected by password
 * 3. Handles API requests for blocking dates & generates .ics files
 */

import express from 'express';
import basicAuth from 'express-basic-auth';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BOOKINGS_FILE = path.join(__dirname, 'data', 'direct-bookings.json');
const HOMESTAYS_FILE = path.join(__dirname, 'data', 'homestays.json');
const PENDING_FILE = path.join(__dirname, 'data', 'pending-requests.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const DIST_DIR = path.join(__dirname, 'dist');
const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.json());

// ─────────────────────────────────────────────────────────────────────────────
//  Public API (No Auth)
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/request-booking', (req, res) => {
  const payload = req.body;
  if (!fs.existsSync(PENDING_FILE)) fs.writeFileSync(PENDING_FILE, '[]');
  const pending = JSON.parse(fs.readFileSync(PENDING_FILE, 'utf-8'));
  
  payload.id = Date.now().toString(); // unique ID
  payload.timestamp = new Date().toISOString();
  
  pending.push(payload);
  fs.writeFileSync(PENDING_FILE, JSON.stringify(pending, null, 2));
  res.json({ success: true, id: payload.id });
});

// ─────────────────────────────────────────────────────────────────────────────
//  PASSWORD PROTECTION (Basic Auth)
// ─────────────────────────────────────────────────────────────────────────────
const authMiddleware = basicAuth({
  users: { 'admin': 'volgo123' }, // Default username: admin, password: volgo123
  challenge: true,
  realm: 'Volgo Admin'
});

// Protect the admin routes
app.use('/admin', authMiddleware);
app.use('/api', authMiddleware);

// ─────────────────────────────────────────────────────────────────────────────
//  iCal generator
// ─────────────────────────────────────────────────────────────────────────────
function icalDate(str) { return str.replace(/-/g, ''); }
function icalNow() { return new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z'; }
function foldLine(l) {
  const MAX = 75;
  if (l.length <= MAX) return l;
  let out = '';
  while (l.length > MAX) { out += l.substring(0, MAX) + '\r\n '; l = l.substring(MAX); }
  return out + l;
}

function regenerateIcal() {
  if (!fs.existsSync(PUBLIC_DIR)) fs.mkdirSync(PUBLIC_DIR, { recursive: true });
  const properties = JSON.parse(fs.readFileSync(HOMESTAYS_FILE, 'utf-8'));
  const allBlocked = JSON.parse(fs.readFileSync(BOOKINGS_FILE, 'utf-8'));

  for (const prop of properties) {
    const record = allBlocked.find(b => b.propertyId === prop.id);
    const periods = record ? record.blockedPeriods : [];
    const now = icalNow();

    const lines = [
      'BEGIN:VCALENDAR', 'VERSION:2.0',
      `PRODID:-//Volgo Homestay//${prop.name}//EN`,
      'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
      `X-WR-CALNAME:${prop.name} – Availability`,
      'X-WR-TIMEZONE:Asia/Kolkata',
    ];

    periods.forEach((p, i) => {
      lines.push('BEGIN:VEVENT',
        `UID:blocked-${i + 1}-${prop.id}@volgohomestay`,
        `DTSTAMP:${now}`,
        `DTSTART;VALUE=DATE:${icalDate(p.from)}`,
        `DTEND;VALUE=DATE:${icalDate(p.to)}`,
        'SUMMARY:Not Available',
        'STATUS:CONFIRMED', 'TRANSP:OPAQUE', 'END:VEVENT');
    });
    lines.push('END:VCALENDAR');

    // Also write to dist if it exists, so the live server serves the updated file
    const icsContent = lines.map(foldLine).join('\r\n') + '\r\n';
    fs.writeFileSync(path.join(PUBLIC_DIR, `${prop.id}.ics`), icsContent, 'utf-8');
    
    if (fs.existsSync(DIST_DIR)) {
      fs.writeFileSync(path.join(DIST_DIR, `${prop.id}.ics`), icsContent, 'utf-8');
    }
    
    console.log(`[ical] Regenerated ${prop.id}.ics — ${periods.length} blocked period(s)`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  API: get blocked periods
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/periods/:propertyId', (req, res) => {
  const data = JSON.parse(fs.readFileSync(BOOKINGS_FILE, 'utf-8'));
  const record = data.find(b => b.propertyId === req.params.propertyId);
  res.json(record ? record.blockedPeriods : []);
});

// ─────────────────────────────────────────────────────────────────────────────
//  API: add a blocked period
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/periods/:propertyId', (req, res) => {
  const { from, to, note } = req.body;
  if (!from || !to || from >= to) {
    return res.status(400).json({ error: 'Invalid dates. "from" must be before "to".' });
  }

  const data = JSON.parse(fs.readFileSync(BOOKINGS_FILE, 'utf-8'));
  let record = data.find(b => b.propertyId === req.params.propertyId);

  if (!record) {
    record = { propertyId: req.params.propertyId, blockedPeriods: [] };
    data.push(record);
  }

  const overlap = record.blockedPeriods.some(p => from < p.to && to > p.from);
  if (overlap) {
    return res.status(409).json({ error: 'These dates overlap with an existing blocked period.' });
  }

  record.blockedPeriods.push({ from, to, ...(note ? { note } : {}) });
  record.blockedPeriods.sort((a, b) => a.from.localeCompare(b.from));

  fs.writeFileSync(BOOKINGS_FILE, JSON.stringify(data, null, 2), 'utf-8');
  regenerateIcal();
  res.json({ success: true, periods: record.blockedPeriods });
});

// ─────────────────────────────────────────────────────────────────────────────
//  API: remove a blocked period by index
// ─────────────────────────────────────────────────────────────────────────────
app.delete('/api/periods/:propertyId/:index', (req, res) => {
  const idx = parseInt(req.params.index, 10);
  const data = JSON.parse(fs.readFileSync(BOOKINGS_FILE, 'utf-8'));
  const rec = data.find(b => b.propertyId === req.params.propertyId);

  if (!rec || idx < 0 || idx >= rec.blockedPeriods.length) {
    return res.status(404).json({ error: 'Period not found.' });
  }

  rec.blockedPeriods.splice(idx, 1);
  fs.writeFileSync(BOOKINGS_FILE, JSON.stringify(data, null, 2), 'utf-8');
  regenerateIcal();
  res.json({ success: true, periods: rec.blockedPeriods });
});

// ─────────────────────────────────────────────────────────────────────────────
//  API: get, approve, decline pending requests
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/pending-requests', (req, res) => {
  if (!fs.existsSync(PENDING_FILE)) return res.json([]);
  res.json(JSON.parse(fs.readFileSync(PENDING_FILE, 'utf-8')));
});

app.post('/api/approve-request/:id', (req, res) => {
  const id = req.params.id;
  if (!fs.existsSync(PENDING_FILE)) return res.status(404).json({error: 'Not found'});
  let pending = JSON.parse(fs.readFileSync(PENDING_FILE, 'utf-8'));
  const reqObj = pending.find(r => r.id === id);
  
  if (!reqObj) return res.status(404).json({error: 'Request not found'});
  
  // Add to direct-bookings.json
  const data = JSON.parse(fs.readFileSync(BOOKINGS_FILE, 'utf-8'));
  let record = data.find(b => b.propertyId === reqObj.homestayId);
  if (!record) {
    record = { propertyId: reqObj.homestayId, blockedPeriods: [] };
    data.push(record);
  }
  
  const d1 = new Date(reqObj.checkInMs);
  const d2 = new Date(reqObj.checkOutMs);
  const fromStr = d1.toISOString().split('T')[0];
  const toStr = d2.toISOString().split('T')[0];
  
  record.blockedPeriods.push({
    from: fromStr,
    to: toStr,
    note: `[Approved] ${reqObj.guestName} (${reqObj.adults}A, ${reqObj.children}C) ${reqObj.note}`
  });
  
  fs.writeFileSync(BOOKINGS_FILE, JSON.stringify(data, null, 2));
  regenerateIcal();
  
  // Remove from pending
  pending = pending.filter(r => r.id !== id);
  fs.writeFileSync(PENDING_FILE, JSON.stringify(pending, null, 2));
  
  res.json({ success: true });
});

app.delete('/api/decline-request/:id', (req, res) => {
  const id = req.params.id;
  if (!fs.existsSync(PENDING_FILE)) return res.json({success: true});
  let pending = JSON.parse(fs.readFileSync(PENDING_FILE, 'utf-8'));
  pending = pending.filter(r => r.id !== id);
  fs.writeFileSync(PENDING_FILE, JSON.stringify(pending, null, 2));
  res.json({ success: true });
});

// ─────────────────────────────────────────────────────────────────────────────
//  GET /admin → Serve the protected admin UI
// ─────────────────────────────────────────────────────────────────────────────
app.get('/admin', (req, res) => {
  const properties = JSON.parse(fs.readFileSync(HOMESTAYS_FILE, 'utf-8'));
  const propertyOptions = properties.map(p =>
    `<option value="${p.id}">${p.name}</option>`
  ).join('');

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Volgo Homestay — Booking Admin</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --bg:       #0d0e11;
      --surface:  #16181d;
      --border:   rgba(255,255,255,0.08);
      --accent:   #d6af37;
      --accent2:  #f0cc60;
      --text:     #f0f0f0;
      --muted:    #7a7a8a;
      --danger:   #e05555;
      --success:  #4caf87;
      --radius:   14px;
    }

    body {
      font-family: 'Inter', sans-serif;
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
      padding: 0 0 60px;
    }

    /* ── Header ── */
    header {
      background: var(--surface);
      border-bottom: 1px solid var(--border);
      padding: 20px 40px;
      display: flex;
      align-items: center;
      gap: 16px;
      position: sticky;
      top: 0;
      z-index: 100;
    }
    .logo-text { font-size: 22px; font-weight: 700; letter-spacing: 3px; color: var(--accent); }
    .logo-divider { width: 1px; height: 28px; background: var(--border); }
    .header-title { font-size: 15px; color: var(--muted); font-weight: 400; }

    /* ── Layout ── */
    .container { max-width: 820px; margin: 0 auto; padding: 40px 24px 0; }

    /* ── Card ── */
    .card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 28px 32px;
      margin-bottom: 24px;
    }
    .card-title {
      font-size: 13px;
      text-transform: uppercase;
      letter-spacing: 1.5px;
      color: var(--accent);
      font-weight: 600;
      margin-bottom: 24px;
    }

    /* ── Pending Requests ── */
    .request-card {
      background: rgba(255,255,255,0.02);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 20px;
      margin-bottom: 16px;
      transition: border-color 0.2s;
    }
    .request-card:hover { border-color: rgba(255,255,255,0.15); }
    .request-header { display: flex; justify-content: space-between; margin-bottom: 12px; border-bottom: 1px solid rgba(255,255,255,0.05); padding-bottom: 12px; }
    .request-guest { font-weight: 600; font-size: 16px; color: var(--accent2); }
    .request-prop { color: var(--muted); font-size: 13px; }
    .request-dates { font-size: 15px; font-weight: 500; margin-bottom: 6px; }
    .request-details { font-size: 13px; color: #a0a0a0; margin-bottom: 12px; }
    .request-note { font-size: 13px; font-style: italic; color: #d0d0d0; background: rgba(255,255,255,0.05); padding: 12px; border-radius: 8px; margin-bottom: 16px; border-left: 3px solid var(--accent); }
    .request-actions { display: flex; gap: 12px; }
    .btn-approve { background: var(--success); color: #fff; border: none; padding: 10px 16px; border-radius: 8px; cursor: pointer; font-size: 13px; font-weight: 600; }
    .btn-decline { background: rgba(224,85,85,0.2); color: var(--danger); border: 1px solid var(--danger); padding: 10px 16px; border-radius: 8px; cursor: pointer; font-size: 13px; font-weight: 600; }
    .btn-whatsapp { background: #25d366; color: #fff; border: none; padding: 10px 16px; border-radius: 8px; cursor: pointer; font-size: 13px; font-weight: 600; text-decoration: none; }

    /* ── Form ── */
    .form-row {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 16px;
      margin-bottom: 16px;
    }
    .form-row.full { grid-template-columns: 1fr; }

    label {
      display: block;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 1px;
      color: var(--muted);
      margin-bottom: 8px;
      font-weight: 500;
    }
    input[type="date"], input[type="text"], select {
      width: 100%;
      background: rgba(255,255,255,0.04);
      border: 1px solid var(--border);
      border-radius: 10px;
      color: var(--text);
      font-family: 'Inter', sans-serif;
      font-size: 15px;
      padding: 12px 16px;
      transition: border-color 0.2s;
      outline: none;
    }
    input[type="date"]:focus, input[type="text"]:focus, select:focus { border-color: var(--accent); }
    input[type="date"]::-webkit-calendar-picker-indicator { filter: invert(0.6); cursor: pointer; }
    select option { background: #1e2028; }

    /* ── Button ── */
    .btn { display: inline-flex; align-items: center; gap: 8px; padding: 13px 28px; border-radius: 10px; font-family: 'Inter', sans-serif; font-size: 14px; font-weight: 600; cursor: pointer; border: none; transition: all 0.2s; }
    .btn-primary { background: var(--accent); color: #000; width: 100%; justify-content: center; margin-top: 8px; }
    .btn-primary:hover { background: var(--accent2); transform: translateY(-1px); }

    /* ── Toast ── */
    #toast { position: fixed; bottom: 32px; left: 50%; transform: translateX(-50%) translateY(20px); background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 14px 24px; font-size: 14px; opacity: 0; transition: all 0.35s cubic-bezier(0.34, 1.56, 0.64, 1); z-index: 999; pointer-events: none; white-space: nowrap; }
    #toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }
    #toast.success { border-color: var(--success); color: var(--success); }
    #toast.error   { border-color: var(--danger);  color: var(--danger); }

    /* ── Periods List ── */
    .periods-list { display: flex; flex-direction: column; gap: 10px; }
    .period-row { display: flex; align-items: center; justify-content: space-between; background: rgba(255,255,255,0.03); border: 1px solid var(--border); border-radius: 10px; padding: 14px 18px; transition: border-color 0.2s; }
    .period-row:hover { border-color: rgba(255,255,255,0.15); }
    .period-dates { font-size: 15px; font-weight: 500; }
    .period-duration { font-size: 13px; color: var(--muted); margin-top: 3px; }
    .period-note { font-size: 12px; color: var(--accent); margin-top: 2px; }
    .btn-delete { background: transparent; border: 1px solid rgba(224,85,85,0.3); color: var(--danger); border-radius: 8px; padding: 7px 14px; font-size: 13px; cursor: pointer; font-family: 'Inter', sans-serif; transition: all 0.2s; }
    .btn-delete:hover { background: rgba(224,85,85,0.1); border-color: var(--danger); }
    .empty-state { text-align: center; padding: 32px; color: var(--muted); font-size: 14px; }
  </style>
</head>
<body>

<header>
  <div class="logo-text">VOLGO</div>
  <div class="logo-divider"></div>
  <div class="header-title">Booking Admin — Availability Manager</div>
</header>

<div class="container">
  
  <!-- PENDING REQUESTS -->
  <div class="card" style="border-top: 2px solid var(--accent);">
    <div class="card-title">Pending Booking Requests</div>
    <div id="pendingList">
      <div class="empty-state">Loading requests...</div>
    </div>
  </div>

  <!-- Property selector -->
  <div class="card">
    <div class="card-title">Property</div>
    <div class="form-row full">
      <div>
        <label>Select Property</label>
        <select id="propertySelect" onchange="loadPeriods()">
          ${propertyOptions}
        </select>
      </div>
    </div>
  </div>

  <!-- Block new dates -->
  <div class="card">
    <div class="card-title">Manual Block Dates</div>
    <div class="form-row">
      <div>
        <label>Check-in Date</label>
        <input type="date" id="fromDate">
      </div>
      <div>
        <label>Check-out Date</label>
        <input type="date" id="toDate">
      </div>
    </div>
    <div class="form-row full">
      <div>
        <label>Note (optional — for your reference only)</label>
        <input type="text" id="noteInput" placeholder="e.g. Family from Chennai, 3 nights">
      </div>
    </div>
    <button class="btn btn-primary" onclick="addPeriod()">
      ⊕ &nbsp; Block These Dates
    </button>
  </div>

  <!-- Currently blocked periods -->
  <div class="card">
    <div class="card-title">Currently Blocked Periods</div>
    <div id="periodsList" class="periods-list">
      <div class="empty-state">Loading...</div>
    </div>
  </div>

</div>

<div id="toast"></div>

<script>
  function showToast(msg, type = 'success') {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.className = 'show ' + type;
    setTimeout(() => { t.className = ''; }, 3000);
  }

  function nights(from, to) {
    const ms = new Date(to) - new Date(from);
    const n  = Math.round(ms / 86400000);
    return n === 1 ? '1 night' : n + ' nights';
  }

  function fmtDate(str) {
    return new Date(str + 'T00:00:00').toLocaleDateString('en-IN', {
      day: 'numeric', month: 'short', year: 'numeric'
    });
  }

  function getPropertyId() { return document.getElementById('propertySelect').value; }

  async function loadPendingRequests() {
    const res = await fetch('/api/pending-requests');
    const requests = await res.json();
    const list = document.getElementById('pendingList');
    
    if (!requests.length) {
      list.innerHTML = '<div class="empty-state">No pending requests right now.</div>';
      return;
    }
    
    list.innerHTML = requests.map(r => {
      const wNumber = r.guestPhone.replace(/[^+\\d]/g, '');
      const d1 = new Date(r.checkInMs).toLocaleDateString();
      const d2 = new Date(r.checkOutMs).toLocaleDateString();
      
      return \`
        <div class="request-card">
          <div class="request-header">
            <span class="request-guest">\${r.guestName}</span>
            <span class="request-prop">\${r.homestayName}</span>
          </div>
          <div class="request-dates">\${d1} → \${d2}</div>
          <div class="request-details">\${r.adults} Adults, \${r.children} Children | Phone: \${r.guestPhone}</div>
          \${r.note ? \`<div class="request-note">"\${r.note}"</div>\` : ''}
          <div class="request-actions">
            <button class="btn-approve" onclick="approveRequest('\${r.id}')">Approve</button>
            <button class="btn-decline" onclick="declineRequest('\${r.id}')">Decline</button>
            <a class="btn-whatsapp" href="https://wa.me/\${wNumber}?text=Hi \${r.guestName}, regarding your booking..." target="_blank">Message</a>
          </div>
        </div>
      \`;
    }).join('');
  }
  
  async function approveRequest(id) {
    if (!confirm('Approve?')) return;
    const res = await fetch('/api/approve-request/' + id, { method: 'POST' });
    if (res.ok) { showToast('Approved!'); loadPendingRequests(); loadPeriods(); }
  }
  
  async function declineRequest(id) {
    if (!confirm('Decline?')) return;
    const res = await fetch('/api/decline-request/' + id, { method: 'DELETE' });
    if (res.ok) { showToast('Declined'); loadPendingRequests(); }
  }

  async function loadPeriods() {
    const pid = getPropertyId();
    const res = await fetch('/api/periods/' + pid);
    const periods = await res.json();
    const list = document.getElementById('periodsList');

    if (!periods.length) {
      list.innerHTML = '<div class="empty-state">No dates blocked yet.</div>';
      return;
    }

    list.innerHTML = periods.map((p, i) => \`
      <div class="period-row">
        <div>
          <div class="period-dates">\${fmtDate(p.from)} &nbsp;→&nbsp; \${fmtDate(p.to)}</div>
          <div class="period-duration">\${nights(p.from, p.to)}</div>
          \${p.note ? \`<div class="period-note">\${p.note}</div>\` : ''}
        </div>
        <button class="btn-delete" onclick="removePeriod(\${i})">Remove</button>
      </div>
    \`).join('');
  }

  async function addPeriod() {
    const from = document.getElementById('fromDate').value;
    const to = document.getElementById('toDate').value;
    const note = document.getElementById('noteInput').value;
    if (!from || !to) return showToast('Please select dates', 'error');
    const res = await fetch('/api/periods/' + getPropertyId(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to, note })
    });
    if (res.ok) {
      showToast('Dates blocked');
      document.getElementById('fromDate').value = '';
      document.getElementById('toDate').value = '';
      document.getElementById('noteInput').value = '';
      loadPeriods();
    }
  }

  async function removePeriod(index) {
    if (!confirm('Remove this blocked period?')) return;
    const res  = await fetch('/api/periods/' + getPropertyId() + '/' + index, { method: 'DELETE' });
    if (res.ok) {
      showToast('Dates unblocked');
      loadPeriods();
    }
  }

  loadPeriods();
  loadPendingRequests();
</script>
</body>
</html>`);
});

// ─────────────────────────────────────────────────────────────────────────────
//  Public Website Serving
// ─────────────────────────────────────────────────────────────────────────────
app.use(express.static(DIST_DIR));
app.use(express.static(PUBLIC_DIR));

const DATA_DIR = path.join(__dirname, 'data');
const ASSETS_DIR = path.join(__dirname, 'assets');
app.use('/data', express.static(DATA_DIR));
app.use('/assets', express.static(ASSETS_DIR));

// ─────────────────────────────────────────────────────────────────────────────
//  Start Server
// ─────────────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(' VOLGO HOMESTAY — Unified Server');
  console.log(`\n  Public Website : http://localhost:${PORT}`);
  console.log(`  Admin Panel    : http://localhost:${PORT}/admin`);
  console.log('\n  Login credentials for Admin:');
  console.log('    Username: admin');
  console.log('    Password: volgo123');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
});
