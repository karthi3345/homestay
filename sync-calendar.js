/**
 * sync-calendar.js
 *
 * Fetches iCal (.ics) feeds from all booking platforms (Airbnb, Booking.com,
 * Vrbo, etc.) and writes booked date ranges into data/homestays.json so that
 * the website calendar always shows live, up-to-date availability.
 *
 * Usage:
 *   npm run sync                  ← fetch now and update JSON
 *   (schedule this via Windows Task Scheduler or a cron job)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import ical from 'node-ical';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOMESTAYS_PATH = path.join(__dirname, 'data', 'homestays.json');

// ─────────────────────────────────────────────────────────────────────────────
//  HELPER: format Date → 'YYYY-MM-DD'
// ─────────────────────────────────────────────────────────────────────────────
function fmtDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// ─────────────────────────────────────────────────────────────────────────────
//  HELPER: expand a date range into individual date strings
//  (check-in inclusive, check-out exclusive — standard for homestay bookings)
// ─────────────────────────────────────────────────────────────────────────────
function expandRange(start, end) {
  const dates = [];
  const cur = new Date(start);
  cur.setHours(0, 0, 0, 0);
  const endMs = new Date(end);
  endMs.setHours(0, 0, 0, 0);

  while (cur < endMs) {
    dates.push(fmtDate(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return dates;
}

// ─────────────────────────────────────────────────────────────────────────────
//  HELPER: fetch & parse a single iCal URL → Set of 'YYYY-MM-DD' strings
// ─────────────────────────────────────────────────────────────────────────────
async function fetchIcalDates(url, label) {
  try {
    console.log(`  ↓ Fetching: ${label} ...`);
    const events = await ical.async.fromURL(url);
    const dates  = new Set();

    for (const event of Object.values(events)) {
      if (event.type !== 'VEVENT') continue;
      if (!event.start || !event.end) continue;

      // Skip events that are just status markers (Airbnb uses "Airbnb (Not available)")
      const summary = (event.summary || '').toLowerCase();
      if (summary === 'airbnb (not available)' || summary === 'not available') {
        // Still block these — they represent unavailable periods
      }

      const expanded = expandRange(event.start, event.end);
      expanded.forEach(d => dates.add(d));
    }

    console.log(`  ✓ ${label}: ${dates.size} blocked dates`);
    return dates;

  } catch (err) {
    console.error(`  ✗ Failed to fetch ${label}: ${err.message}`);
    return new Set();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  MAIN: merge all iCal sources → update homestays.json
// ─────────────────────────────────────────────────────────────────────────────
async function syncCalendars() {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(' VOLGO HOMESTAY — Calendar Sync');
  console.log(`  Syncing at: ${new Date().toLocaleString()}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  const homestays = JSON.parse(fs.readFileSync(HOMESTAYS_PATH, 'utf-8'));
  let anyChanged = false;

  for (const property of homestays) {
    console.log(`▶ Property: ${property.name} (${property.id})`);

    // ── icalUrls is an array of { label, url } objects ──────────────────────
    const icalSources = property.icalUrls || [];

    if (icalSources.length === 0) {
      console.log('  (No iCal URLs configured — skipping)\n');
      continue;
    }

    // Fetch all sources in parallel
    const allDatesToBlock = new Set();
    const results = await Promise.all(
      icalSources.map(src => fetchIcalDates(src.url, src.label))
    );

    results.forEach(dateSet => {
      dateSet.forEach(d => allDatesToBlock.add(d));
    });

    // Filter out past dates (no need to store those)
    const today = fmtDate(new Date());
    const futureBlockedDates = Array.from(allDatesToBlock)
      .filter(d => d >= today)
      .sort();

    // Only write if changed
    const prev = JSON.stringify(property.bookedDates || []);
    const next  = JSON.stringify(futureBlockedDates);

    if (prev !== next) {
      property.bookedDates = futureBlockedDates;
      anyChanged = true;
      console.log(`  ✔ Updated: ${futureBlockedDates.length} blocked dates written`);
    } else {
      console.log(`  ● No change: ${futureBlockedDates.length} blocked dates (already up to date)`);
    }

    console.log();
  }

  if (anyChanged) {
    fs.writeFileSync(HOMESTAYS_PATH, JSON.stringify(homestays, null, 2), 'utf-8');
    console.log('✅ homestays.json updated successfully.\n');
  } else {
    console.log('✅ No changes needed. All calendars are already in sync.\n');
  }
}

syncCalendars().catch(err => {
  console.error('Sync failed:', err);
  process.exit(1);
});
