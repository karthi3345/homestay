/**
 * generate-ical.js
 *
 * Reads confirmed direct bookings from data/direct-bookings.json and generates
 * a standard iCal (.ics) file for each property.
 *
 * The generated .ics file is placed in the /public folder so it is publicly
 * accessible at: https://yourwebsite.com/{propertyId}.ics
 *
 * You give this URL to Airbnb, Booking.com, Vrbo etc. so they can import your
 * direct bookings and block those dates on their platforms automatically.
 *
 * Usage:
 *   npm run generate-ical
 *
 * Then after deploying, give the following URL to each platform:
 *   https://yourwebsite.com/volgo-alpine-retreat.ics
 */

import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const BOOKINGS   = path.join(__dirname, 'data', 'direct-bookings.json');
const HOMESTAYS  = path.join(__dirname, 'data', 'homestays.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

// ─────────────────────────────────────────────────────────────────────────────
//  HELPER: format Date → iCal date string 'YYYYMMDD'
// ─────────────────────────────────────────────────────────────────────────────
function icalDate(dateStr) {
  return dateStr.replace(/-/g, ''); // '2026-07-10' → '20260710'
}

// ─────────────────────────────────────────────────────────────────────────────
//  HELPER: current timestamp in iCal format 'YYYYMMDDTHHMMSSZ'
// ─────────────────────────────────────────────────────────────────────────────
function icalNow() {
  return new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
}

// ─────────────────────────────────────────────────────────────────────────────
//  HELPER: fold long lines (iCal RFC 5545 requires max 75 chars per line)
// ─────────────────────────────────────────────────────────────────────────────
function foldLine(line) {
  const MAX = 75;
  if (line.length <= MAX) return line;
  let result = '';
  while (line.length > MAX) {
    result += line.substring(0, MAX) + '\r\n ';
    line = line.substring(MAX);
  }
  return result + line;
}

// ─────────────────────────────────────────────────────────────────────────────
//  BUILD: generate the .ics content string for a property
// ─────────────────────────────────────────────────────────────────────────────
function buildIcal(property, blockedPeriods) {
  const now = icalNow();
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:-//Volgo Homestay//${property.name}//EN`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${property.name} – Availability`,
    `X-WR-CALDESC:Blocked dates for ${property.name}`,
    'X-WR-TIMEZONE:Asia/Kolkata',
  ];

  blockedPeriods.forEach((period, i) => {
    lines.push('BEGIN:VEVENT');
    lines.push(`UID:blocked-${i + 1}-${property.id}@volgohomestay`);
    lines.push(`DTSTAMP:${now}`);
    lines.push(`DTSTART;VALUE=DATE:${icalDate(period.from)}`);
    lines.push(`DTEND;VALUE=DATE:${icalDate(period.to)}`);
    lines.push('SUMMARY:Not Available');
    lines.push('STATUS:CONFIRMED');
    lines.push('TRANSP:OPAQUE');
    lines.push('END:VEVENT');
  });

  lines.push('END:VCALENDAR');
  return lines.map(foldLine).join('\r\n') + '\r\n';
}

// ─────────────────────────────────────────────────────────────────────────────
//  MAIN
// ─────────────────────────────────────────────────────────────────────────────
function generateIcalFiles() {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(' VOLGO HOMESTAY — iCal Export Generator');
  console.log(`  Generated at: ${new Date().toLocaleString()}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  if (!fs.existsSync(PUBLIC_DIR)) fs.mkdirSync(PUBLIC_DIR, { recursive: true });

  const allProperties = JSON.parse(fs.readFileSync(HOMESTAYS, 'utf-8'));
  const allBlocked    = JSON.parse(fs.readFileSync(BOOKINGS,  'utf-8'));

  for (const property of allProperties) {
    const record  = allBlocked.find(b => b.propertyId === property.id);
    const periods = record ? record.blockedPeriods : [];

    const icsContent = buildIcal(property, periods);
    const filename   = `${property.id}.ics`;
    const outputPath = path.join(PUBLIC_DIR, filename);

    fs.writeFileSync(outputPath, icsContent, 'utf-8');

    console.log(`✅  ${property.name}`);
    console.log(`    Blocked periods : ${periods.length}`);
    console.log(`    Your iCal URL   : https://YOUR_DOMAIN/${filename}`);
    console.log(`    → Paste this URL into Airbnb, Booking.com, Vrbo\n`);
  }
}

generateIcalFiles();
