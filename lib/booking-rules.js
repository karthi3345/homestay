/**
 * booking-rules.js
 *
 * Shared booking and pricing rules, used by BOTH the website (app.js) and the
 * server (netlify/functions/api.js) so the price a guest sees is the price the
 * server checks.
 *
 * Dates are plain 'YYYY-MM-DD' strings. A "night" is named by the date it starts
 * on: a stay from 2026-12-04 to 2026-12-06 covers the nights of Dec 4 and Dec 5.
 *
 * A booking "selection" is either:
 *   { type: 'whole' }                       – the entire stay / villa
 *   { type: 'rooms', rooms: ['r1', 'r2'] }  – one or more individual rooms
 *
 * Blocked periods may carry `units`: 'whole' (default) or an array of room ids.
 */

export const WEEKEND_DAYS = [5, 6]; // Friday and Saturday nights

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isDateStr(s) {
  return typeof s === 'string' && DATE_RE.test(s);
}

function toUtc(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

function fromUtc(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

export function addDays(dateStr, n) {
  return fromUtc(toUtc(dateStr) + n * 86400000);
}

/** Every night from `from` (inclusive) to `to` (exclusive). */
export function eachNight(from, to) {
  const out = [];
  if (!isDateStr(from) || !isDateStr(to) || from >= to) return out;
  for (let ms = toUtc(from), end = toUtc(to); ms < end; ms += 86400000) out.push(fromUtc(ms));
  return out;
}

export function isWeekendNight(dateStr) {
  return WEEKEND_DAYS.includes(new Date(toUtc(dateStr)).getUTCDay());
}

/** True when the stay can be booked room by room (e.g. the 3BHK villa). */
export function hasRooms(stay) {
  return stay?.bookingMode === 'rooms' && Array.isArray(stay.rooms) && stay.rooms.length > 0;
}

export function roomsAllowedOnWeekends(stay) {
  return Boolean(stay?.roomBooking?.allowOnWeekends);
}

/** Cleans up whatever the browser sent into a valid selection for this stay. */
export function normalizeSelection(stay, selection) {
  if (!hasRooms(stay)) return { type: 'whole' };
  if (!selection || selection.type !== 'rooms') return { type: 'whole' };
  const valid = new Set(stay.rooms.map(r => r.id));
  const rooms = [...new Set((selection.rooms || []).filter(id => valid.has(id)))];
  if (rooms.length === 0) return { type: 'whole' };
  return { type: 'rooms', rooms };
}

/** The `units` value stored on a blocked period for this selection. */
export function selectionToUnits(selection) {
  return selection?.type === 'rooms' ? [...selection.rooms] : 'whole';
}

export function unitsToSelection(units) {
  return Array.isArray(units) && units.length ? { type: 'rooms', rooms: units } : { type: 'whole' };
}

/**
 * Does an existing period block this selection?
 * The whole villa clashes with any room; rooms clash only with the same room.
 */
export function periodBlocksSelection(period, selection) {
  const units = period?.units;
  if (!Array.isArray(units) || units.length === 0) return true; // whole-place booking
  if (!selection || selection.type !== 'rooms') return true;   // asking for the whole place
  return selection.rooms.some(id => units.includes(id));
}

/**
 * Nights that cannot be booked for this selection: other bookings that clash,
 * plus Friday/Saturday nights when booking individual rooms (unless the admin
 * has switched room bookings on for weekends).
 */
export function blockedNightsFor(stay, periods, selection, { from, to } = {}) {
  const sel = normalizeSelection(stay, selection);
  const blocked = new Set();
  (periods || []).forEach(p => {
    if (!isDateStr(p.from) || !isDateStr(p.to)) return;
    if (!periodBlocksSelection(p, sel)) return;
    eachNight(p.from, p.to).forEach(n => blocked.add(n));
  });
  if (sel.type === 'rooms' && !roomsAllowedOnWeekends(stay) && from && to) {
    eachNight(from, to).forEach(n => { if (isWeekendNight(n)) blocked.add(n); });
  }
  return blocked;
}

/** Weekend nights (in a range) that rooms cannot be booked on. */
export function weekendRuleApplies(stay, selection) {
  const sel = normalizeSelection(stay, selection);
  return sel.type === 'rooms' && !roomsAllowedOnWeekends(stay);
}

/** The price period (season) a night falls in, if any. `to` is the last night included. */
export function seasonFor(stay, night) {
  return (stay?.seasons || []).find(s => isDateStr(s.from) && isDateStr(s.to) && night >= s.from && night <= s.to) || null;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Price of a single night for this selection. */
export function nightPrice(stay, selection, night) {
  const sel = normalizeSelection(stay, selection);
  const weekend = isWeekendNight(night);
  const season = seasonFor(stay, night);

  if (sel.type === 'rooms') {
    return sel.rooms.reduce((sum, id) => {
      const room = stay.rooms.find(r => r.id === id);
      const seasonal = season?.roomPrices?.[id];
      const base = seasonal || room?.price || {};
      const wd = num(base.weekday);
      const we = num(base.weekend) || wd;
      return sum + (weekend ? we : wd);
    }, 0);
  }

  const base = season?.pricing || stay?.pricing || {};
  const wd = num(base.weekday);
  const we = num(base.weekend) || wd;
  return weekend ? we : wd;
}

/** The lowest regular nightly price, for "from ₹…" labels. */
export function fromPrice(stay) {
  const prices = [num(stay?.pricing?.weekday), num(stay?.pricing?.weekend)];
  if (hasRooms(stay)) stay.rooms.forEach(r => prices.push(num(r.price?.weekday)));
  const valid = prices.filter(Boolean);
  return valid.length ? Math.min(...valid) : 0;
}

export function findPromo(stay, code, checkIn) {
  if (!code) return { promo: null, invalid: false };
  const entered = String(code).trim().toLowerCase();
  if (!entered) return { promo: null, invalid: false };
  const promo = (stay?.promos || []).find(p => String(p.code).toLowerCase() === entered);
  if (!promo || !(promo.discount > 0)) return { promo: null, invalid: true };
  const active = (!promo.from || checkIn >= promo.from) && (!promo.to || checkIn <= promo.to);
  return active ? { promo, invalid: false } : { promo: null, invalid: true };
}

/**
 * Full price quote. Lines group nights that share a label and price, e.g.
 * "2 weeknights × ₹13,000" and "1 weekend night × ₹15,000".
 */
export function quote(stay, selection, from, to, promoCode) {
  const sel = normalizeSelection(stay, selection);
  const nights = eachNight(from, to);
  const lines = [];
  let subtotal = 0;

  nights.forEach(night => {
    const amount = nightPrice(stay, sel, night);
    const weekend = isWeekendNight(night);
    const season = seasonFor(stay, night);
    const label = `${season ? season.name + ' · ' : ''}${weekend ? 'Weekend night' : 'Weeknight'}`;
    subtotal += amount;
    const line = lines.find(l => l.label === label && l.unitPrice === amount);
    if (line) { line.nights += 1; line.amount += amount; }
    else lines.push({ label, weekend, unitPrice: amount, nights: 1, amount });
  });

  const { promo, invalid } = findPromo(stay, promoCode, from);
  const discount = promo ? Math.round(subtotal * (promo.discount / 100)) : 0;

  return {
    selection: sel,
    nights: nights.length,
    lines,
    subtotal,
    promo: promo ? { code: promo.code, discount: promo.discount } : null,
    invalidPromo: invalid,
    discount,
    total: Math.round(subtotal - discount)
  };
}

/** Returns an error message, or null if the booking is allowed. */
export function validateBooking(stay, periods, selection, from, to) {
  if (!isDateStr(from) || !isDateStr(to) || from >= to) return 'Please choose valid check-in and check-out dates.';
  const sel = normalizeSelection(stay, selection);
  const nights = eachNight(from, to);

  if (weekendRuleApplies(stay, sel) && nights.some(isWeekendNight)) {
    return 'On Friday and Saturday nights only the whole villa can be booked. Please choose the whole villa or different dates.';
  }
  const blocked = blockedNightsFor(stay, periods, sel);
  if (nights.some(n => blocked.has(n))) {
    return 'Sorry, these dates have just been booked. Please choose different dates.';
  }
  if (nights.some(n => nightPrice(stay, sel, n) <= 0)) {
    return 'Prices for these dates are not set yet. Please contact us to book.';
  }
  return null;
}

/** Human label for a selection, e.g. "Whole villa" or "Family Bedroom + Double Bedroom". */
export function selectionLabel(stay, selection) {
  const sel = normalizeSelection(stay, selection);
  if (sel.type === 'whole') return hasRooms(stay) ? (stay.wholeLabel || 'Whole villa') : 'Entire stay';
  return sel.rooms.map(id => stay.rooms.find(r => r.id === id)?.name || id).join(' + ');
}

/** Guests allowed for this selection. */
export function capacityFor(stay, selection) {
  const sel = normalizeSelection(stay, selection);
  if (sel.type === 'rooms') {
    return sel.rooms.reduce((s, id) => s + (Number(stay.rooms.find(r => r.id === id)?.capacity) || 0), 0) || stay.capacity || 2;
  }
  return Number(stay?.capacity) || 2;
}

/* ── Map helpers ───────────────────────────────────────────────────────── */

export function distanceMeters(a, b) {
  const R = 6371000;
  const toRad = d => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * Walking minutes: the admin's own figure if given, otherwise an estimate from
 * straight-line distance × 1.3 (streets aren't straight) at 80 m per minute.
 */
export function walkingMinutes(from, place) {
  if (Number(place?.walkMinutes) > 0) return Math.round(Number(place.walkMinutes));
  if (!from || !place || !Number.isFinite(place.lat) || !Number.isFinite(place.lng)) return null;
  return Math.max(1, Math.ceil((distanceMeters(from, place) * 1.3) / 80));
}

/* ── Festive themes ────────────────────────────────────────────────────── */

export const FESTIVE_THEMES = ['christmas', 'diwali', 'pongal', 'newyear'];

/** The scheduled festive theme active on `today` (a 'YYYY-MM-DD' string), if any. */
export function activeFestiveTheme(schedule, today) {
  const hit = (schedule || []).find(t =>
    t && t.enabled !== false && FESTIVE_THEMES.includes(t.theme) &&
    isDateStr(t.from) && isDateStr(t.to) && today >= t.from && today <= t.to);
  return hit ? hit.theme : null;
}
