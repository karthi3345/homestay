/**
 * server.js
 * 
 * Unified Node.js server that:
 * 1. Serves the public website (Vite built files from /dist)
 * 2. Provides the private /admin panel, protected by password
 * 3. Handles API requests for blocking dates & generates .ics files
 */

import express from 'express';
import serverless from 'serverless-http';
import { getStore } from '@netlify/blobs';
import basicAuth from 'express-basic-auth';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import nodemailer from 'nodemailer';
import { randomUUID } from 'crypto';

// Netlify Blobs Helpers
const BLOB_FILES = {
  BOOKINGS_FILE: 'direct-bookings.json',
  PENDING_FILE: 'pending-requests.json',
  HISTORY_FILE: 'booking-history.json',
  EXTERNAL_ICAL_FILE: 'external-icals.json',
  HOMESTAYS_FILE: 'homestays.json' // static, but we can store it in blob if modified, actually homestays is read-only from repo so we can leave it as fs read. Wait, we'll put it in Blob too for consistency, or fallback to fs.
};

const LOCAL_FILES = {
  BOOKINGS_FILE: path.join(process.cwd(), 'data', 'direct-bookings.json'),
  PENDING_FILE: path.join(process.cwd(), 'data', 'pending-requests.json'),
  HISTORY_FILE: path.join(process.cwd(), 'data', 'booking-history.json'),
  EXTERNAL_ICAL_FILE: path.join(process.cwd(), 'data', 'external-icals.json'),
  HOMESTAYS_FILE: path.join(process.cwd(), 'data', 'homestays.json')
};

function getBlobStore() {
  const siteID = process.env.NETLIFY_BLOBS_SITE_ID || process.env.SITE_ID;
  const token = process.env.NETLIFY_BLOBS_TOKEN || process.env.NETLIFY_AUTH_TOKEN;
  if (siteID && token) {
    return getStore({
      name: 'data',
      siteID,
      token
    });
  }
  return getStore('data');
}

async function getBlob(fileKey) {
  try {
    const store = getBlobStore();
    let data = await store.get(BLOB_FILES[fileKey], { type: 'json' });
    if (!data && fileKey === 'HOMESTAYS_FILE') {
       data = JSON.parse(fs.readFileSync(LOCAL_FILES.HOMESTAYS_FILE, 'utf-8'));
       await store.setJSON(BLOB_FILES[fileKey], data);
    }
    return data || [];
  } catch(e) { 
    console.error("Blob Fetch Error for", fileKey, e.message); 
    try {
      if (fs.existsSync(LOCAL_FILES[fileKey])) {
        return JSON.parse(fs.readFileSync(LOCAL_FILES[fileKey], 'utf-8'));
      }
    } catch (err) {
      console.error("Local file fallback read failed:", err.message);
    }
    return []; 
  }
}
async function setBlob(fileKey, data) {
  try {
    const store = getBlobStore();
    await store.setJSON(BLOB_FILES[fileKey], data);
  } catch(e) {
    console.error("Blob Write Error for", fileKey, e.message);
    try {
      const dir = path.dirname(LOCAL_FILES[fileKey]);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(LOCAL_FILES[fileKey], JSON.stringify(data, null, 2));
    } catch (err) {
      console.error("Local file fallback write failed:", err.message);
    }
  }
}


const ROOT_DIR = process.cwd();
const BOOKINGS_FILE = path.join(ROOT_DIR, 'data', 'direct-bookings.json');
const HOMESTAYS_FILE = path.join(ROOT_DIR, 'data', 'homestays.json');
const PENDING_FILE = path.join(ROOT_DIR, 'data', 'pending-requests.json');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const DIST_DIR = path.join(ROOT_DIR, 'dist');
const PORT = process.env.PORT || 3000;

const app = express();
app.set('trust proxy', 1); // Enable for Netlify API Gateway
app.use(express.json({ limit: '10kb' })); // #8: Prevent oversized payloads

// #9: Public rate limiter applied to all routes before auth
const publicRateLimit = {};
setInterval(() => {
  const now = Date.now();
  for (const ip in publicRateLimit) {
    if (now - publicRateLimit[ip].time > 600000) delete publicRateLimit[ip];
  }
}, 60000);

function applyRateLimit(req, res, next) {
  const ip = req.ip || req.socket.remoteAddress;
  if (!publicRateLimit[ip]) publicRateLimit[ip] = { count: 0, time: Date.now() };
  if (Date.now() - publicRateLimit[ip].time > 600000) { publicRateLimit[ip].count = 0; publicRateLimit[ip].time = Date.now(); }
  if (publicRateLimit[ip].count >= 60) return res.status(429).json({ error: 'Too many requests. Please try again later.' });
  publicRateLimit[ip].count++;
  next();
}
app.use('/api/', applyRateLimit);

// #3: HTML sanitizer for user-submitted fields
function sanitizeHtml(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
}

// ─────────────────────────────────────────────────────────────────────────────
//  Public API (No Auth)
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/request-booking', async (req, res) => {
  try {
    const payload = req.body;
    if (!/^\+?[0-9]{10,15}$/.test(payload.guestPhone)) {
      return res.status(400).json({error: 'Invalid phone number format.'});
    }

    // Check Availability
    const d1 = new Date(payload.checkInMs);
    const d2 = new Date(payload.checkOutMs);
    const fromStr = d1.toISOString().split('T')[0];
    const toStr = d2.toISOString().split('T')[0];
    
    if (true) {
      const data = (await getBlob('BOOKINGS_FILE'));
      const record = data.find(b => b.propertyId === payload.homestayId);
      if (record) {
        const overlap = record.blockedPeriods.some(p => fromStr < p.to && toStr > p.from);
        if (overlap) return res.status(409).json({error: 'Sorry, these dates have just been booked. Please choose different dates.'});
      }
    }

    const pending = (await getBlob('PENDING_FILE'));
    
    payload.id = 'VH-' + randomUUID(); // #5: Cryptographically random, unguessable booking ID
    payload.timestamp = new Date().toISOString();
    
    // Set expiration: 6 hours from now OR check-in time (whichever is earlier)
    const sixHoursFromNow = Date.now() + (6 * 60 * 60 * 1000);
    payload.expiresAt = Math.min(sixHoursFromNow, payload.checkInMs);
    
    pending.push(payload);
    await setBlob('PENDING_FILE', pending);

    // Fire and forget email notification
    if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
      const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
          user: process.env.EMAIL_USER,
          pass: process.env.EMAIL_PASS
        }
      });

      const siteUrl = process.env.SITE_URL || 'http://localhost:3000'; // #13: Use SITE_URL in production
      const mailOptions = {
        from: '"Volgo Booking Alert" <' + process.env.EMAIL_USER + '>',
        to: process.env.EMAIL_USER,
        subject: "\uD83C\uDF89 New Booking Request - " + sanitizeHtml(payload.homestayName),
        html: "<h2>New Booking Request Received!</h2>" +
              "<p><strong>Property:</strong> " + sanitizeHtml(payload.homestayName) + "</p>" +
              "<p><strong>Guest Name:</strong> " + sanitizeHtml(payload.guestName) + "</p>" +
              "<p><strong>Phone / WhatsApp:</strong> " + sanitizeHtml(payload.guestPhone) + "</p>" +
              (payload.promoCode ? "<p><strong>Promo Code:</strong> " + sanitizeHtml(payload.promoCode) + "</p>" : "") +
              "<p><strong>Check-in:</strong> " + sanitizeHtml(payload.checkIn) + "</p>" +
              "<p><strong>Check-out:</strong> " + sanitizeHtml(payload.checkOut) + "</p>" +
              "<p><strong>Guests:</strong> " + Number(payload.adults) + " Adults, " + Number(payload.children) + " Children</p>" +
              "<p><strong>Note:</strong> " + sanitizeHtml(payload.note || 'None') + "</p>" +
              "<br/>" +
              '<a href="' + siteUrl + '/admin" style="background:#222; color:#fff; padding:10px 20px; text-decoration:none; border-radius:5px;">Open Admin Panel</a>'
      };

      transporter.sendMail(mailOptions)
        .then(info => console.log("Email successfully dispatched to Gmail:", info.response))
        .catch(err => console.error("Email send failed:", err));
    }

    res.json({ success: true, id: payload.id });
  } catch (err) {
    console.error("Booking request error:", err);
    res.status(500).json({ error: "Server error: " + err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  PASSWORD PROTECTION (Basic Auth)
// ─────────────────────────────────────────────────────────────────────────────
const authMiddleware = basicAuth({
  users: { [process.env.ADMIN_USER || 'admin']: process.env.ADMIN_PASS || 'volgo123' }, // #2: Use env vars
  challenge: true,
  realm: 'Volgo Admin'
});

// Protect the admin routes
app.use('/admin', authMiddleware);
app.use([
  '/api/pending-requests',
  '/api/approve-request',
  '/api/decline-request',
  '/api/external-ical'
], authMiddleware);

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
  // No-op: iCal is now generated dynamically via GET /api/calendar/:propertyId.ics
}

app.get('/api/calendar/:propertyId.ics', async (req, res) => {
  const propertyId = req.params.propertyId;
  const properties = (await getBlob('HOMESTAYS_FILE'));
  const prop = properties.find(p => p.id === propertyId);
  
  if (!prop) return res.status(404).send('Property not found');
  
  let allBlocked = [];
  if (true) {
    allBlocked = (await getBlob('BOOKINGS_FILE'));
  }
  
  const record = allBlocked.find(b => b.propertyId === propertyId);
  const periods = record ? record.blockedPeriods : [];
  const now = icalNow();

  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0',
    `PRODID:-//VolGO Homestay//Booking Calendar//EN`,
    'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    `X-WR-CALNAME:${prop.name} – Availability`,
    'X-WR-TIMEZONE:Asia/Kolkata',
  ];

  periods.forEach((p, i) => {
    lines.push('BEGIN:VEVENT',
      `UID:booking-${i + 1}-${prop.id}@volgo.in`,
      `DTSTAMP:${now}`,
      `DTSTART;VALUE=DATE:${icalDate(p.from)}`,
      `DTEND;VALUE=DATE:${icalDate(p.to)}`,
      'SUMMARY:Booked',
      'STATUS:CONFIRMED', 'TRANSP:OPAQUE', 'END:VEVENT');
  });
  lines.push('END:VCALENDAR');

  const icsContent = lines.map(foldLine).join('\r\n') + '\r\n';
  
  res.setHeader('Content-Type', 'text/calendar');
  res.setHeader('Content-Disposition', `attachment; filename="${propertyId}.ics"`);
  res.send(icsContent);
});

// ─────────────────────────────────────────────────────────────────────────────
//  API: get blocked periods
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/periods/:propertyId', async (req, res) => {
  const data = (await getBlob('BOOKINGS_FILE'));
  const record = data.find(b => b.propertyId === req.params.propertyId);
  
  if (!record) return res.json([]);

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 3); // 3 days ago
  const cutoffMs = cutoff.getTime();

  // Permanently remove bookings that ended more than 3 days ago
  const originalLength = record.blockedPeriods.length;
  record.blockedPeriods = record.blockedPeriods.filter(p => {
    return new Date(p.to).getTime() >= cutoffMs;
  });

  // If any were removed, save the file
  if (record.blockedPeriods.length !== originalLength) {
    await setBlob('BOOKINGS_FILE', data);
    regenerateIcal();
  }

  const combinedPeriods = [...record.blockedPeriods];
  
  // Merge active temporary holds
  if (true) {
    const pending = (await getBlob('PENDING_FILE'));
    const activeHolds = pending.filter(p => p.homestayId === req.params.propertyId && (!p.expiresAt || p.expiresAt > Date.now()));
    
    activeHolds.forEach(hold => {
      // Use string dates and force noon UTC to avoid timezone shift on the server
      const fromDateStr = new Date(hold.checkIn + " 12:00:00 UTC").toISOString().split('T')[0];
      const toDateStr = new Date(hold.checkOut + " 12:00:00 UTC").toISOString().split('T')[0];
      
      combinedPeriods.push({
        from: fromDateStr,
        to: toDateStr,
        note: "Pending (Auto-Hold)"
      });
    });
  }

  res.json(combinedPeriods);
});

// ─────────────────────────────────────────────────────────────────────────────
//  API: add a blocked period
// ─────────────────────────────────────────────────────────────────────────────
// Update Pricing Endpoint
app.post('/api/homestay/:id/pricing', authMiddleware, async (req, res) => {
  const { weekday, weekend, promos } = req.body;
  if (typeof weekday !== 'number' || typeof weekend !== 'number') {
    return res.status(400).json({ error: 'Weekday and weekend prices must be numbers.' });
  }

  if (true) {
    const data = (await getBlob('HOMESTAYS_FILE'));
    const record = data.find(b => b.id === req.params.id);
    if (record) {
      record.pricing = { weekday, weekend };
      record.promos = Array.isArray(promos) ? promos : [];
      // Clean up old single promo if it exists
      if (record.promo) delete record.promo;
      await setBlob('HOMESTAYS_FILE', data);
      return res.json({ success: true });
    }
  }
  return res.status(404).json({ error: 'Property not found.' });
});

app.post('/api/periods/:propertyId', authMiddleware, async (req, res) => {
  const { from, to, note } = req.body;
  if (!from || !to || from >= to) {
    return res.status(400).json({ error: 'Invalid dates. "from" must be before "to".' });
  }

  // Warn if overlaps with pending
  if (true) {
    const pending = (await getBlob('PENDING_FILE'));
    const d1 = new Date(from).getTime();
    const d2 = new Date(to).getTime();
    const overlapPending = pending.some(p => p.homestayId === req.params.propertyId && d1 < p.checkOutMs && d2 > p.checkInMs);
    if (overlapPending && !req.query.force) {
      return res.status(409).json({ error: 'OVERLAP_PENDING', msg: 'These dates overlap with a pending booking request! Confirm to overwrite.' });
    }
  }

  const data = (await getBlob('BOOKINGS_FILE'));
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

  await setBlob('BOOKINGS_FILE', data);
  regenerateIcal();
  res.json({ success: true, periods: record.blockedPeriods });
});

// ─────────────────────────────────────────────────────────────────────────────
//  API: remove a blocked period by index
// ─────────────────────────────────────────────────────────────────────────────
app.delete('/api/periods/:propertyId/:index', authMiddleware, async (req, res) => {
  const idx = parseInt(req.params.index, 10);
  const data = (await getBlob('BOOKINGS_FILE'));
  const rec = data.find(b => b.propertyId === req.params.propertyId);

  if (!rec || idx < 0 || idx >= rec.blockedPeriods.length) {
    return res.status(404).json({ error: 'Period not found.' });
  }

  rec.blockedPeriods.splice(idx, 1);
  await setBlob('BOOKINGS_FILE', data);
  regenerateIcal();
  res.json({ success: true, periods: rec.blockedPeriods });
});

// ─────────────────────────────────────────────────────────────────────────────
//  API: get, approve, decline pending requests
// ─────────────────────────────────────────────────────────────────────────────
async function saveToHistory(reqObj, status) {
  
  const history = (await getBlob('HISTORY_FILE'));
  reqObj.status = status;
  reqObj.updatedAt = new Date().toISOString();
  history.push(reqObj);
  await setBlob('HISTORY_FILE', history);
}

app.get('/api/pending-requests', async (req, res) => {
  const _tPENDING_FILE = await getBlob('PENDING_FILE'); if (!_tPENDING_FILE || _tPENDING_FILE.length===0) return res.json([]);
  let pending = (await getBlob('PENDING_FILE'));
  
  // Auto-expire >24h old requests and save to history
  const now = Date.now();
  const ONE_DAY = 24 * 60 * 60 * 1000;
  const validPending = [];
  for (const r of pending) {
    if ((now - new Date(r.timestamp).getTime()) >= ONE_DAY) await saveToHistory(r, 'Expired');
    else validPending.push(r);
  }
  if (validPending.length !== pending.length) await setBlob('PENDING_FILE', validPending);
  pending = validPending;
  
  // Check for overlaps among pending requests
  const requestsWithOverlap = pending.map(r => {
    const hasOverlap = pending.some(other => 
      other.id !== r.id && 
      other.homestayId === r.homestayId &&
      r.checkInMs < other.checkOutMs && r.checkOutMs > other.checkInMs
    );
    return { ...r, hasOverlap };
  });
  
  res.json(requestsWithOverlap);
});

app.post('/api/approve-request/:id', async (req, res) => {
  const id = req.params.id;
  const _tPENDING_FILE = await getBlob('PENDING_FILE'); if (!_tPENDING_FILE || _tPENDING_FILE.length===0) return res.status(404).json({error: 'Not found'});
  let pending = (await getBlob('PENDING_FILE'));
  const reqObj = pending.find(r => r.id === id);
  
  if (!reqObj) return res.status(404).json({error: 'Request not found'});
  
  // Add to direct-bookings.json
  const data = (await getBlob('BOOKINGS_FILE'));
  let record = data.find(b => b.propertyId === reqObj.homestayId);
  if (!record) {
    record = { propertyId: reqObj.homestayId, blockedPeriods: [] };
    data.push(record);
  }
  
  const d1 = new Date(reqObj.checkInMs);
  const d2 = new Date(reqObj.checkOutMs);
  const fromStr = d1.toISOString().split('T')[0];
  const toStr = d2.toISOString().split('T')[0];
  
  // FINAL AVAILABILITY CHECK BEFORE APPROVING
  const overlap = record.blockedPeriods.some(p => fromStr < p.to && toStr > p.from);
  if (overlap) {
    return res.status(409).json({error: 'These dates were booked on another platform (or manually). This request can no longer be approved.'});
  }
  
  record.blockedPeriods.push({
    from: fromStr,
    to: toStr,
    note: '[Approved] ' + reqObj.guestName
  });
  
  await setBlob('BOOKINGS_FILE', data);
  
  // Remove from pending and save to history
  pending = pending.filter(r => r.id !== id);
  await setBlob('PENDING_FILE', pending);
  await saveToHistory(reqObj, 'Approved');
  
  res.json({ success: true });
});

app.delete('/api/decline-request/:id', async (req, res) => {
  const id = req.params.id;
  const _tPENDING_FILE = await getBlob('PENDING_FILE'); if (!_tPENDING_FILE || _tPENDING_FILE.length===0) return res.json({success: true});
  let pending = (await getBlob('PENDING_FILE'));
  const reqObj = pending.find(r => r.id === id);
  if (reqObj) await saveToHistory(reqObj, 'Declined');
  
  pending = pending.filter(r => r.id !== id);
  await setBlob('PENDING_FILE', pending);
  res.json({ success: true });
});

// ─────────────────────────────────────────────────────────────────────────────
//  API: External Calendar Sync
// ─────────────────────────────────────────────────────────────────────────────
async function syncIcalTextToProperty(text, propertyId, feedId, feedName) {
  const events = text.match(/BEGIN:VEVENT[\s\S]*?END:VEVENT/g) || [];
  
  const data = (await getBlob('BOOKINGS_FILE'));
  let record = data.find(b => b.propertyId === propertyId);
  if (!record) { record = { propertyId, blockedPeriods: [] }; data.push(record); }
  
  // Remove previously imported events from THIS SPECIFIC FEED
  record.blockedPeriods = record.blockedPeriods.filter(p => p.source !== feedId);
  
  let warning = null;

  events.forEach(ev => {
    const startMatch = ev.match(/DTSTART(?:;[^:]+)?:(\d{8})/);
    const endMatch = ev.match(/DTEND(?:;[^:]+)?:(\d{8})/);
    if (startMatch && endMatch) {
      const s = startMatch[1];
      const e = endMatch[1];
      const from = `${s.substring(0,4)}-${s.substring(4,6)}-${s.substring(6,8)}`;
      const to = `${e.substring(0,4)}-${e.substring(4,6)}-${e.substring(6,8)}`;
      
      const days = (new Date(to) - new Date(from)) / 86400000;
      if (days > 90) {
        warning = `Warning: A massive block of ${days} days was detected from ${feedName} and was ignored to prevent locking your calendar.`;
      } else {
        // Don't import our own generated iCals back (infinite loop safety)
        if (!ev.includes('@volgo.in') && !ev.includes('@volgohomestay')) {
          record.blockedPeriods.push({ from, to, note: `[Auto] ${feedName}`, external: true, source: feedId });
        }
      }
    }
  });
  
  record.blockedPeriods.sort((a, b) => a.from.localeCompare(b.from));
  await setBlob('BOOKINGS_FILE', data);
  
  return warning;
}

app.get('/api/external-ical/:propertyId', async (req, res) => {
  const _tEXTERNAL_ICAL_FILE = await getBlob('EXTERNAL_ICAL_FILE'); if (!_tEXTERNAL_ICAL_FILE || _tEXTERNAL_ICAL_FILE.length===0) return res.json({ feeds: [] });
  const data = (await getBlob('EXTERNAL_ICAL_FILE'));
  const rec = data.find(d => d.propertyId === req.params.propertyId);
  res.json(rec || { feeds: [] });
});

app.post('/api/external-ical/:propertyId/add', async (req, res) => {
  const { name, url } = req.body;
  if (!name || !url) return res.status(400).json({error: 'Name and URL required'});
  
  // #6: Block SSRF - only allow https:// URLs for external calendars
  if (!url.startsWith('https://')) {
    return res.status(400).json({error: 'Only HTTPS URLs are allowed for external calendars.'});
  }
  
  
  const data = (await getBlob('EXTERNAL_ICAL_FILE'));
  
  let rec = data.find(d => d.propertyId === req.params.propertyId);
  if (!rec) { rec = { propertyId: req.params.propertyId, feeds: [] }; data.push(rec); }
  if (!rec.feeds) rec.feeds = [];
  
  const feedId = 'feed-' + Date.now();
  const newFeed = { id: feedId, name, url, enabled: true, lastSync: null, status: 'Pending' };
  rec.feeds.push(newFeed);
  await setBlob('EXTERNAL_ICAL_FILE', data);
  
  // Try immediate sync
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error('Bad status');
    await syncIcalTextToProperty(await response.text(), req.params.propertyId, feedId, name);
    newFeed.status = 'Success';
    newFeed.lastSync = new Date().toISOString();
  } catch(e) {
    newFeed.status = 'Failed';
    newFeed.lastSync = new Date().toISOString();
  }
  await setBlob('EXTERNAL_ICAL_FILE', data);
  res.json({success: true});
});

app.post('/api/external-ical/:propertyId/toggle/:feedId', async (req, res) => {
  const _tEXTERNAL_ICAL_FILE = await getBlob('EXTERNAL_ICAL_FILE'); if (!_tEXTERNAL_ICAL_FILE || _tEXTERNAL_ICAL_FILE.length===0) return res.json({success: false});
  const data = (await getBlob('EXTERNAL_ICAL_FILE'));
  const rec = data.find(d => d.propertyId === req.params.propertyId);
  if (rec && rec.feeds) {
    const feed = rec.feeds.find(f => f.id === req.params.feedId);
    if (feed) {
      feed.enabled = !feed.enabled;
      if (!feed.enabled) {
        // Remove existing external blocks for this feed when disabled
        const bData = (await getBlob('BOOKINGS_FILE'));
        let bRecord = bData.find(b => b.propertyId === req.params.propertyId);
        if (bRecord) {
          bRecord.blockedPeriods = bRecord.blockedPeriods.filter(p => p.source !== feed.id);
          await setBlob('BOOKINGS_FILE', bData);
        }
      }
      await setBlob('EXTERNAL_ICAL_FILE', data);
    }
  }
  res.json({success: true});
});

app.delete('/api/external-ical/:propertyId/:feedId', async (req, res) => {
  const _tEXTERNAL_ICAL_FILE = await getBlob('EXTERNAL_ICAL_FILE'); if (!_tEXTERNAL_ICAL_FILE || _tEXTERNAL_ICAL_FILE.length===0) return res.json({success: false});
  const data = (await getBlob('EXTERNAL_ICAL_FILE'));
  const rec = data.find(d => d.propertyId === req.params.propertyId);
  if (rec && rec.feeds) {
    rec.feeds = rec.feeds.filter(f => f.id !== req.params.feedId);
    await setBlob('EXTERNAL_ICAL_FILE', data);
    
    // Clean up blocks
    const bData = (await getBlob('BOOKINGS_FILE'));
    let bRecord = bData.find(b => b.propertyId === req.params.propertyId);
    if (bRecord) {
      bRecord.blockedPeriods = bRecord.blockedPeriods.filter(p => p.source !== req.params.feedId);
      await setBlob('BOOKINGS_FILE', bData);
    }
  }
  res.json({success: true});
});

app.post('/api/external-ical/:propertyId/sync/:feedId', async (req, res) => {
  const _tEXTERNAL_ICAL_FILE = await getBlob('EXTERNAL_ICAL_FILE'); if (!_tEXTERNAL_ICAL_FILE || _tEXTERNAL_ICAL_FILE.length===0) return res.status(404).json({error:'No feeds'});
  const data = (await getBlob('EXTERNAL_ICAL_FILE'));
  const rec = data.find(d => d.propertyId === req.params.propertyId);
  if (!rec || !rec.feeds) return res.status(404).json({error:'Not found'});
  const feed = rec.feeds.find(f => f.id === req.params.feedId);
  if (!feed) return res.status(404).json({error:'Feed not found'});
  
  try {
    const response = await fetch(feed.url);
    if (!response.ok) throw new Error('Bad status');
    await syncIcalTextToProperty(await response.text(), req.params.propertyId, feed.id, feed.name);
    feed.status = 'Success';
    feed.lastSync = new Date().toISOString();
  } catch(e) {
    feed.status = 'Failed';
    feed.lastSync = new Date().toISOString();
  }
  await setBlob('EXTERNAL_ICAL_FILE', data);
  res.json({success: true});
});

// Background sync every 15 mins
setInterval(async () => {
  const _tEXTERNAL_ICAL_FILE = await getBlob('EXTERNAL_ICAL_FILE'); if (!_tEXTERNAL_ICAL_FILE || _tEXTERNAL_ICAL_FILE.length===0) return;
  const data = (await getBlob('EXTERNAL_ICAL_FILE'));
  let changed = false;
  for (const rec of data) {
    if (rec.feeds) {
      for (const feed of rec.feeds) {
        if (feed.enabled) {
          try {
            const response = await fetch(feed.url);
            if (!response.ok) throw new Error('Bad status');
            const warning = await syncIcalTextToProperty(await response.text(), rec.propertyId, feed.id, feed.name);
            feed.status = 'Success';
            feed.warning = warning || null;
            feed.lastSync = new Date().toISOString();
          } catch(e) {
            feed.status = 'Failed';
            feed.lastSync = new Date().toISOString();
          }
          changed = true;
        }
      }
    }
  }
  if (changed) await setBlob('EXTERNAL_ICAL_FILE', data);
}, 15 * 60 * 1000);

// ─────────────────────────────────────────────────────────────────────────────
//  GET /admin → Serve the protected admin UI
// ─────────────────────────────────────────────────────────────────────────────
app.get('/admin', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Expires', '-1');
  res.setHeader('Pragma', 'no-cache');
  const properties = (await getBlob('HOMESTAYS_FILE'));
  const propertyOptions = properties.map(p =>
    `<option value="${p.id}">${p.name}</option>`
  ).join('');

  let calendarStyles = '';
  let calendarJs = '';
  try {
    const stylesCss = fs.readFileSync(path.join(ROOT_DIR, 'styles.css'), 'utf-8');
    calendarJs = fs.readFileSync(path.join(ROOT_DIR, 'calendar.js'), 'utf-8');
    const startIdx = stylesCss.indexOf('/* Tab: Calendar styling */');
    const endIdx = stylesCss.indexOf('/* Booking Action Area */');
    if (startIdx !== -1 && endIdx !== -1) {
      calendarStyles = stylesCss.substring(startIdx, endIdx);
    }
  } catch(e) {}

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Volgo Homestay — Booking Admin</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <script>window.homestaysData = ${JSON.stringify(properties)};</script>
  <style>
    ${calendarStyles}
    #adminCalendar .selection-summary, #adminCalendar .guest-selector-container { display: none !important; }
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
      --radius:   12px;
      --transition: all 0.25s ease;
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
      background: rgba(22, 24, 29, 0.95);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border-bottom: 1px solid var(--border);
      padding: 16px 40px;
      display: flex;
      align-items: center;
      gap: 20px;
      position: sticky;
      top: 0;
      z-index: 100;
    }
    .admin-logo { height: 40px; width: auto; object-fit: contain; filter: invert(1) opacity(0.85); }
    .logo-divider { width: 1px; height: 24px; background: var(--border); }
    .header-title { font-size: 14px; color: var(--muted); font-weight: 500; letter-spacing: 0.5px; }

    /* ── Layout ── */
    .container { max-width: 1400px; width: 95%; margin: 0 auto; padding: 40px 24px 0; }
    
    .dashboard-grid {
      display: grid;
      grid-template-columns: 1.5fr 1fr;
      gap: 24px;
      align-items: start;
    }
    @media (max-width: 900px) {
      .dashboard-grid { grid-template-columns: 1fr; }
    }

    /* ── Card ── */
    .card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 32px;
      margin-bottom: 0; /* Let grid handle gap */
      box-shadow: 0 4px 24px rgba(0,0,0,0.2);
    }
    .card-title {
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 2px;
      color: var(--accent);
      font-weight: 600;
      margin-bottom: 24px;
      opacity: 0.9;
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
    input[type="date"], input[type="text"], input[type="number"], select {
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
    input[type="date"]:focus, input[type="text"]:focus, input[type="number"]:focus, select:focus { border-color: var(--accent); }
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
    
    /* ── Mobile Responsive ── */
    @media (max-width: 768px) {
      header { padding: 16px 20px; flex-direction: column; align-items: flex-start; gap: 10px; }
      .logo-divider { display: none; }
      .form-row { grid-template-columns: 1fr; }
      .period-row { flex-direction: column; align-items: flex-start; gap: 12px; }
      .btn-delete { width: 100%; text-align: center; justify-content: center; }
      .request-header { flex-direction: column; gap: 6px; }
      .request-actions { flex-direction: column; }
      .request-actions > * { width: 100%; text-align: center; justify-content: center; }
      .split-card { flex-direction: column; gap: 24px !important; }
      .split-card > div { width: 100% !important; }
    }
  </style>
</head>
<body>

<header>
  <div style="display: flex; align-items: center;">
    <img src="/assets/logo/volg-logo-main.webp" alt="VOLGO" class="admin-logo">
    <div class="logo-divider"></div>
    <div class="header-title">Booking Admin — Availability Manager</div>
  </div>
</header>

<div class="container">
  
  <!-- System Notifications -->
  <div class="card" style="margin-bottom: 24px; border: 2px solid var(--danger); display: none;" id="systemNotificationsCard">
    <div class="card-title" style="color: var(--danger); font-size: 16px; font-weight: bold; margin-bottom: 16px;">System Notifications</div>
    <div id="systemNotificationsList" style="display: flex; flex-direction: column; gap: 12px;">
      <!-- Alerts injected here -->
    </div>
  </div>

  <!-- MASONRY GRID START -->
  <div class="dashboard-grid">

    <!-- PENDING REQUESTS -->
    <div class="card" style="border-top: 2px solid var(--accent); display: flex; flex-direction: column; height: 100%;">
      <div class="card-title">Pending Booking Requests</div>
      <div id="pendingList" style="flex: 1; overflow-y: auto; max-height: 400px;">
        <div class="empty-state">Loading requests...</div>
      </div>
    </div>

    <!-- Property selector (Global Context) -->
    <div class="card" style="border-left: 4px solid var(--accent);">
      <div class="card-title">Property Management Context</div>
      <div class="form-row full">
        <div>
          <label>Select Property to Manage</label>
          <select id="propertySelect" onchange="loadPeriods(); loadExternalIcal(); loadPricing();">
            ${propertyOptions}
          </select>
        </div>
      </div>
    </div>

  <!-- Pricing Settings -->
  <div class="card" id="pricingSettingsCard">
    <div class="card-title">Pricing Settings</div>
    <div class="form-row">
      <div>
        <label>Weekday Price (per night)</label>
        <input type="number" id="weekdayPrice" placeholder="e.g. 5000">
      </div>
      <div>
        <label>Weekend Price (Fri & Sat night)</label>
        <input type="number" id="weekendPrice" placeholder="e.g. 6500">
      </div>
    </div>
    <div style="margin-top: 24px; border-top: 1px solid var(--border); padding-top: 16px;">
      <div class="card-title" style="margin-bottom: 12px;">Active Promo Codes</div>
      <div class="form-row" style="align-items: flex-end; margin-bottom: 16px;">
        <div>
          <label>New Promo Code</label>
          <input type="text" id="newPromoCode" placeholder="e.g. SUMMER20">
        </div>
        <div>
          <label>Discount (%)</label>
          <input type="number" id="newPromoDiscount" placeholder="e.g. 20">
        </div>
        <div>
          <button class="btn btn-primary" onclick="addPromo()" style="width: 100%; height: 42px;">⊕ Add</button>
        </div>
      </div>
      <div id="promoListContainer" class="periods-list">
        <!-- Rendered dynamically -->
      </div>
    </div>
    
    <button class="btn btn-primary" onclick="updatePricing()" style="margin-top: 24px; width: 100%;">
      💾 &nbsp; Save All Pricing & Promos
    </button>
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

  <!-- External Calendar Sync -->
  <div class="card">
    <details>
      <summary class="card-title" style="cursor: pointer; margin-bottom: 0;">
        External Calendar Sync <span style="font-size:12px; font-weight:normal; color:#888; margin-left: 8px;">(Click to expand)</span>
      </summary>
      <div style="margin-top: 20px;">
        <div class="form-row">
          <div style="flex:1">
            <label>Platform Name</label>
            <input type="text" id="feedName" placeholder="e.g. Airbnb">
          </div>
          <div style="flex:2">
            <label>iCal URL</label>
            <input type="text" id="feedUrl" placeholder="https://www.airbnb.com/calendar/ical/...">
          </div>
        </div>
        <button class="btn btn-primary" onclick="addExternalIcal()">
          ⊕ &nbsp; Add Calendar
        </button>

        <div style="margin-top:24px;">
          <label>Configured Calendars (Auto-sync every 15 mins)</label>
          <div id="feedsList" class="periods-list">
            <div class="empty-state">Loading...</div>
          </div>
        </div>
      </div>
    </details>
  </div>

  <!-- Current Blocking -->
  <div class="card split-card" style="display:flex; gap: 40px; align-items:flex-start;">
    <div style="flex: 1;">
      <h2 class="card-title">Currently Blocked Periods</h2>
      <div id="periodsList">
        <div class="empty-state">Loading...</div>
      </div>
    </div>
    <div style="width: 320px;">
      <h2 class="card-title">Visual Calendar</h2>
      <div id="adminCalendar"></div>
    </div>
  </div>
  </div>
  <!-- MASONRY GRID END -->

</div>

<div id="toast"></div>

<script>
  ${calendarJs}
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

  let pendingDataCache = [];
  
  async function loadPendingRequests() {
    const res = await fetch('/api/pending-requests');
    const requests = await res.json();
    pendingDataCache = requests;
    const list = document.getElementById('pendingList');
    
    if (!requests.length) {
      list.innerHTML = '<div class="empty-state">No pending requests right now.</div>';
      return;
    }
    
    list.innerHTML = requests.map(r => {
      const wNumber = r.guestPhone.replace(/[^+\\d]/g, '');
      const d1 = new Date(r.checkInMs).toLocaleDateString();
      const d2 = new Date(r.checkOutMs).toLocaleDateString();
      
      const overlapBadge = r.hasOverlap ? \`<div style="color:var(--danger); font-size:12px; font-weight:600; margin-bottom:8px;">⚠️ Overlaps with another pending request!</div>\` : '';
      
      return \`
        <div class="request-card">
          <div class="request-header">
            <div>
              <span class="request-guest">\${r.guestName}</span>
              <span style="font-size:11px; color:var(--muted); margin-left:8px;">\${r.id || ''}</span>
            </div>
            <span class="request-prop">\${r.homestayName}</span>
          </div>
          \${overlapBadge}
          <div class="request-dates">\${d1} → \${d2}</div>
          <div class="request-details">\${r.adults} Adults, \${r.children} Children | Phone: \${r.guestPhone}</div>
          \${r.note ? \`<div class="request-note">"\${r.note}"</div>\` : ''}
          <div class="request-actions">
            <button class="btn-approve" id="approve-\${r.id}" onclick="approveRequest('\${r.id}', this)">Approve</button>
            <button class="btn-decline" id="decline-\${r.id}" onclick="declineRequest('\${r.id}', this)">Decline</button>
            <a class="btn-whatsapp" href="https://wa.me/\${wNumber}?text=Hi \${r.guestName}, regarding your booking at \${r.homestayName}..." target="_blank">WhatsApp</a>
            <a href="tel:\${wNumber}" style="padding: 10px; border-radius: 8px; border: 1px solid var(--border); color: var(--text); text-decoration: none; font-size: 13px;">Call</a>
          </div>
        </div>
      \`;
    }).join('');
  }
  
  async function approveRequest(id, btn) {
    const reqObj = pendingDataCache.find(r => r.id === id);
    if (!reqObj) return;
    const d1 = new Date(reqObj.checkInMs).toLocaleDateString();
    const d2 = new Date(reqObj.checkOutMs).toLocaleDateString();
    const msg = 'Confirm Booking?\\n\\nGuest: ' + reqObj.guestName + '\\nDates: ' + d1 + ' - ' + d2 + '\\n\\nThis action will block these dates.';
    if (!confirm(msg)) return;
    
    const orig = btn.textContent;
    btn.textContent = '...'; btn.disabled = true;
    const res = await fetch('/api/approve-request/' + id, { method: 'POST' });
    if (res.ok) { showToast('Approved!'); loadPendingRequests(); loadPeriods(); }
    else { 
      const err = await res.json();
      btn.textContent = orig; btn.disabled = false; 
      alert(err.error || 'Error'); 
    }
  }
  
  async function declineRequest(id, btn) {
    if (!confirm('Decline?')) return;
    const orig = btn.textContent;
    btn.textContent = '...'; btn.disabled = true;
    const res = await fetch('/api/decline-request/' + id, { method: 'DELETE' });
    if (res.ok) { showToast('Declined'); loadPendingRequests(); }
    else { btn.textContent = orig; btn.disabled = false; }
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

    // Group identical periods for display
    const displayGroups = [];
    periods.forEach((p, index) => {
      // Only merge if they are external and have exactly identical dates
      const existing = displayGroups.find(g => g.from === p.from && g.to === p.to && g.external === p.external);
      if (existing && p.external) { 
        if (p.note && !existing.note.includes(p.note)) {
          // Clean up the "[Auto]" prefix if it's repeated to keep it readable
          const cleanNote = p.note.replace('[Auto] ', '');
          existing.note += ' + ' + cleanNote;
        }
      } else {
        displayGroups.push({ ...p, originalIndex: index });
      }
    });

    list.innerHTML = displayGroups.map(p => {
      const isFinished = new Date(p.to).getTime() < Date.now();
      const finishedStyle = isFinished ? 'opacity: 0.4; filter: grayscale(1);' : '';
      const finishedBadge = isFinished ? '<span style="font-size:11px; padding: 2px 6px; background: rgba(255,255,255,0.1); border-radius:4px; margin-left: 8px;">Completed</span>' : '';
      
      return \`
        <div class="period-row" style="\${finishedStyle}">
          <div>
            <div class="period-dates">\${fmtDate(p.from)} &nbsp;→&nbsp; \${fmtDate(p.to)} \${finishedBadge}</div>
            <div class="period-duration">\${nights(p.from, p.to)}</div>
            \${p.note ? \`<div class="period-note">\${p.note}</div>\` : ''}
          </div>
          \${p.external ? '<span style="font-size:12px; color:var(--muted); font-style:italic;">External</span>' : \`<button class="btn-delete" onclick="removePeriod(\${p.originalIndex})">Remove</button>\`}
        </div>
      \`;
    }).join('');

    // Update Visual Calendar
    const blockedDates = [];
    periods.forEach(p => {
      const d = new Date(p.from);
      const end = new Date(p.to);
      while (d < end) {
        blockedDates.push(d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0'));
        d.setDate(d.getDate() + 1);
      }
    });
    if (window.adminCal) {
      window.adminCal.setBookedDates(blockedDates);
    } else if (window.HomestayCalendar) {
      window.adminCal = new HomestayCalendar('adminCalendar', { bookedDates: blockedDates });
    }
  }

  async function addPeriod(force = false) {
    const from = document.getElementById('fromDate').value;
    const to = document.getElementById('toDate').value;
    const note = document.getElementById('noteInput').value;
    if (!from || !to) return showToast('Please select dates', 'error');
    
    let url = '/api/periods/' + getPropertyId();
    if (force) url += '?force=true';
    
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to, note })
    });
    
    if (res.status === 409) {
      const err = await res.json();
      if (err.error === 'OVERLAP_PENDING') {
        if (confirm(err.msg)) addPeriod(true);
        return;
      }
      return showToast(err.error || 'Conflict', 'error');
    }
    
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

  async function loadExternalIcal() {
    const pid = getPropertyId();
    const res = await fetch('/api/external-ical/' + pid);
    const list = document.getElementById('feedsList');
    if (!res.ok) { list.innerHTML = '<div class="empty-state">Failed to load</div>'; return; }
    const data = await res.json();
    const feeds = data.feeds || [];
    
    let warningsHTML = '';

    if (!feeds.length) {
      list.innerHTML = '<div class="empty-state">No external calendars configured.</div>';
    }
    
    list.innerHTML = feeds.map(f => {
      if (f.warning) {
        warningsHTML += '<div style="background: rgba(224, 85, 85, 0.1); padding: 12px 16px; border-radius: 8px; border: 1px solid var(--danger);">' +
                        '<strong style="color: var(--danger); font-size: 14px;">⚠️ ' + f.name + ' Sync Warning:</strong><br>' +
                        '<span style="color: var(--text); font-size: 13px;">' + f.warning + '</span>' +
                        '</div>';
      }

      const d = f.lastSync ? new Date(f.lastSync).toLocaleString() : 'Never';
      const statusBadge = f.status === 'Success' 
        ? '<span style="color:var(--success)">✓ Success</span>' 
        : (f.status === 'Failed' ? '<span style="color:var(--danger)">❌ Failed</span>' : '<span>⏳ Pending</span>');
        
      return '<div class="period-row" style="opacity: ' + (f.enabled ? '1' : '0.5') + '">' +
               '<div>' +
                 '<div class="period-dates">' + f.name + '</div>' +
                 '<div class="period-duration" style="font-family:monospace; margin-top:5px; font-size:11px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:250px;">' + f.url + '</div>' +
                 '<div class="period-note">Last Sync: ' + d + ' &nbsp;|&nbsp; ' + statusBadge + '</div>' +
                 (f.warning ? '<div class="period-note" style="color:var(--danger); font-weight:bold; margin-top:5px;">' + f.warning + '</div>' : '') +
               '</div>' +
               '<div style="display:flex; gap:8px;">' +
                 '<button class="btn-delete" style="color:var(--text); border-color:var(--border);" onclick="syncFeed(\\'' + f.id + '\\')">Sync</button>' +
                 '<button class="btn-delete" style="color:var(--text); border-color:var(--border);" onclick="toggleFeed(\\'' + f.id + '\\')">' + (f.enabled ? 'Disable' : 'Enable') + '</button>' +
                 '<button class="btn-delete" onclick="removeFeed(\\'' + f.id + '\\')">Remove</button>' +
                '</div>' +
              '</div>';
    }).join('');

    const systemNotificationsCard = document.getElementById('systemNotificationsCard');
    const systemNotificationsList = document.getElementById('systemNotificationsList');
    if (warningsHTML !== '') {
      systemNotificationsList.innerHTML = warningsHTML;
      systemNotificationsCard.style.display = 'block';
    } else {
      systemNotificationsCard.style.display = 'none';
    }
  }

  async function addExternalIcal() {
    const pid = getPropertyId();
    const name = document.getElementById('feedName').value;
    const url = document.getElementById('feedUrl').value;
    if (!name || !url) return showToast('Please enter a name and URL', 'error');
    
    const btn = event.currentTarget;
    const orig = btn.innerHTML;
    btn.innerHTML = 'Adding...'; btn.disabled = true;
    
    const res = await fetch('/api/external-ical/' + pid + '/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, url })
    });
    
    btn.innerHTML = orig; btn.disabled = false;
    if (res.ok) {
      showToast('Calendar Added & Synced!');
      document.getElementById('feedName').value = '';
      document.getElementById('feedUrl').value = '';
      loadExternalIcal();
      loadPeriods();
    } else {
      const err = await res.json();
      showToast(err.error || 'Failed to add', 'error');
    }
  }

  async function toggleFeed(feedId) {
    await fetch('/api/external-ical/' + getPropertyId() + '/toggle/' + feedId, { method: 'POST' });
    loadExternalIcal();
    loadPeriods();
  }

  async function removeFeed(feedId) {
    if (!confirm('Remove this calendar feed?')) return;
    await fetch('/api/external-ical/' + getPropertyId() + '/' + feedId, { method: 'DELETE' });
    loadExternalIcal();
    loadPeriods();
  }

  async function syncFeed(feedId) {
    showToast('Syncing feed...');
    const res = await fetch('/api/external-ical/' + getPropertyId() + '/sync/' + feedId, { method: 'POST' });
    if (res.ok) {
      showToast('Sync complete!');
      loadExternalIcal();
      loadPeriods();
    } else {
      showToast('Sync failed', 'error');
    }
  }

  let currentPromos = [];

  function loadPricing() {
    if (window.homestaysData) {
      const pid = getPropertyId();
      const prop = window.homestaysData.find(p => p.id === pid);
      if (prop && prop.pricing) {
        document.getElementById('weekdayPrice').value = prop.pricing.weekday;
        document.getElementById('weekendPrice').value = prop.pricing.weekend;
      }
      currentPromos = [];
      if (prop && prop.promos) {
        currentPromos = JSON.parse(JSON.stringify(prop.promos)); // deep copy
      } else if (prop && prop.promo && prop.promo.code) { // legacy fallback
        currentPromos = [prop.promo];
      }
      renderPromos();
    }
  }

  function renderPromos() {
    const container = document.getElementById('promoListContainer');
    if (currentPromos.length === 0) {
      container.innerHTML = '<div class="empty-state" style="padding: 16px;">No promo codes active.</div>';
      return;
    }
    container.innerHTML = currentPromos.map((p, index) => 
      '<div class="period-row">' +
        '<div>' +
          '<span style="font-weight: 600; color: var(--accent); font-size: 15px;">' + p.code + '</span>' +
          '<span style="color: var(--success); font-size: 13px; margin-left: 8px;">' + p.discount + '% OFF</span>' +
        '</div>' +
        '<button class="btn-delete" onclick="removePromo(' + index + ')">Remove</button>' +
      '</div>'
    ).join('');
  }

  function addPromo() {
    const codeInput = document.getElementById('newPromoCode');
    const discountInput = document.getElementById('newPromoDiscount');
    const code = codeInput.value.trim();
    const discount = parseFloat(discountInput.value);
    
    if (!code || isNaN(discount) || discount <= 0 || discount >= 100) {
      return showToast('Please enter a valid code and discount between 1-99%', 'error');
    }
    if (currentPromos.find(p => p.code.toLowerCase() === code.toLowerCase())) {
      return showToast('Promo code already exists', 'error');
    }
    
    currentPromos.push({ code, discount });
    codeInput.value = '';
    discountInput.value = '';
    renderPromos();
  }

  function removePromo(index) {
    currentPromos.splice(index, 1);
    renderPromos();
  }
  
  async function updatePricing() {
    const pid = getPropertyId();
    const weekday = parseFloat(document.getElementById('weekdayPrice').value);
    const weekend = parseFloat(document.getElementById('weekendPrice').value);
    
    if (isNaN(weekday) || isNaN(weekend)) {
      return showToast('Please enter valid numeric prices', 'error');
    }
    
    const res = await fetch('/api/homestay/' + pid + '/pricing', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ weekday, weekend, promos: currentPromos })
    });
    
    if (res.ok) {
      showToast('Settings updated successfully!');
      // Update local data so it stays in sync
      const prop = window.homestaysData.find(p => p.id === pid);
      if (prop) {
        prop.pricing = { weekday, weekend };
        prop.promos = JSON.parse(JSON.stringify(currentPromos));
      }
    } else {
      showToast('Failed to update settings', 'error');
    }
  }

  // Load everything on startup
  function loadAll() {
    loadPeriods();
    loadPricing();
    loadExternalIcal();
    loadPendingRequests();
    
    // Start background polling for new requests every 3 seconds for near-instant updates
    setInterval(pollForNewRequests, 3000);
  }

  // --- Browser Notifications & Audio Alert System ---
  let knownRequestIds = new Set();
  let isFirstLoad = true;
  let audioContextUnlocked = false;

  // Request Notification permission automatically
  if ("Notification" in window && Notification.permission !== "granted" && Notification.permission !== "denied") {
    Notification.requestPermission();
  }

  // Unlock AudioContext on first interaction
  function unlockAudio() {
    if (audioContextUnlocked) return;
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      osc.connect(ctx.destination);
      osc.start(0);
      osc.stop(0.001); // Tiny silent beep to unlock
      audioContextUnlocked = true;
      document.removeEventListener('click', unlockAudio);
      document.removeEventListener('keydown', unlockAudio);
    } catch(e) {}
  }
  document.addEventListener('click', unlockAudio);
  document.addEventListener('keydown', unlockAudio);

  function playBeep(volume = 1) {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gainNode = ctx.createGain();
      osc.connect(gainNode);
      gainNode.connect(ctx.destination);
      osc.type = 'sine';
      osc.frequency.setValueAtTime(800, ctx.currentTime);
      gainNode.gain.setValueAtTime(volume, ctx.currentTime);
      osc.start();
      osc.stop(ctx.currentTime + 0.3);
      
      setTimeout(() => {
        const osc2 = ctx.createOscillator();
        const gain2 = ctx.createGain();
        osc2.connect(gain2);
        gain2.connect(ctx.destination);
        osc2.type = 'sine';
        osc2.frequency.setValueAtTime(1200, ctx.currentTime);
        gain2.gain.setValueAtTime(volume, ctx.currentTime);
        osc2.start();
        osc2.stop(ctx.currentTime + 0.5);
      }, 300);
    } catch(e) { console.error("Audio beep failed", e); }
  }

  async function pollForNewRequests() {
    try {
      const res = await fetch('/api/pending-requests');
      const requests = await res.json();
      
      let hasNew = false;
      requests.forEach(r => {
        if (!knownRequestIds.has(r.id)) {
          knownRequestIds.add(r.id);
          
          if (!isFirstLoad) {
            hasNew = true;
            playBeep();
            if ("Notification" in window && Notification.permission === "granted") {
              new Notification("New Booking Request!", {
                body: r.guestName + " requested dates for " + r.homestayName + ".",
                icon: "/assets/logo/volg-logo-main.webp"
              });
            }
          }
        }
      });

      if (hasNew) {
        loadPendingRequests();
      }
      isFirstLoad = false;
    } catch(err) {
      console.error("Polling error", err);
    }
  }

  loadAll();
</script>
</body>
</html>`);
});

// ─────────────────────────────────────────────────────────────────────────────
//  Public Website Serving
// ─────────────────────────────────────────────────────────────────────────────
app.use(express.static(DIST_DIR));
app.use(express.static(PUBLIC_DIR));

// #15: Safely serve ONLY the public homestay configuration, preventing access to bookings/requests
app.get('/data/homestays.json', async (req, res) => {
  res.json(await getBlob('HOMESTAYS_FILE'));
});

const ASSETS_DIR = path.join(ROOT_DIR, 'assets');
// NOTE: /data is intentionally NOT served as static to protect JSON files (#15)
app.use('/assets', express.static(ASSETS_DIR));

// ─────────────────────────────────────────────────────────────────────────────
//  Start Server
// ─────────────────────────────────────────────────────────────────────────────
export const handler = serverless(app);
