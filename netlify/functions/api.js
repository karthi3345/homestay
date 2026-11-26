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
import jwt from 'jsonwebtoken';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import cors from 'cors';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import nodemailer from 'nodemailer';
import crypto, { randomUUID } from 'crypto';
import * as Rules from '../../lib/booking-rules.js';

if (typeof process.loadEnvFile === 'function' && fs.existsSync(path.join(process.cwd(), '.env'))) {
  try { process.loadEnvFile(path.join(process.cwd(), '.env')); } catch (_) {}
}

// Netlify Blobs Helpers
const BLOB_FILES = {
  BOOKINGS_FILE: 'direct-bookings.json',
  PENDING_FILE: 'pending-requests.json',
  HISTORY_FILE: 'booking-history.json',
  EXTERNAL_ICAL_FILE: 'external-icals.json',
  // The live list of stays. The admin panel edits this copy; data/homestays.json
  // in the repo is only used to seed it (and to add stays that ship in code).
  HOMESTAYS_FILE: 'homestays.json',
  SETTINGS_FILE: 'site-settings.json'
};

const LOCAL_FILES = {
  BOOKINGS_FILE: path.join(process.cwd(), 'data', 'direct-bookings.json'),
  PENDING_FILE: path.join(process.cwd(), 'data', 'pending-requests.json'),
  HISTORY_FILE: path.join(process.cwd(), 'data', 'booking-history.json'),
  EXTERNAL_ICAL_FILE: path.join(process.cwd(), 'data', 'external-icals.json'),
  HOMESTAYS_FILE: path.join(process.cwd(), 'data', 'homestays.json'),
  SETTINGS_FILE: path.join(process.cwd(), 'data', 'site-settings.json')
};

const OBJECT_FILES = new Set(['SETTINGS_FILE']); // stored as {...}, not [...]

// In-memory cache for instant 0ms responses on refresh
const memoryCache = new Map();

function isBlobsConfigured() {
  const siteID = (process.env.NETLIFY_BLOBS_SITE_ID || process.env.SITE_ID || '').trim();
  const token = (process.env.NETLIFY_BLOBS_TOKEN || process.env.NETLIFY_AUTH_TOKEN || '').trim();
  return Boolean((siteID && token) || (process.env.NETLIFY && process.env.NETLIFY_BLOBS_CONTEXT));
}

function getBlobStore(name = 'data') {
  let siteID = process.env.NETLIFY_BLOBS_SITE_ID || process.env.SITE_ID;
  let token = process.env.NETLIFY_BLOBS_TOKEN || process.env.NETLIFY_AUTH_TOKEN;
  if (siteID) siteID = siteID.trim();
  if (token) token = token.trim();

  if (siteID && token) {
    return getStore({
      name,
      siteID,
      token
    });
  }
  return getStore(name);
}

function readLocalJson(fileKey, fallback) {
  try {
    if (fs.existsSync(LOCAL_FILES[fileKey])) return JSON.parse(fs.readFileSync(LOCAL_FILES[fileKey], 'utf-8'));
  } catch (err) {
    console.error('Local file read failed for', fileKey, err.message);
  }
  return fallback;
}

/**
 * Brings things that ship in code into the live copy, without ever overwriting
 * what the admin panel has saved:
 *   • stays in data/homestays.json that the live copy doesn't have yet are
 *     added (unless an admin deleted that stay);
 *   • fields a stay doesn't have at all yet (e.g. nearbyPlaces, houseRules
 *     added in a new version) are filled in from the repo file.
 * Returns the updated list, or null if nothing changed.
 */
function syncFromRepo(liveStays, deletedIds) {
  const repoStays = readLocalJson('HOMESTAYS_FILE', []);
  const deleted = new Set(deletedIds || []);
  let changed = false;
  const result = liveStays.map(live => {
    const repo = repoStays.find(r => r.id === live.id);
    if (!repo) return live;
    const missing = Object.keys(repo).filter(k => !(k in live));
    if (!missing.length) return live;
    changed = true;
    const filled = { ...live };
    missing.forEach(k => { filled[k] = repo[k]; });
    return filled;
  });
  const known = new Set(liveStays.map(h => h.id));
  repoStays.forEach(h => {
    if (h && h.id && !known.has(h.id) && !deleted.has(h.id)) { result.push(h); changed = true; }
  });
  return changed ? result : null;
}

async function getBlob(fileKey) {
  if (memoryCache.has(fileKey)) {
    return memoryCache.get(fileKey);
  }

  // Fast path: if Netlify Blobs is not configured (e.g. local dev, custom server),
  // read local JSON directly without hanging or logging unconfigured errors.
  if (!isBlobsConfigured()) {
    let data = readLocalJson(fileKey, OBJECT_FILES.has(fileKey) ? {} : []);
    if (fileKey === 'HOMESTAYS_FILE') {
      const settings = readLocalJson('SETTINGS_FILE', {});
      const withNew = syncFromRepo(data, settings.deletedStayIds);
      if (withNew) data = withNew;
    }
    if (fileKey === 'SETTINGS_FILE') {
      data = { ...readLocalJson('SETTINGS_FILE', {}), ...(data || {}) };
    }
    memoryCache.set(fileKey, data);
    return data;
  }

  try {
    const store = getBlobStore();
    let data = await store.get(BLOB_FILES[fileKey], { type: 'json' });

    if (fileKey === 'HOMESTAYS_FILE') {
      if (!data) {
        // First run: seed the live copy from the repo file.
        data = readLocalJson('HOMESTAYS_FILE', []);
        await store.setJSON(BLOB_FILES[fileKey], data);
      } else {
        const settings = (await store.get(BLOB_FILES.SETTINGS_FILE, { type: 'json' })) || {};
        const withNew = syncFromRepo(data, settings.deletedStayIds);
        if (withNew) {
          console.log('Adding new stays / new fields from data/homestays.json to the live copy');
          data = withNew;
          await store.setJSON(BLOB_FILES[fileKey], data);
        }
      }
    }

    if (fileKey === 'SETTINGS_FILE') {
      data = { ...readLocalJson('SETTINGS_FILE', {}), ...(data || {}) };
    } else {
      data = data || [];
    }
    memoryCache.set(fileKey, data);
    return data;
  } catch(e) { 
    console.error("Blob Fetch Error for", fileKey, e.message); 
    const fallback = readLocalJson(fileKey, OBJECT_FILES.has(fileKey) ? {} : []);
    memoryCache.set(fileKey, fallback);
    return fallback;
  }
}

async function setBlob(fileKey, data) {
  // Always update in-memory cache immediately for 0ms reads
  memoryCache.set(fileKey, data);

  // Always update local files so development server and builds stay synchronized
  try {
    if (LOCAL_FILES[fileKey]) {
      const dir = path.dirname(LOCAL_FILES[fileKey]);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(LOCAL_FILES[fileKey], JSON.stringify(data, null, 2));

      if (fileKey === 'HOMESTAYS_FILE') {
        const publicPath = path.join(process.cwd(), 'public', 'data', 'homestays.json');
        const distPath = path.join(process.cwd(), 'dist', 'data', 'homestays.json');
        try {
          if (fs.existsSync(path.dirname(publicPath))) fs.writeFileSync(publicPath, JSON.stringify(data, null, 2));
          if (fs.existsSync(path.dirname(distPath))) fs.writeFileSync(distPath, JSON.stringify(data, null, 2));
        } catch (_) {}
      }
    }
  } catch (err) {
    console.error("Local file sync failed:", err.message);
  }

  if (isBlobsConfigured()) {
    try {
      const store = getBlobStore();
      await store.setJSON(BLOB_FILES[fileKey], data);
    } catch(e) {
      console.error("Blob Write Error for", fileKey, e.message);
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
app.use(cookieParser());
// Admin edits (a whole stay with its gallery) need more room than public forms.
const smallJson = express.json({ limit: '10kb' });
const adminJson = express.json({ limit: '300kb' });
app.use((req, res, next) => (req.path.startsWith('/api/admin/') ? adminJson : smallJson)(req, res, next));
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  crossOriginOpenerPolicy: false,
  crossOriginResourcePolicy: false
}));

// CORS Configuration
const allowedOrigins = [
  'https://volgohomestay.netlify.app',
  'https://homestay-silk.vercel.app'
];
app.use(cors({
  origin: (origin, callback) => {
    if (!origin) {
      callback(null, true);
      return;
    }
    const trimmed = origin.trim();
    // Allow localhost
    if (trimmed.startsWith('http://localhost:') || trimmed.startsWith('http://127.0.0.1:')) {
      callback(null, true);
      return;
    }
    // Allow custom domains, subdomains, and Vercel preview/production domains
    const host = trimmed.replace(/^https?:\/\//, '');
    if (host.endsWith('volgo-stays.com') || host.endsWith('volgohomestay.in') || host.endsWith('.vercel.app')) {
      callback(null, true);
      return;
    }
    // Fallback to configured SITE_URL
    if (process.env.SITE_URL) {
      const configuredHost = process.env.SITE_URL.replace(/^https?:\/\//, '').replace(/\/$/, '');
      if (host === configuredHost || host.endsWith('.' + configuredHost)) {
        callback(null, true);
        return;
      }
    }
    // Fallback to allowed list
    if (allowedOrigins.indexOf(trimmed) !== -1) {
      callback(null, true);
    } else {
      callback(new Error('Blocked by CORS policy'));
    }
  },
  credentials: true
}));

const JWT_SECRET = process.env.JWT_SECRET || 'volgo-super-secret-key-change-this-in-production';

// Zod Input Validation Schemas
const bookingRequestSchema = z.object({
  homestayId: z.string().min(1),
  homestayName: z.string().min(1),
  checkIn: z.string().min(1),
  checkOut: z.string().min(1),
  adults: z.number().int().min(1),
  children: z.number().int().min(0),
  guestName: z.string().min(2).max(100),
  guestPhone: z.string().regex(/^\+?[0-9]{10,15}$/),
  promoCode: z.string().optional().nullable(),
  note: z.string().optional().nullable(),
  checkInMs: z.number().int().positive(),
  checkOutMs: z.number().int().positive(),
  checkInDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  checkOutDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  totalAmount: z.number().nonnegative(),
  breakfast: z.boolean().optional().nullable(),
  // 'whole' (default) or the ids of the rooms being booked
  units: z.union([z.literal('whole'), z.array(z.string().max(40)).max(10)]).optional().nullable()
});

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const priceSchema = z.object({ weekday: z.number().nonnegative(), weekend: z.number().nonnegative().optional().nullable() });

const pricingSchema = z.object({
  weekday: z.number().nonnegative(),
  weekend: z.number().nonnegative(),
  promos: z.array(z.object({
    code: z.string().min(1),
    discount: z.number().min(1).max(100),
    from: dateStr,
    to: dateStr
  })).optional().nullable(),
  // Room-by-room stays (the villa)
  roomPrices: z.record(z.string(), priceSchema).optional().nullable(),
  allowRoomsOnWeekends: z.boolean().optional().nullable(),
  // Price periods, e.g. "Year-end" 10 Dec – 6 Jan. `to` is the last night.
  seasons: z.array(z.object({
    id: z.string().max(40).optional(),
    name: z.string().min(1).max(40),
    from: dateStr,
    to: dateStr,
    pricing: priceSchema,
    roomPrices: z.record(z.string(), priceSchema).optional().nullable()
  })).max(20).optional().nullable()
});

const blockedPeriodSchema = z.object({
  from: dateStr,
  to: dateStr,
  note: z.string().max(200).optional().nullable(),
  units: z.union([z.literal('whole'), z.array(z.string().max(40)).max(10)]).optional().nullable()
});

// Everything about a stay that the admin panel can edit (prices have their own endpoint).
const imagePath = z.string().max(300).regex(/^(\/api\/images\/[\w.-]+|\/?assets\/[\w./-]+|\/uploads\/[\w.-]+|https:\/\/[^\s"'<>()]+)$/, 'Invalid image address');
const shortText = (max) => z.string().max(max).optional().default('');
const textList = z.array(z.string().max(300)).max(30).optional().default([]);
const staySchema = z.object({
  name: z.string().trim().min(2).max(80),
  published: z.boolean().optional().default(true),
  tagline: shortText(160),
  city: shortText(60),
  areaName: shortText(60),
  area: shortText(40),
  description: shortText(4000),
  capacity: z.number().int().min(1).max(40),
  bedrooms: z.number().int().min(0).max(20),
  bathrooms: z.number().min(0).max(20),
  location: shortText(200),
  coordinates: z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }),
  phone: shortText(30),
  whatsapp: shortText(30),
  email: shortText(100),
  thumbnail: z.union([imagePath, z.literal('')]).optional().default(''),
  imageCategories: z.array(z.object({
    category: z.string().trim().min(1).max(60),
    images: z.array(imagePath).max(40)
  })).max(20).optional().default([]),
  amenityCategories: z.array(z.object({
    category: z.string().trim().min(1).max(60),
    items: z.array(z.object({ name: z.string().trim().min(1).max(60), icon: z.string().regex(/^[a-z0-9_]{1,40}$/) })).max(40)
  })).max(20).optional().default([]),
  nearbyPlaces: z.array(z.object({
    name: z.string().trim().min(1).max(80),
    type: z.enum(['beach', 'landmark', 'food', 'other']).default('beach'),
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    walkMinutes: z.number().int().min(1).max(240).optional().nullable()
  })).max(12).optional().default([]),
  layoutDetails: textList,
  guestInstructions: textList,
  houseRules: textList,
  hostName: shortText(60),
  hostBio: shortText(1000),
  bookingMode: z.enum(['whole', 'rooms']).optional().default('whole'),
  wholeLabel: shortText(40),
  rooms: z.array(z.object({
    id: z.string().regex(/^[a-z0-9-]{1,40}$/),
    name: z.string().trim().min(1).max(80),
    description: shortText(400),
    capacity: z.number().int().min(1).max(20)
  })).max(10).optional().default([])
});

const settingsSchema = z.object({
  contact: z.object({ phone: shortText(30), whatsapp: shortText(30), email: shortText(100) }).optional(),
  backgroundImages: z.array(imagePath).max(10).optional().default([])
});

function zodMessage(parsed) {
  return parsed.error.issues.map(i => `${i.path.join('.') || 'input'}: ${i.message}`).slice(0, 5).join('; ');
}

function slugify(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'stay';
}

function isAdminRequest(req) {
  try { return Boolean(req.cookies?.volgo_session && jwt.verify(req.cookies.volgo_session, JWT_SECRET)); }
  catch (_) { return false; }
}

/** Booked periods for a stay: confirmed blocks plus live pending holds. */
async function getAllPeriods(propertyId) {
  const data = await getBlob('BOOKINGS_FILE');
  const record = data.find(b => b.propertyId === propertyId);
  const periods = record ? [...record.blockedPeriods] : [];
  const pending = await getBlob('PENDING_FILE');
  pending
    .filter(p => p.homestayId === propertyId && (!p.expiresAt || p.expiresAt > Date.now()))
    .forEach(hold => {
      const from = hold.checkInDate || hold.checkIn;
      const to = hold.checkOutDate || hold.checkOut;
      if (Rules.isDateStr(from) && Rules.isDateStr(to)) {
        periods.push({ from, to, units: hold.units || 'whole', note: 'Pending (Auto-Hold)', pending: true, requestId: hold.id });
      }
    });
  return periods;
}

function todayInIndia() {
  return new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 10);
}

// Audit Logging Helper
async function logAdminAction(username, ip, action, details) {
  try {
    const history = await getBlob('HISTORY_FILE');
    history.push({
      id: 'LOG-' + randomUUID(),
      timestamp: new Date().toISOString(),
      username,
      ip,
      action,
      details
    });
    await setBlob('HISTORY_FILE', history);
  } catch (err) {
    console.error("Audit log write failed:", err.message);
  }
}

// Session JWT Verification Middleware
function authMiddleware(req, res, next) {
  const token = req.cookies.volgo_session;
  if (!token) {
    return res.status(401).json({ error: 'Unauthorized: No session token found.' });
  }
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.adminUser = decoded.username;
    next();
  } catch (err) {
    res.clearCookie('volgo_session');
    return res.status(401).json({ error: 'Unauthorized: Session expired or invalid.' });
  }
}


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
// #3: HTML sanitizer for user-submitted fields
function sanitizeHtml(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
}

// GET /api/homestays
app.get('/api/homestays', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Expires', '-1');
  res.setHeader('Pragma', 'no-cache');
  try {
    const data = await getBlob('HOMESTAYS_FILE');
    // Stays switched off in the admin panel (e.g. still waiting for photos) are hidden.
    res.json(data.filter(h => h.published !== false));
  } catch (err) {
    res.status(500).json({ error: 'Failed to retrieve homestays data.' });
  }
});

// GET /api/site-settings – public contact details and background images.
app.get('/api/site-settings', async (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=300');
  try {
    const settings = await getBlob('SETTINGS_FILE');
    res.json({
      contact: settings.contact || {},
      backgroundImages: Array.isArray(settings.backgroundImages) ? settings.backgroundImages : []
    });
  } catch (err) {
    res.json({ contact: {}, backgroundImages: [] });
  }
});

app.post('/api/request-booking', applyRateLimit, async (req, res) => {
  try {
    const parsed = bookingRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid input formatting: ' + parsed.error.issues.map(i => i.message).join(', ') });
    }
    const payload = parsed.data;

    const stays = await getBlob('HOMESTAYS_FILE');
    const stay = stays.find(h => h.id === payload.homestayId && h.published !== false);
    if (!stay) return res.status(404).json({ error: 'This stay is not available for booking.' });

    // Check availability with the same rules the website uses (whole villa vs
    // rooms, Friday/Saturday rule). Dates are the YYYY-MM-DD fields; checkIn /
    // checkOut are display text for emails.
    const selection = Rules.normalizeSelection(stay, Rules.unitsToSelection(payload.units));
    const periods = await getAllPeriods(stay.id);
    const problem = Rules.validateBooking(stay, periods, selection, payload.checkInDate, payload.checkOutDate);
    if (problem) return res.status(409).json({ error: problem });

    const guests = payload.adults + payload.children;
    if (guests > Rules.capacityFor(stay, selection)) {
      return res.status(400).json({ error: 'Too many guests for the rooms selected.' });
    }

    // The server works out the price; the browser's figure is not trusted.
    const priced = Rules.quote(stay, selection, payload.checkInDate, payload.checkOutDate, payload.promoCode);
    let calculatedTotal = priced.total;
    if (payload.breakfast) {
      const nights = Rules.eachNight(payload.checkInDate, payload.checkOutDate).length;
      calculatedTotal += (payload.adults + payload.children) * 200 * nights;
    }
    payload.totalAmount = calculatedTotal;
    payload.units = Rules.selectionToUnits(selection);
    payload.unitsLabel = Rules.selectionLabel(stay, selection);
    payload.homestayName = stay.name;
    // Work out times from the dates (2 PM check-in, 10 AM check-out, India time)
    // instead of trusting the browser's clock.
    payload.checkInMs = Date.parse(payload.checkInDate + 'T14:00:00+05:30');
    payload.checkOutMs = Date.parse(payload.checkOutDate + 'T10:00:00+05:30');
    if (payload.checkOutMs <= Date.now()) return res.status(400).json({ error: 'Please choose dates in the future.' });

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
        host: 'smtp.gmail.com',
        port: 587,
        secure: false, // STARTTLS is faster and less prone to timeouts in serverless
        auth: {
          user: process.env.EMAIL_USER,
          pass: process.env.EMAIL_PASS
        }
      });

      const siteUrl = process.env.SITE_URL || 'http://localhost:3000'; // #13: Use SITE_URL in production
      const mailOptions = {
        from: '"Volgo Booking Alert" <' + process.env.EMAIL_USER + '>',
        to: process.env.EMAIL_RECEIVER || process.env.EMAIL_USER,
        subject: "\uD83C\uDF89 New Booking Request - " + sanitizeHtml(payload.homestayName),
        html: "<h2>New Booking Request Received!</h2>" +
              "<p><strong>Property:</strong> " + sanitizeHtml(payload.homestayName) + "</p>" +
              "<p><strong>Booking:</strong> " + sanitizeHtml(payload.unitsLabel) + " &mdash; &#8377;" + Number(payload.totalAmount).toLocaleString('en-IN') + "</p>" +
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

      try {
        const info = await transporter.sendMail(mailOptions);
        console.log("Email successfully dispatched to Gmail:", info.response);
      } catch (err) {
        console.error("Email send failed:", err);
      }
    }

    res.json({ success: true, id: payload.id });
  } catch (err) {
    console.error("Booking request error:", err);
    res.status(500).json({ error: "Server error: " + err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  ADMIN AUTHENTICATION & SESSIONS (JWT + MFA)
// ─────────────────────────────────────────────────────────────────────────────

// Helper to send email OTP
async function sendOtpEmail(otpCode) {
  if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
    const transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 587,
      secure: false, // STARTTLS
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
      }
    });

    const mailOptions = {
      from: '"Volgo Admin Security" <' + process.env.EMAIL_USER + '>',
      to: process.env.EMAIL_RECEIVER || process.env.EMAIL_USER,
      subject: "🔒 Volgo Admin MFA Verification Code",
      html: "<h2>Admin Panel Login Request</h2>" +
            "<p>Your 6-digit Multi-Factor Authentication code is:</p>" +
            "<h1 style='font-size:32px; letter-spacing:5px; background:#f4f4f4; padding:10px 20px; display:inline-block; border-radius:5px; color:#222;'>" + otpCode + "</h1>" +
            "<p>This code will expire in 5 minutes. If you did not request this code, please change your admin password immediately.</p>"
    };

    await transporter.sendMail(mailOptions);
    console.log("MFA OTP email dispatched successfully.");
  } else {
    console.log("No SMTP configured. OTP Code for dev:", otpCode);
  }
}

// Helper to set OTP with local file fallback
async function setOtp(otpData) {
  try {
    const store = getBlobStore();
    await store.setJSON('admin-otp', otpData);
  } catch (err) {
    console.warn("Netlify Blobs setJSON failed, using local fallback for OTP:", err.message);
    const localPath = path.join(ROOT_DIR, 'data', 'admin-otp.json');
    const dir = path.dirname(localPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(localPath, JSON.stringify(otpData));
  }
}

// Helper to get OTP with local file fallback
async function getOtp() {
  try {
    const store = getBlobStore();
    return await store.getJSON('admin-otp');
  } catch (err) {
    console.warn("Netlify Blobs getJSON failed, using local fallback for OTP:", err.message);
    const localPath = path.join(ROOT_DIR, 'data', 'admin-otp.json');
    if (fs.existsSync(localPath)) {
      return JSON.parse(fs.readFileSync(localPath, 'utf-8'));
    }
  }
  return null;
}

// Helper to delete OTP with local file fallback
async function deleteOtp() {
  try {
    const store = getBlobStore();
    await store.delete('admin-otp');
  } catch (err) {
    const localPath = path.join(ROOT_DIR, 'data', 'admin-otp.json');
    if (fs.existsSync(localPath)) {
      try { fs.unlinkSync(localPath); } catch (e) {}
    }
  }
}

// POST /api/admin/login
app.post('/api/admin/login', applyRateLimit, async (req, res) => {
  try {
  const { username, password } = req.body || {};
  const targetUser = process.env.ADMIN_USER || 'admin';
  const targetPass = process.env.ADMIN_PASS || 'volgo123';

  if (username !== targetUser || password !== targetPass) {
    return res.status(401).json({ error: 'Invalid username or password.' });
  }

  // OTP turned off as requested (set ENABLE_ADMIN_OTP=true to re-enable)
  const isOtpEnabled = process.env.ENABLE_ADMIN_OTP === 'true';

  if (!isOtpEnabled) {
    const token = jwt.sign({ username: targetUser }, JWT_SECRET, { expiresIn: '2h' });
    const isSecure = req.headers.host && !req.headers.host.includes('localhost') && !req.headers.host.includes('127.0.0.1');
    res.cookie('volgo_session', token, {
      httpOnly: true,
      secure: isSecure,
      sameSite: 'strict',
      maxAge: 2 * 60 * 60 * 1000 // 2 hours
    });
    return res.json({ success: true, mfaRequired: false });
  }

  // Generate 6-digit OTP
  const otpCode = Math.floor(100000 + Math.random() * 900000).toString();

  try {
    // Generate a secure SHA-256 hash of the OTP code
    const otpHash = crypto.createHash('sha256').update(otpCode).digest('hex');

    // Create a signed, short-lived JWT token containing the hash
    const pendingToken = jwt.sign({ hash: otpHash }, JWT_SECRET, { expiresIn: '5m' });

    // Set the token as a secure HttpOnly cookie
    const isSecure = req.headers.host && !req.headers.host.includes('localhost') && !req.headers.host.includes('127.0.0.1');
    res.cookie('volgo_mfa_pending', pendingToken, {
      httpOnly: true,
      secure: isSecure,
      sameSite: 'strict',
      maxAge: 5 * 60 * 1000 // 5 minutes
    });

    await sendOtpEmail(otpCode);
    res.json({ success: true, mfaRequired: true });
  } catch (err) {
    res.status(500).json({ error: 'Internal system error initializing MFA.' });
  }
  } catch (outerErr) {
    res.status(500).json({ error: outerErr.message || 'Login handler error' });
  }
});

// POST /api/admin/verify-otp
app.post('/api/admin/verify-otp', applyRateLimit, async (req, res) => {
  const { otp } = req.body;
  if (!otp || typeof otp !== 'string') {
    return res.status(400).json({ error: 'Verification code is required.' });
  }

  const pendingToken = req.cookies.volgo_mfa_pending;
  if (!pendingToken) {
    return res.status(401).json({ error: 'MFA session expired. Please log in again.' });
  }

  try {
    // Decode and verify the pending MFA token
    let decoded;
    try {
      decoded = jwt.verify(pendingToken, JWT_SECRET);
    } catch (jwtErr) {
      res.clearCookie('volgo_mfa_pending');
      return res.status(401).json({ error: 'Verification session expired. Please try again.' });
    }

    // Verify the submitted OTP against the signed hash
    const inputHash = crypto.createHash('sha256').update(otp.trim()).digest('hex');
    if (decoded.hash !== inputHash) {
      return res.status(401).json({ error: 'Invalid verification code.' });
    }

    // Clear the pending MFA cookie
    res.clearCookie('volgo_mfa_pending');

    // Create the final session JWT
    const token = jwt.sign({ username: process.env.ADMIN_USER || 'admin' }, JWT_SECRET, { expiresIn: '2h' });

    // Set secure HttpOnly cookie for session authorization
    const isSecure = req.headers.host && !req.headers.host.includes('localhost') && !req.headers.host.includes('127.0.0.1');
    res.cookie('volgo_session', token, {
      httpOnly: true,
      secure: isSecure,
      sameSite: 'strict',
      maxAge: 2 * 60 * 60 * 1000 // 2 hours
    });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'MFA verification failed.' });
  }
});

// GET /api/admin/check-session
app.get('/api/admin/check-session', (req, res) => {
  const token = req.cookies.volgo_session;
  if (!token) return res.json({ authenticated: false });
  try {
    jwt.verify(token, JWT_SECRET);
    res.json({ authenticated: true });
  } catch (e) {
    res.clearCookie('volgo_session');
    res.json({ authenticated: false });
  }
});

// POST /api/admin/logout
app.post('/api/admin/logout', (req, res) => {
  res.clearCookie('volgo_session');
  res.json({ success: true });
});

// Protect the API routes with JWT middleware
app.use([
  '/api/pending-requests',
  '/api/approve-request',
  '/api/decline-request',
  '/api/external-ical',
  '/api/homestay/:propertyId/pricing'
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
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  const data = (await getBlob('BOOKINGS_FILE'));
  const record = data.find(b => b.propertyId === req.params.propertyId) || { blockedPeriods: [] };

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 3); // 3 days ago
  const cutoffMs = cutoff.getTime();

  // Permanently remove bookings that ended more than 3 days ago
  const originalLength = record.blockedPeriods.length;
  record.blockedPeriods = record.blockedPeriods.filter(p => {
    return new Date(p.to).getTime() >= cutoffMs;
  });

  // If any were removed, save the file
  if (record.propertyId && record.blockedPeriods.length !== originalLength) {
    await setBlob('BOOKINGS_FILE', data);
    regenerateIcal();
  }

  const combinedPeriods = await getAllPeriods(req.params.propertyId);

  // Guests only need the dates. Notes (which hold guest names) are admin-only.
  if (!isAdminRequest(req)) {
    return res.json(combinedPeriods.map(p => ({ from: p.from, to: p.to, units: p.units || 'whole' })));
  }
  res.json(combinedPeriods);
});

// ─────────────────────────────────────────────────────────────────────────────
//  API: add a blocked period
// ─────────────────────────────────────────────────────────────────────────────
// Update Pricing Endpoint
app.post('/api/homestay/:id/pricing', authMiddleware, async (req, res) => {
  const parsed = pricingSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid input formatting: ' + parsed.error.issues.map(i => i.message).join(', ') });
  }
  const { weekday, weekend, promos, roomPrices, allowRoomsOnWeekends, seasons } = parsed.data;
  await logAdminAction(req.adminUser, req.ip || req.socket.remoteAddress, 'UPDATE_PRICING', { propertyId: req.params.id, weekday, weekend, promosCount: promos ? promos.length : 0, seasonsCount: seasons ? seasons.length : 0, allowRoomsOnWeekends });

  if (true) {
    const data = (await getBlob('HOMESTAYS_FILE'));
    const record = data.find(b => b.id === req.params.id);
    if (record) {
      record.pricing = { weekday, weekend };
      record.promos = Array.isArray(promos) ? promos : [];
      if (roomPrices && Array.isArray(record.rooms)) {
        record.rooms.forEach(room => {
          const p = roomPrices[room.id];
          if (p) room.price = { weekday: p.weekday, weekend: p.weekend || p.weekday };
        });
      }
      if (typeof allowRoomsOnWeekends === 'boolean') {
        record.roomBooking = { ...(record.roomBooking || {}), allowOnWeekends: allowRoomsOnWeekends };
      }
      if (Array.isArray(seasons)) {
        const bad = seasons.find(se => se.from > se.to);
        if (bad) return res.status(400).json({ error: `Price period "${bad.name}" ends before it starts.` });
        record.seasons = seasons.map(se => ({ ...se, id: se.id || 'season-' + randomUUID().slice(0, 8) }));
      }
      // Clean up old single promo if it exists
      if (record.promo) delete record.promo;
      await setBlob('HOMESTAYS_FILE', data);
      return res.json({ success: true });
    }
  }
  return res.status(404).json({ error: 'Property not found.' });
});

app.post('/api/periods/:propertyId', authMiddleware, async (req, res) => {
  const parsed = blockedPeriodSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid input formatting: ' + parsed.error.issues.map(i => i.message).join(', ') });
  }
  const { from, to, note } = parsed.data;
  const stays = await getBlob('HOMESTAYS_FILE');
  const stay = stays.find(h => h.id === req.params.propertyId) || {};
  const selection = Rules.normalizeSelection(stay, Rules.unitsToSelection(parsed.data.units));
  const units = Rules.selectionToUnits(selection);

  if (from >= to) {
    return res.status(400).json({ error: 'Invalid dates. "from" must be before "to".' });
  }

  // Warn if overlaps with pending
  if (true) {
    const pending = (await getBlob('PENDING_FILE'));
    const d1 = new Date(from).getTime();
    const d2 = new Date(to).getTime();
    const overlapPending = pending.some(p => p.homestayId === req.params.propertyId && d1 < p.checkOutMs && d2 > p.checkInMs &&
      Rules.periodBlocksSelection({ units: p.units }, selection));
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

  const overlap = record.blockedPeriods.some(p => from < p.to && to > p.from && Rules.periodBlocksSelection(p, selection));
  if (overlap) {
    return res.status(409).json({ error: 'These dates overlap with an existing blocked period.' });
  }

  record.blockedPeriods.push({ from, to, ...(note ? { note } : {}), ...(units !== 'whole' ? { units } : {}) });
  record.blockedPeriods.sort((a, b) => a.from.localeCompare(b.from));

  await setBlob('BOOKINGS_FILE', data);
  await logAdminAction(req.adminUser, req.ip || req.socket.remoteAddress, 'ADD_BLOCKED_PERIOD', { propertyId: req.params.propertyId, from, to, note, units });
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

  const removedPeriod = rec.blockedPeriods[idx];
  rec.blockedPeriods.splice(idx, 1);
  await setBlob('BOOKINGS_FILE', data);
  await logAdminAction(req.adminUser, req.ip || req.socket.remoteAddress, 'REMOVE_BLOCKED_PERIOD', { propertyId: req.params.propertyId, period: removedPeriod });
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
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
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

app.post('/api/approve-request/:id', authMiddleware, async (req, res) => {
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
  
  // Use the YYYY-MM-DD fields; checkIn/checkOut are display text like "Fri, Dec 4, 2026".
  const fromStr = reqObj.checkInDate || reqObj.checkIn;
  const toStr = reqObj.checkOutDate || reqObj.checkOut;
  const selection = Rules.unitsToSelection(reqObj.units);
  
  // FINAL AVAILABILITY CHECK BEFORE APPROVING
  const overlap = record.blockedPeriods.some(p => fromStr < p.to && toStr > p.from && Rules.periodBlocksSelection(p, selection));
  if (overlap) {
    return res.status(409).json({error: 'These dates were booked on another platform (or manually). This request can no longer be approved.'});
  }
  
  record.blockedPeriods.push({
    from: fromStr,
    to: toStr,
    note: '[Approved] ' + reqObj.guestName + (reqObj.unitsLabel && reqObj.units !== 'whole' ? ' — ' + reqObj.unitsLabel : ''),
    ...(Array.isArray(reqObj.units) ? { units: reqObj.units } : {})
  });
  record.blockedPeriods.sort((a, b) => a.from.localeCompare(b.from));
  
  await setBlob('BOOKINGS_FILE', data);
  
  // Remove from pending and save to history
  pending = pending.filter(r => r.id !== id);
  await setBlob('PENDING_FILE', pending);
  await saveToHistory(reqObj, 'Approved');
  await logAdminAction(req.adminUser, req.ip || req.socket.remoteAddress, 'APPROVE_REQUEST', { requestId: id, guestName: reqObj.guestName, checkIn: reqObj.checkInDate, checkOut: reqObj.checkOutDate });
  
  res.json({ success: true });
});

app.delete('/api/decline-request/:id', authMiddleware, async (req, res) => {
  const id = req.params.id;
  const _tPENDING_FILE = await getBlob('PENDING_FILE'); if (!_tPENDING_FILE || _tPENDING_FILE.length===0) return res.json({success: true});
  let pending = (await getBlob('PENDING_FILE'));
  const reqObj = pending.find(r => r.id === id);
  if (reqObj) {
    await saveToHistory(reqObj, 'Declined');
    await logAdminAction(req.adminUser, req.ip || req.socket.remoteAddress, 'DECLINE_REQUEST', { requestId: id, guestName: reqObj.guestName, checkIn: reqObj.checkInDate, checkOut: reqObj.checkOutDate });
  }
  
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

// GET /api/cron/sync - Triggered by scheduled Netlify Function
app.get('/api/cron/sync', async (req, res) => {
  const authHeader = req.headers.authorization;
  const secretToken = process.env.CRON_SECRET || 'volgo-cron-secret-123';
  if (authHeader !== `Bearer ${secretToken}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const data = await getBlob('EXTERNAL_ICAL_FILE');
    if (!data || data.length === 0) {
      return res.json({ success: true, message: 'No feeds configured.' });
    }
    
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
              console.error(`Sync failed for feed ${feed.name}:`, e.message);
              feed.status = 'Failed';
              feed.lastSync = new Date().toISOString();
            }
            changed = true;
          }
        }
      }
    }
    if (changed) {
      await setBlob('EXTERNAL_ICAL_FILE', data);
    }
    res.json({ success: true, syncExecuted: changed });
  } catch (err) {
    console.error("Scheduled sync execution failed:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/history', authMiddleware, async (req, res) => {
  try {
    const history = await getBlob('HISTORY_FILE');
    res.json(history || []);
  } catch (err) {
    res.status(500).json({ error: 'Failed to retrieve audit log history.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  ADMIN: stays, photos and site settings (everything the website shows)
// ─────────────────────────────────────────────────────────────────────────────

// All stays, including hidden ones, for the admin editor.
app.get('/api/admin/homestays', authMiddleware, async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(await getBlob('HOMESTAYS_FILE'));
});

// Create a new stay without touching code.
app.post('/api/admin/homestays', authMiddleware, async (req, res) => {
  const parsed = staySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: zodMessage(parsed) });
  const data = await getBlob('HOMESTAYS_FILE');
  let id = slugify(parsed.data.name);
  while (data.some(h => h.id === id)) id = slugify(parsed.data.name).slice(0, 33) + '-' + randomUUID().slice(0, 6);
  const stay = {
    id,
    ...parsed.data,
    pricing: { weekday: 0, weekend: 0 },
    promos: [],
    seasons: [],
    bookedDates: [],
    rooms: parsed.data.rooms.map(r => ({ ...r, price: { weekday: 0, weekend: 0 } }))
  };
  data.push(stay);
  await setBlob('HOMESTAYS_FILE', data);
  await logAdminAction(req.adminUser, req.ip, 'CREATE_STAY', { id, name: stay.name });
  res.json({ success: true, stay });
});

// Save a stay's details (name, overview, gallery, amenities, map places, rooms…).
// Prices, promos and price periods are saved by /api/homestay/:id/pricing.
app.put('/api/admin/homestays/:id', authMiddleware, async (req, res) => {
  const parsed = staySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: zodMessage(parsed) });
  const data = await getBlob('HOMESTAYS_FILE');
  const stay = data.find(h => h.id === req.params.id);
  if (!stay) return res.status(404).json({ error: 'Stay not found.' });

  const oldRooms = Array.isArray(stay.rooms) ? stay.rooms : [];
  Object.assign(stay, parsed.data);
  // Keep each room's prices when its details are edited.
  stay.rooms = parsed.data.rooms.map(r => ({ ...r, price: oldRooms.find(o => o.id === r.id)?.price || { weekday: 0, weekend: 0 } }));
  if (stay.mapEmbedUrl) delete stay.mapEmbedUrl; // built from coordinates now

  await setBlob('HOMESTAYS_FILE', data);
  await logAdminAction(req.adminUser, req.ip, 'UPDATE_STAY', { id: stay.id, name: stay.name, published: stay.published });
  res.json({ success: true, stay });
});

app.delete('/api/admin/homestays/:id', authMiddleware, async (req, res) => {
  const data = await getBlob('HOMESTAYS_FILE');
  const stay = data.find(h => h.id === req.params.id);
  if (!stay) return res.status(404).json({ error: 'Stay not found.' });
  if (data.length <= 1) return res.status(400).json({ error: 'The website needs at least one stay.' });

  const bookings = await getBlob('BOOKINGS_FILE');
  const record = bookings.find(b => b.propertyId === stay.id);
  const upcoming = (record?.blockedPeriods || []).some(p => p.to >= todayInIndia() && !p.external);
  if (upcoming && !req.query.force) {
    return res.status(409).json({ error: 'This stay has upcoming bookings. Hide it instead, or confirm to delete anyway.' });
  }

  await setBlob('HOMESTAYS_FILE', data.filter(h => h.id !== stay.id));
  // Remember the deletion so the repo's data/homestays.json doesn't bring it back.
  const settings = await getBlob('SETTINGS_FILE');
  settings.deletedStayIds = [...new Set([...(settings.deletedStayIds || []), stay.id])];
  await setBlob('SETTINGS_FILE', settings);
  await logAdminAction(req.adminUser, req.ip, 'DELETE_STAY', { id: stay.id, name: stay.name });
  res.json({ success: true });
});

app.get('/api/admin/site-settings', authMiddleware, async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(await getBlob('SETTINGS_FILE'));
});

app.put('/api/admin/site-settings', authMiddleware, async (req, res) => {
  const parsed = settingsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: zodMessage(parsed) });
  const settings = await getBlob('SETTINGS_FILE');
  if (parsed.data.contact) settings.contact = parsed.data.contact;
  if (Array.isArray(parsed.data.backgroundImages)) settings.backgroundImages = parsed.data.backgroundImages;
  delete settings.festiveThemes;
  await setBlob('SETTINGS_FILE', settings);
  await logAdminAction(req.adminUser, req.ip, 'UPDATE_SITE_SETTINGS', { backgroundImages: (settings.backgroundImages || []).length });
  res.json({ success: true, settings });
});

// Photo upload. The admin page shrinks photos to WebP before sending.
const IMAGE_TYPES = { 'image/webp': 'webp', 'image/jpeg': 'jpg', 'image/png': 'png' };
const UPLOADS_DIR = path.join(process.cwd(), 'public', 'uploads');
app.post('/api/admin/images', authMiddleware, express.raw({ type: Object.keys(IMAGE_TYPES), limit: '4mb' }), async (req, res) => {
  const type = (req.headers['content-type'] || '').split(';')[0].trim();
  if (!IMAGE_TYPES[type] || !Buffer.isBuffer(req.body) || req.body.length === 0) {
    return res.status(400).json({ error: 'Please upload a JPG, PNG or WebP photo under 4 MB.' });
  }
  const key = `img-${Date.now()}-${randomUUID().slice(0, 8)}.${IMAGE_TYPES[type]}`;
  try {
    const bytes = req.body.buffer.slice(req.body.byteOffset, req.body.byteOffset + req.body.byteLength);
    await getBlobStore('images').set(key, bytes, { metadata: { contentType: type } });
    return res.json({ success: true, url: `/api/images/${key}` });
  } catch (err) {
    // Local development without Netlify Blobs: save next to the site's other files.
    try {
      fs.mkdirSync(UPLOADS_DIR, { recursive: true });
      fs.writeFileSync(path.join(UPLOADS_DIR, key), req.body);
      return res.json({ success: true, url: `/uploads/${key}` });
    } catch (e) {
      console.error('Image upload failed:', err.message, e.message);
      return res.status(500).json({ error: 'Could not save the photo.' });
    }
  }
});

app.get('/api/images/:key', async (req, res) => {
  const key = req.params.key;
  if (!/^img-[\w-]+\.(webp|jpg|png)$/.test(key)) return res.status(404).end();
  try {
    const found = await getBlobStore('images').getWithMetadata(key, { type: 'arrayBuffer' });
    if (!found) return res.status(404).end();
    res.setHeader('Content-Type', found.metadata?.contentType || 'image/webp');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    return res.send(Buffer.from(found.data));
  } catch (err) {
    const local = path.join(UPLOADS_DIR, key);
    if (fs.existsSync(local)) return res.sendFile(local);
    return res.status(404).end();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  GET /admin → Serve the protected admin UI
// ─────────────────────────────────────────────────────────────────────────────
app.get('/admin', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Expires', '-1');
  res.setHeader('Pragma', 'no-cache');
  const properties = (await getBlob('HOMESTAYS_FILE'));
  const propertyOptions = properties.map(p =>
    `<option value="${sanitizeHtml(p.id)}">${sanitizeHtml(p.name)}${p.published === false ? ' (hidden)' : ''}</option>`
  ).join('');

  let calendarStyles = '';
  let calendarJs = '';
  let adminExtraJs = '';
  let adminExtraCss = '';
  try {
    adminExtraJs = fs.readFileSync(path.join(ROOT_DIR, 'admin', 'admin-extra.js'), 'utf-8');
    adminExtraCss = fs.readFileSync(path.join(ROOT_DIR, 'admin', 'admin-extra.css'), 'utf-8');
  } catch (e) { console.error('Admin extras missing:', e.message); }
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
  <script>window.homestaysData = ${JSON.stringify(properties).replace(/</g, '\\u003c')};</script>
  <style>
    ${calendarStyles}
    #adminCalendar .selection-summary, #adminCalendar .guest-selector-container { display: none !important; }
    ${adminExtraCss}
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
    input[type="date"], input[type="text"], input[type="number"], input[type="password"], select {
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
    /* ── Login Overlay ── */
    #loginOverlay {
      font-family: 'Inter', sans-serif;
      color: var(--text);
    }
    .login-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 40px;
      width: 90%;
      max-width: 400px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.4);
      display: flex;
      flex-direction: column;
      gap: 20px;
    }
    .login-logo {
      height: 48px;
      object-fit: contain;
      align-self: center;
      margin-bottom: 8px;
      filter: invert(1) opacity(0.85);
    }
    .login-title {
      font-size: 18px;
      font-weight: 600;
      text-align: center;
      color: var(--accent);
      letter-spacing: 0.5px;
    }
    .login-input {
      width: 100%;
      background: rgba(255,255,255,0.03);
      border: 1px solid var(--border);
      border-radius: 8px;
      color: var(--text);
      padding: 12px 16px;
      font-size: 14px;
      outline: none;
      transition: var(--transition);
    }
    .login-input:focus {
      border-color: var(--accent);
      background: rgba(255,255,255,0.06);
    }
    .login-btn {
      width: 100%;
      background: var(--accent);
      color: #0d0e11;
      border: none;
      border-radius: 8px;
      padding: 12px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      transition: var(--transition);
    }
    .login-btn:hover {
      background: var(--accent2);
    }
    .login-error {
      color: var(--danger);
      font-size: 13px;
      text-align: center;
      display: none;
    }
  </style>
</head>
<body>

<!-- Secure Login Panel Overlay -->
<div id="loginOverlay" style="display: flex; align-items: center; justify-content: center; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: var(--bg); z-index: 1000;">
  <div class="login-card">
    <img src="/assets/logo/volg-logo-main.webp" alt="VOLGO" class="login-logo">
    
    <!-- Step 1: Username & Password -->
    <div id="loginCredentialsForm" style="display: flex; flex-direction: column; gap: 16px;">
      <div class="login-title">Admin Authorization</div>
      <input type="text" id="adminUserField" placeholder="Username" class="login-input">
      <input type="password" id="adminPassField" placeholder="Password" class="login-input">
      <div id="loginErrorMsg" class="login-error"></div>
      <button onclick="submitAdminCredentials()" class="login-btn">Send MFA Code</button>
    </div>

    <!-- Step 2: 6-digit OTP Code -->
    <div id="loginOtpForm" style="display: none; flex-direction: column; gap: 16px;">
      <div class="login-title">Enter MFA Code</div>
      <div style="font-size: 13px; color: var(--muted); text-align: center;">We sent a 6-digit verification code to your email inbox.</div>
      <input type="text" id="adminOtpField" placeholder="6-digit Code" class="login-input" maxlength="6" style="text-align: center; letter-spacing: 4px; font-weight: bold; font-size: 18px;">
      <div id="otpErrorMsg" class="login-error"></div>
      <button onclick="submitMfaOtp()" class="login-btn">Verify & Authorize</button>
      <button onclick="goBackToLogin()" class="login-btn" style="background: transparent; color: var(--muted); border: 1px solid var(--border);">Back to Login</button>
    </div>
  </div>
</div>

<!-- Main Application Wrap -->
<div id="appContainer" style="display: none;">

<header style="display: flex; justify-content: space-between; align-items: center; width: 100%; flex-wrap: wrap; gap: 12px;">
  <div style="display: flex; align-items: center;">
    <img src="/assets/logo/volg-logo-main.webp" alt="VOLGO" class="admin-logo">
    <div class="logo-divider"></div>
    <div class="header-title">Booking Admin — Availability Manager</div>
  </div>
  <div style="display: flex; gap: 12px; align-items: center;">
    <button onclick="testNotificationSystem()" class="btn-delete" style="border-color: var(--accent); color: var(--accent); white-space: nowrap; height: 38px; display: flex; align-items: center; gap: 6px;">
      🔔 Test Notification & Sound
    </button>
    <button onclick="submitAdminLogout()" class="btn-delete" style="border-color: var(--danger); color: var(--danger); white-space: nowrap; height: 38px; display: flex; align-items: center; gap: 6px;">
      🚪 Logout
    </button>
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
          <select id="propertySelect" onchange="window.onAdminPropertyChange()">
            ${propertyOptions}
          </select>
        </div>
      </div>
      <button type="button" id="addStayBtn" class="btn-delete ax-add" style="width:100%;">＋ Add a new stay</button>
    </div>

  <!-- Stay editor: everything the website shows for the selected stay -->
  <div class="card" id="stayEditorCard" style="grid-column: span 2;">
    <div class="card-title">Stay Details — what guests see on the website</div>
    <div id="stayEditor"><div class="empty-state">Loading…</div></div>
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
      <div class="form-row" style="margin-bottom: 12px;">
        <div>
          <label>New Promo Code</label>
          <input type="text" id="newPromoCode" placeholder="e.g. SUMMER20" style="text-transform: uppercase;" oninput="this.value = this.value.toUpperCase()">
        </div>
        <div>
          <label>Discount (%)</label>
          <input type="number" id="newPromoDiscount" placeholder="e.g. 20">
        </div>
      </div>
      <div class="form-row" style="align-items: flex-end; margin-bottom: 16px;">
        <div>
          <label>Active From</label>
          <input type="date" id="newPromoFrom">
        </div>
        <div>
          <label>Active To</label>
          <input type="date" id="newPromoTo">
        </div>
        <div>
          <button class="btn btn-primary" onclick="addPromo()" style="width: 100%; height: 42px; margin-top: 0;">⊕ Add</button>
        </div>
      </div>
      <div id="promoListContainer" class="periods-list">
        <!-- Rendered dynamically -->
      </div>
    </div>
    <div id="pricingExtras"></div>
    
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
    <div id="blockUnitsBlock"></div>
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

  <!-- Website settings -->
  <div class="card" style="grid-column: span 2;">
    <div class="card-title">Website Settings — contact number & background images</div>
    <div id="siteSettingsBody"><div class="empty-state">Loading…</div></div>
  </div>

  <!-- Security Audit Logs -->
  <div class="card" style="grid-column: span 2; border-top: 2px solid var(--accent); display: flex; flex-direction: column;">
    <div class="card-title">Security & Action Audit Logs</div>
    <div id="auditLogList" style="max-height: 350px; overflow-y: auto; display: flex; flex-direction: column; gap: 12px; padding-right: 6px;">
      <div class="empty-state">Loading audit logs...</div>
    </div>
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

</div> <!-- container END -->
</div> <!-- appContainer END -->

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
    if (!str) return '';
    const parts = str.split('-');
    if (parts.length === 3) {
      const [y, m, d] = parts.map(Number);
      return new Date(y, m - 1, d).toLocaleDateString('en-IN', {
        day: 'numeric', month: 'short', year: 'numeric'
      });
    }
    return str;
  }

  function getPropertyId() { return document.getElementById('propertySelect').value; }
  function esc(str) {
    return String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

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
      const wNumber = r.guestPhone.replace(/[^+\d]/g, '');
      const d1 = fmtDate(r.checkIn);
      const d2 = fmtDate(r.checkOut);
      
      const overlapBadge = r.hasOverlap ? '<div style="color:var(--danger); font-size:12px; font-weight:600; margin-bottom:8px;">⚠️ Overlaps with another pending request!</div>' : '';
      
      return \`
        <div class="request-card">
          <div class="request-header">
            <div>
              <span class="request-guest">\${esc(r.guestName)}</span>
              <span style="font-size:11px; color:var(--muted); margin-left:8px;">\${r.id || ''}</span>
            </div>
            <span class="request-prop">\${esc(r.homestayName)}</span>
          </div>
          \${overlapBadge}
          <div class="request-dates">\${d1} → \${d2}</div>
          <div class="request-details">\${r.unitsLabel ? '<strong style="color:var(--text)">' + esc(r.unitsLabel) + '</strong> · ' : ''}\${r.totalAmount ? '₹' + Number(r.totalAmount).toLocaleString('en-IN') + ' · ' : ''}\${r.adults} Adults, \${r.children} Children | Phone: \${esc(r.guestPhone)}</div>
          \${r.note ? \`<div class="request-note">"\${esc(r.note)}"</div>\` : ''}
          <div class="request-actions">
            <button class="btn-approve" id="approve-\${r.id}" onclick="approveRequest('\${r.id}', this)">Approve</button>
            <button class="btn-decline" id="decline-\${r.id}" onclick="declineRequest('\${r.id}', this)">Decline</button>
            <a class="btn-whatsapp" href="https://wa.me/\${wNumber}?text=\${encodeURIComponent('Hi ' + r.guestName + ', regarding your booking at ' + r.homestayName + '...')}" target="_blank">WhatsApp</a>
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
            \${p.note ? \`<div class="period-note">\${esc(p.note)}</div>\` : ''}
            \${Array.isArray(p.units) ? \`<div class="period-note" style="color:var(--text)">Rooms: \${esc(p.units.map(id => ((window.homestaysData.find(s => s.id === getPropertyId()) || {}).rooms || []).find(r => r.id === id)?.name || id).join(', '))}</div>\` : ''}
          </div>
          \${p.external ? '<span style="font-size:12px; color:var(--muted); font-style:italic;">External</span>' : (p.pending ? '<span style="font-size:12px; color:var(--muted); font-style:italic;">Pending request</span>' : \`<button class="btn-delete" onclick="removePeriod(\${p.originalIndex})">Remove</button>\`)}
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
      body: JSON.stringify({ from, to, note, units: window.getBlockUnits ? window.getBlockUnits() : 'whole' })
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
        currentPromos = JSON.parse(JSON.stringify(prop.promos)).map(p => ({
          ...p,
          from: p.from || '2026-01-01',
          to: p.to || '2030-12-31'
        }));
      } else if (prop && prop.promo && prop.promo.code) { // legacy fallback
        currentPromos = [{
          code: prop.promo.code,
          discount: prop.promo.discount,
          from: '2026-01-01',
          to: '2030-12-31'
        }];
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
          '<div style="font-weight: 600; color: var(--accent); font-size: 15px;">' + p.code + 
            '<span style="color: var(--success); font-size: 13px; margin-left: 8px;">' + p.discount + '% OFF</span>' +
          '</div>' +
          '<div style="font-size: 12px; color: var(--muted); margin-top: 4px;">Active: ' + p.from + ' to ' + p.to + '</div>' +
        '</div>' +
        '<button class="btn-delete" onclick="removePromo(' + index + ')">Remove</button>' +
      '</div>'
    ).join('');
  }

  function addPromo() {
    const codeInput = document.getElementById('newPromoCode');
    const discountInput = document.getElementById('newPromoDiscount');
    const fromInput = document.getElementById('newPromoFrom');
    const toInput = document.getElementById('newPromoTo');
    const code = codeInput.value.trim().toUpperCase();
    const discount = parseFloat(discountInput.value);
    const from = fromInput.value;
    const to = toInput.value;
    
    if (!code || isNaN(discount) || discount <= 0 || discount >= 100) {
      return showToast('Please enter a valid code and discount between 1-99%', 'error');
    }
    if (!from || !to) {
      return showToast('Please select the active period dates', 'error');
    }
    if (from > to) {
      return showToast('From date must be before or equal to To date', 'error');
    }
    if (currentPromos.find(p => p.code.toLowerCase() === code.toLowerCase())) {
      return showToast('Promo code already exists', 'error');
    }
    
    currentPromos.push({ code, discount, from, to });
    codeInput.value = '';
    discountInput.value = '';
    fromInput.value = '';
    toInput.value = '';
    renderPromos();
    updatePricing();
  }

  function removePromo(index) {
    currentPromos.splice(index, 1);
    renderPromos();
    updatePricing();
  }
  
  async function updatePricing() {
    const pid = getPropertyId();
    const weekday = parseFloat(document.getElementById('weekdayPrice').value);
    const weekend = parseFloat(document.getElementById('weekendPrice').value);
    
    if (isNaN(weekday) || isNaN(weekend)) {
      return showToast('Please enter valid numeric prices', 'error');
    }
    let extra = {};
    try { extra = window.collectExtraPricing ? window.collectExtraPricing() : {}; }
    catch (err) { return showToast(err.message, 'error'); }
    const pricingBody = { weekday, weekend, promos: currentPromos, ...extra };
    
    const res = await fetch('/api/homestay/' + pid + '/pricing', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(pricingBody)
    });
    
    if (res.ok) {
      showToast('Settings updated successfully!');
      if (window.afterPricingSaved) window.afterPricingSaved(pricingBody);
      // Update local data so it stays in sync
      const prop = window.homestaysData.find(p => p.id === pid);
      if (prop) {
        prop.pricing = { weekday, weekend };
        prop.promos = JSON.parse(JSON.stringify(currentPromos));
      }
    } else {
      const err = await res.json().catch(() => ({}));
      showToast(err.error || 'Failed to update settings', 'error');
    }
  }

  // Load everything on startup
  function loadAll() {
    loadPeriods();
    loadPricing();
    loadExternalIcal();
    loadPendingRequests();
    if (window.initAdminExtras) window.initAdminExtras();
    
    // Start background polling for new requests every 10 seconds only when tab is active
    setInterval(() => {
      if (document.visibilityState === 'visible') {
        pollForNewRequests();
      }
    }, 10000);
  }

  // --- Browser Notifications & Audio Alert System ---
  let knownRequestIds = new Set();
  let isFirstLoad = true;
  let audioContextUnlocked = false;

  // Request Notification permission automatically
  if ("Notification" in window && Notification.permission !== "granted" && Notification.permission !== "denied") {
    Notification.requestPermission();
  }

  function testNotificationSystem() {
    playBeep(1);
    if (!("Notification" in window)) {
      alert("This browser does not support desktop notifications.");
      return;
    }
    if (Notification.permission === "granted") {
      new Notification("Test Notification Works!", {
        body: "Your browser notifications are fully active.",
        icon: "/assets/logo/volg-logo-main.webp"
      });
    } else if (Notification.permission !== "denied") {
      Notification.requestPermission().then(permission => {
        if (permission === "granted") {
          new Notification("Test Notification Works!", {
            body: "Your browser notifications are fully active.",
            icon: "/assets/logo/volg-logo-main.webp"
          });
        }
      });
    } else {
      alert("Notifications are blocked. Please click the lock icon in the URL bar to allow notifications.");
    }
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

  // --- Security: MFA, Session & Audit Log Client Functions ---

  async function loadAuditLogs() {
    try {
      const res = await fetch('/api/admin/history');
      if (!res.ok) return;
      const logs = await res.json();
      const list = document.getElementById('auditLogList');
      if (!logs || !logs.length) {
        list.innerHTML = '<div class="empty-state">No security logs recorded yet.</div>';
        return;
      }
      // Sort descending (latest first)
      logs.sort((a,b) => b.timestamp.localeCompare(a.timestamp));
      list.innerHTML = logs.map(l => {
        const date = new Date(l.timestamp).toLocaleString('en-IN');
        let detailsStr = '';
        try {
          detailsStr = JSON.stringify(l.details);
        } catch (e) { detailsStr = l.details; }
        return '<div class="request-card" style="padding: 12px 16px; margin-bottom: 8px;">' +
                 '<div style="display: flex; justify-content: space-between; font-size: 11px; color: var(--muted); margin-bottom: 4px;">' +
                   '<span>' + date + '</span>' +
                   '<span>IP: ' + l.ip + '</span>' +
                 '</div>' +
                 '<div style="font-weight: 600; font-size: 13px; color: var(--accent); margin-bottom: 2px;">' +
                   l.action + ' (' + l.username + ')' +
                 '</div>' +
                 '<div style="font-size: 12px; color: var(--text); word-break: break-all; opacity: 0.85;">' +
                   detailsStr +
                 '</div>' +
               '</div>';
      }).join('');
    } catch (e) {
      console.error("Failed to load audit logs", e);
    }
  }

  async function submitAdminCredentials() {
    const username = document.getElementById('adminUserField').value.trim();
    const password = document.getElementById('adminPassField').value.trim();
    const errorEl = document.getElementById('loginErrorMsg');
    errorEl.style.display = 'none';

    if (!username || !password) {
      errorEl.textContent = 'Please fill out both fields.';
      errorEl.style.display = 'block';
      return;
    }

    try {
      const res = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      const rawText = await res.text();
      let data;
      try {
        data = JSON.parse(rawText);
      } catch (parseErr) {
        errorEl.textContent = 'HTTP ' + res.status + ' (' + res.url + '): ' + rawText.slice(0, 80);
        errorEl.style.display = 'block';
        return;
      }
      if (!res.ok) {
        errorEl.textContent = data.error || 'Authentication failed.';
        errorEl.style.display = 'block';
        return;
      }
      if (data.mfaRequired) {
        document.getElementById('loginCredentialsForm').style.display = 'none';
        document.getElementById('loginOtpForm').style.display = 'flex';
      } else {
        // Direct authentication without OTP
        document.getElementById('loginOverlay').style.display = 'none';
        document.getElementById('appContainer').style.display = 'block';
        document.getElementById('adminUserField').value = '';
        document.getElementById('adminPassField').value = '';
        loadAll();
        loadAuditLogs();
      }
    } catch (err) {
      errorEl.textContent = 'Error connecting to authorization service: ' + (err && err.message ? err.message : 'Unknown error');
      errorEl.style.display = 'block';
    }
  }

  async function submitMfaOtp() {
    const otp = document.getElementById('adminOtpField').value.trim();
    const errorEl = document.getElementById('otpErrorMsg');
    errorEl.style.display = 'none';

    if (!otp || otp.length !== 6) {
      errorEl.textContent = 'Please enter the 6-digit verification code.';
      errorEl.style.display = 'block';
      return;
    }

    try {
      const res = await fetch('/api/admin/verify-otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ otp })
      });
      const rawText = await res.text();
      let data;
      try {
        data = JSON.parse(rawText);
      } catch (parseErr) {
        errorEl.textContent = 'HTTP ' + res.status + ' (' + res.url + '): ' + rawText.slice(0, 80);
        errorEl.style.display = 'block';
        return;
      }
      if (!res.ok) {
        errorEl.textContent = data.error || 'Invalid verification code.';
        errorEl.style.display = 'block';
        return;
      }
      
      // Successfully authenticated!
      document.getElementById('loginOverlay').style.display = 'none';
      document.getElementById('appContainer').style.display = 'block';
      
      // Clear inputs
      document.getElementById('adminUserField').value = '';
      document.getElementById('adminPassField').value = '';
      document.getElementById('adminOtpField').value = '';
      
      // Load all admin modules
      loadAll();
      loadAuditLogs();
    } catch (err) {
      errorEl.textContent = 'Verification service error.';
      errorEl.style.display = 'block';
    }
  }

  function goBackToLogin() {
    document.getElementById('loginOtpForm').style.display = 'none';
    document.getElementById('loginCredentialsForm').style.display = 'flex';
    document.getElementById('adminOtpField').value = '';
  }

  async function submitAdminLogout() {
    await fetch('/api/admin/logout', { method: 'POST' });
    window.location.reload();
  }

  async function initSession() {
    try {
      const res = await fetch('/api/admin/check-session');
      const rawText = await res.text();
      let data;
      try {
        data = JSON.parse(rawText);
      } catch (parseErr) {
        errorEl.textContent = 'HTTP ' + res.status + ' (' + res.url + '): ' + rawText.slice(0, 80);
        errorEl.style.display = 'block';
        return;
      }
      if (data.authenticated) {
        document.getElementById('loginOverlay').style.display = 'none';
        document.getElementById('appContainer').style.display = 'block';
        loadAll();
        loadAuditLogs();
      } else {
        document.getElementById('appContainer').style.display = 'none';
        document.getElementById('loginOverlay').style.display = 'flex';
      }
    } catch (e) {
      document.getElementById('appContainer').style.display = 'none';
      document.getElementById('loginOverlay').style.display = 'flex';
    }
  }

  // Keybind Enter key on login inputs for convenience
  document.getElementById('adminUserField').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitAdminCredentials();
  });
  document.getElementById('adminPassField').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitAdminCredentials();
  });
  document.getElementById('adminOtpField').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitMfaOtp();
  });

  ${adminExtraJs}

  initSession();
</script>
</body>
</html>`);
});

// Serve static assets
app.use(express.static(DIST_DIR));
app.use(express.static(PUBLIC_DIR));

const ASSETS_DIR = path.join(ROOT_DIR, 'assets');
// NOTE: /data is intentionally NOT served as static to protect JSON files (#15)
app.use('/assets', express.static(ASSETS_DIR));

// Fallback for SPA routing
app.get(/.*/, (req, res) => {
  const distIndex = path.join(DIST_DIR, 'index.html');
  if (fs.existsSync(distIndex)) {
    return res.sendFile(distIndex);
  }
  return res.sendFile(path.join(ROOT_DIR, 'index.html'));
});

// ─────────────────────────────────────────────────────────────────────────────
//  Start Server
// ─────────────────────────────────────────────────────────────────────────────
// Photos are binary, so tell serverless-http to base64 them for Netlify.
export const handler = serverless(app, { binary: ['image/*'] });
export default app;

if (!process.env.NETLIFY && !process.env.AWS_LAMBDA_FUNCTION_NAME) {
  app.listen(PORT, () => {
    const adminUser = process.env.ADMIN_USER || 'admin';
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(' VOLGO HOMESTAY — Unified Server Running Locally');
    console.log(`\n  Public Website : http://localhost:${PORT}`);
    console.log(`  Admin Panel    : http://localhost:${PORT}/admin`);
    console.log(`\n  Login credentials for Admin:`);
    console.log(`    Username: ${adminUser}`);
    console.log(`    Password: ${process.env.ADMIN_PASS ? '***' : 'volgo123 (default)'}`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  });
}

