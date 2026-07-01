/**
 * admin-server.js
 *
 * Local admin panel for managing blocked dates.
 * Run with:  npm run admin
 * Then open: http://localhost:3001
 *
 * You can pick check-in / check-out dates from a form,
 * click "Block Dates", and everything updates automatically —
 * no JSON editing or terminal commands needed.
 */

import express   from 'express';
import fs        from 'fs';
import path      from 'path';
import { fileURLToPath } from 'url';

const __dirname      = path.dirname(fileURLToPath(import.meta.url));
const BOOKINGS_FILE  = path.join(__dirname, 'data', 'direct-bookings.json');
const HOMESTAYS_FILE = path.join(__dirname, 'data', 'homestays.json');
const PUBLIC_DIR     = path.join(__dirname, 'public');
const PORT           = 3001;

const app = express();
app.use(express.json());

// ─────────────────────────────────────────────────────────────────────────────
//  iCal generator (inline — so admin server is self-contained)
// ─────────────────────────────────────────────────────────────────────────────
function icalDate(str) { return str.replace(/-/g, ''); }
function icalNow()     { return new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z'; }
function foldLine(l)   {
  const MAX = 75;
  if (l.length <= MAX) return l;
  let out = '';
  while (l.length > MAX) { out += l.substring(0, MAX) + '\r\n '; l = l.substring(MAX); }
  return out + l;
}

function regenerateIcal() {
  if (!fs.existsSync(PUBLIC_DIR)) fs.mkdirSync(PUBLIC_DIR, { recursive: true });
  const properties = JSON.parse(fs.readFileSync(HOMESTAYS_FILE, 'utf-8'));
  const allBlocked = JSON.parse(fs.readFileSync(BOOKINGS_FILE,  'utf-8'));

  for (const prop of properties) {
    const record  = allBlocked.find(b => b.propertyId === prop.id);
    const periods = record ? record.blockedPeriods : [];
    const now     = icalNow();

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

    fs.writeFileSync(
      path.join(PUBLIC_DIR, `${prop.id}.ics`),
      lines.map(foldLine).join('\r\n') + '\r\n',
      'utf-8'
    );
    console.log(`[ical] Regenerated ${prop.id}.ics — ${periods.length} blocked period(s)`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  API: get blocked periods
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/periods/:propertyId', (req, res) => {
  const data   = JSON.parse(fs.readFileSync(BOOKINGS_FILE, 'utf-8'));
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

  const data   = JSON.parse(fs.readFileSync(BOOKINGS_FILE, 'utf-8'));
  let   record = data.find(b => b.propertyId === req.params.propertyId);

  if (!record) {
    record = { propertyId: req.params.propertyId, blockedPeriods: [] };
    data.push(record);
  }

  // Check for duplicate / overlapping period
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
  const idx  = parseInt(req.params.index, 10);
  const data = JSON.parse(fs.readFileSync(BOOKINGS_FILE, 'utf-8'));
  const rec  = data.find(b => b.propertyId === req.params.propertyId);

  if (!rec || idx < 0 || idx >= rec.blockedPeriods.length) {
    return res.status(404).json({ error: 'Period not found.' });
  }

  rec.blockedPeriods.splice(idx, 1);
  fs.writeFileSync(BOOKINGS_FILE, JSON.stringify(data, null, 2), 'utf-8');
  regenerateIcal();
  res.json({ success: true, periods: rec.blockedPeriods });
});

// ─────────────────────────────────────────────────────────────────────────────
//  GET /  → Serve the admin UI (inline HTML)
// ─────────────────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  const properties = JSON.parse(fs.readFileSync(HOMESTAYS_FILE, 'utf-8'));
  const propertyOptions = properties.map(p =>
    `<option value="${p.id}">${p.name}</option>`
  ).join('');

  res.send(/* html */ `<!DOCTYPE html>
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
    input[type="date"]:focus, input[type="text"]:focus, select:focus {
      border-color: var(--accent);
    }
    input[type="date"]::-webkit-calendar-picker-indicator {
      filter: invert(0.6);
      cursor: pointer;
    }
    select option { background: #1e2028; }

    /* ── Button ── */
    .btn {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 13px 28px;
      border-radius: 10px;
      font-family: 'Inter', sans-serif;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      border: none;
      transition: all 0.2s;
    }
    .btn-primary {
      background: var(--accent);
      color: #000;
      width: 100%;
      justify-content: center;
      margin-top: 8px;
    }
    .btn-primary:hover { background: var(--accent2); transform: translateY(-1px); }
    .btn-primary:active { transform: translateY(0); }

    /* ── Toast ── */
    #toast {
      position: fixed;
      bottom: 32px;
      left: 50%;
      transform: translateX(-50%) translateY(20px);
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 14px 24px;
      font-size: 14px;
      opacity: 0;
      transition: all 0.35s cubic-bezier(0.34, 1.56, 0.64, 1);
      z-index: 999;
      pointer-events: none;
      white-space: nowrap;
    }
    #toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }
    #toast.success { border-color: var(--success); color: var(--success); }
    #toast.error   { border-color: var(--danger);  color: var(--danger); }

    /* ── Periods List ── */
    .periods-list { display: flex; flex-direction: column; gap: 10px; }
    .period-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      background: rgba(255,255,255,0.03);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 14px 18px;
      transition: border-color 0.2s;
    }
    .period-row:hover { border-color: rgba(255,255,255,0.15); }
    .period-dates { font-size: 15px; font-weight: 500; }
    .period-duration { font-size: 13px; color: var(--muted); margin-top: 3px; }
    .period-note { font-size: 12px; color: var(--accent); margin-top: 2px; }
    .btn-delete {
      background: transparent;
      border: 1px solid rgba(224,85,85,0.3);
      color: var(--danger);
      border-radius: 8px;
      padding: 7px 14px;
      font-size: 13px;
      cursor: pointer;
      font-family: 'Inter', sans-serif;
      transition: all 0.2s;
    }
    .btn-delete:hover { background: rgba(224,85,85,0.1); border-color: var(--danger); }

    .empty-state {
      text-align: center;
      padding: 32px;
      color: var(--muted);
      font-size: 14px;
    }

    /* ── Info box ── */
    .info-box {
      background: rgba(214,175,55,0.06);
      border: 1px solid rgba(214,175,55,0.2);
      border-radius: 10px;
      padding: 14px 18px;
      font-size: 13px;
      color: #c8a830;
      line-height: 1.7;
    }
    .info-box strong { display: block; margin-bottom: 4px; font-size: 12px; letter-spacing: 1px; text-transform: uppercase; }
  </style>
</head>
<body>

<header>
  <div class="logo-text">VOLGO</div>
  <div class="logo-divider"></div>
  <div class="header-title">Booking Admin — Availability Manager</div>
</header>

<div class="container">

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
    <div class="card-title">Block New Dates</div>
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

  <!-- iCal info -->
  <div class="info-box">
    <strong>Your iCal URL (share with Airbnb, Booking.com, Vrbo)</strong>
    Every time you block or unblock dates here, the iCal file updates automatically.<br>
    Once your site is deployed, your iCal URL will be:<br><br>
    <code id="icalUrl" style="font-size:13px; color:#f0cc60;">https://YOUR_DOMAIN/<span id="icalSlug">volgo-alpine-retreat</span>.ics</code>
  </div>

</div>

<div id="toast"></div>

<script>
  // Set today as min date for both pickers
  const today = new Date().toISOString().split('T')[0];
  document.getElementById('fromDate').min = today;
  document.getElementById('toDate').min   = today;

  // When from changes, update to min
  document.getElementById('fromDate').addEventListener('change', function() {
    document.getElementById('toDate').min = this.value;
    if (document.getElementById('toDate').value <= this.value) {
      document.getElementById('toDate').value = '';
    }
  });

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

  function getPropertyId() {
    return document.getElementById('propertySelect').value;
  }

  async function loadPeriods() {
    const pid = getPropertyId();
    document.getElementById('icalSlug').textContent = pid;
    const res     = await fetch('/api/periods/' + pid);
    const periods = await res.json();
    const list    = document.getElementById('periodsList');

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
    const to   = document.getElementById('toDate').value;
    const note = document.getElementById('noteInput').value.trim();

    if (!from || !to) return showToast('Please select both check-in and check-out dates.', 'error');
    if (from >= to)   return showToast('Check-out must be after check-in.', 'error');

    const res  = await fetch('/api/periods/' + getPropertyId(), {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ from, to, note })
    });
    const data = await res.json();

    if (!res.ok) return showToast(data.error || 'Failed to block dates.', 'error');

    document.getElementById('fromDate').value = '';
    document.getElementById('toDate').value   = '';
    document.getElementById('noteInput').value = '';
    showToast('✓ Dates blocked and iCal updated!', 'success');
    loadPeriods();
  }

  async function removePeriod(index) {
    if (!confirm('Remove this blocked period?')) return;
    const res  = await fetch('/api/periods/' + getPropertyId() + '/' + index, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) return showToast(data.error, 'error');
    showToast('✓ Dates unblocked and iCal updated!', 'success');
    loadPeriods();
  }

  // Initial load
  loadPeriods();
</script>
</body>
</html>`);
});

// ─────────────────────────────────────────────────────────────────────────────
//  Start server
// ─────────────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(' VOLGO HOMESTAY — Booking Admin Panel');
  console.log(`\n  Open in browser: http://localhost:${PORT}`);
  console.log('\n  Use this to block/unblock dates after confirming a');
  console.log('  booking via WhatsApp or phone call.');
  console.log('  The iCal file updates automatically on every change.');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
});
