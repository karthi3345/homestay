/**
 * admin-extra.js — inlined into the /admin page by netlify/functions/api.js.
 *
 * Lets the team change everything the website shows without code:
 *   • Stay editor: name, overview, photos (upload), amenities, map pin and
 *     nearby beaches, rooms for room-by-room stays, show/hide, add, delete.
 *   • Pricing extras: room prices, weekend switch, price periods (seasons).
 *   • Manual blocks for single rooms.
 *   • Website settings: contact number and scheduled festive themes.
 *
 * Uses globals from the main admin script: getPropertyId(), showToast(),
 * loadPeriods(), loadPricing(), window.homestaysData.
 */
(function () {
  'use strict';

  /* ── tiny DOM helper (no innerHTML with user data) ─────────────────── */
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    Object.entries(attrs || {}).forEach(([k, v]) => {
      if (v === undefined || v === null || v === false) return;
      if (k === 'class') el.className = v;
      else if (k === 'style') el.style.cssText = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'value') el.value = v;
      else if (k === 'checked') el.checked = Boolean(v);
      else el.setAttribute(k, v === true ? '' : v);
    });
    children.flat().forEach(c => {
      if (c === null || c === undefined || c === false) return;
      el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
    });
    return el;
  }
  const field = (label, input, hint) =>
    h('div', { class: 'ax-field' }, h('label', {}, label), input, hint ? h('div', { class: 'ax-hint' }, hint) : null);
  const text = (value, attrs = {}) => h('input', { type: 'text', value: value ?? '', ...attrs });
  const numberInput = (value, attrs = {}) => h('input', { type: 'number', value: value ?? '', ...attrs });
  const area = (value, rows = 4, attrs = {}) => { const t = h('textarea', { rows, ...attrs }); t.value = value ?? ''; return t; };
  const lines = (arr) => (arr || []).join('\n');
  const splitLines = (str) => String(str || '').split('\n').map(s => s.trim()).filter(Boolean);
  const clone = (o) => JSON.parse(JSON.stringify(o ?? null));
  const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };

  async function api(url, method = 'GET', body) {
    const res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined
    });
    let data = {};
    try { data = await res.json(); } catch (_) {}
    if (!res.ok) throw Object.assign(new Error(data.error || 'Request failed'), { status: res.status });
    return data;
  }

  const stays = () => window.homestaysData || [];
  const currentStay = () => stays().find(s => s.id === getPropertyId());

  function refreshPropertySelect(selectId) {
    const sel = document.getElementById('propertySelect');
    sel.innerHTML = '';
    stays().forEach(s => sel.appendChild(h('option', { value: s.id }, s.name + (s.published === false ? ' (hidden)' : ''))));
    if (selectId) sel.value = selectId;
  }

  async function reloadStays(selectId) {
    window.homestaysData = await api('/api/admin/homestays');
    refreshPropertySelect(selectId || getPropertyId());
  }

  /* ── Common icon choices for amenities ─────────────────────────────── */
  const ICONS = [
    ['wifi', 'Wi-Fi'], ['ac_unit', 'Air conditioning'], ['restaurant', 'Kitchen'], ['local_laundry_service', 'Washing machine'],
    ['battery_charging_full', 'Power backup'], ['tv', 'TV'], ['bed', 'Bed'], ['bathtub', 'Bathroom'], ['shower', 'Hot water'],
    ['balcony', 'Balcony'], ['deck', 'Terrace / sit-out'], ['local_parking', 'Parking'], ['pool', 'Pool'], ['coffee_maker', 'Kettle / coffee'],
    ['water_drop', 'Drinking water'], ['soap', 'Toiletries'], ['dry', 'Towels'], ['iron', 'Iron'], ['air', 'Hair dryer'], ['lock', 'Safe'],
    ['videocam', 'CCTV'], ['medical_services', 'First aid'], ['support_agent', 'Caretaker'], ['family_restroom', 'Family friendly'],
    ['pets', 'Pets allowed'], ['beach_access', 'Near beach'], ['yard', 'Garden'], ['kitchen', 'Fridge'], ['microwave', 'Microwave'],
    ['check_circle', 'Other']
  ];
  function iconSelect(value) {
    const s = h('select', { class: 'ax-icon-select' });
    ICONS.forEach(([v, l]) => s.appendChild(h('option', { value: v }, l)));
    if (value && !ICONS.some(([v]) => v === value)) s.appendChild(h('option', { value }, value));
    s.value = value || 'check_circle';
    return s;
  }

  /* ── Photo upload: shrink to WebP in the browser, then send ─────────── */
  async function shrinkImage(file) {
    const MAX = 1600;
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, MAX / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise(r => canvas.toBlob(r, 'image/webp', 0.82));
    return blob && blob.type === 'image/webp' ? blob : file; // old Safari can't make WebP
  }
  async function uploadImage(file) {
    const body = await shrinkImage(file);
    const res = await fetch('/api/admin/images', { method: 'POST', headers: { 'Content-Type': body.type || 'image/jpeg' }, body });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Upload failed');
    return data.url;
  }
  const imgSrc = (p) => (/^(https?:)?\//.test(p) ? p : '/' + p);

  /* ══════════════════════════════════════════════════════════════════════
     STAY EDITOR
     ══════════════════════════════════════════════════════════════════════ */
  let draft = null; // working copy of the stay being edited

  function renderEditor() {
    const host = document.getElementById('stayEditor');
    if (!host) return;
    const stay = currentStay();
    host.innerHTML = '';
    if (!stay) { host.appendChild(h('div', { class: 'empty-state' }, 'Select a stay above.')); return; }
    draft = clone(stay);
    draft.imageCategories ||= [];
    draft.amenityCategories ||= [];
    draft.nearbyPlaces ||= [];
    draft.rooms ||= [];
    draft.coordinates ||= { lat: 11.9341, lng: 79.8306 };

    const f = {}; // inputs we read back on save

    // 1. Basics
    f.name = text(draft.name);
    f.published = h('input', { type: 'checkbox', checked: draft.published !== false });
    f.tagline = text(draft.tagline);
    f.areaName = text(draft.areaName, { placeholder: 'e.g. Heritage Town' });
    f.city = text(draft.city || 'Pondicherry');
    f.area = text(draft.area, { placeholder: 'e.g. 1,200 sq ft' });
    f.capacity = numberInput(draft.capacity, { min: 1 });
    f.bedrooms = numberInput(draft.bedrooms, { min: 0 });
    f.bathrooms = numberInput(draft.bathrooms, { min: 0, step: 0.5 });
    f.location = text(draft.location, { placeholder: 'Street address shown to guests' });
    f.phone = text(draft.phone, { placeholder: 'Leave blank to use the website number' });
    f.whatsapp = text(draft.whatsapp, { placeholder: 'Leave blank to use the website number' });
    f.email = text(draft.email, { placeholder: 'Leave blank to use the website email' });

    const basics = section('Basics', true,
      h('label', { class: 'ax-switch' }, f.published, h('span', {}, 'Show this stay on the website')),
      h('div', { class: 'ax-grid2' }, field('Stay name', f.name), field('Short tagline', f.tagline)),
      h('div', { class: 'ax-grid3' }, field('Area name', f.areaName, 'Shown on the map and booking list'), field('City', f.city), field('Size', f.area)),
      h('div', { class: 'ax-grid3' }, field('Max guests', f.capacity), field('Bedrooms', f.bedrooms), field('Bathrooms', f.bathrooms)),
      field('Address', f.location),
      h('div', { class: 'ax-grid3' }, field('Phone', f.phone), field('WhatsApp', f.whatsapp), field('Email', f.email))
    );

    // 2. Overview
    f.description = area(draft.description, 6, { placeholder: 'What guests should know. Blank lines start a new paragraph.' });
    f.houseRules = area(lines(draft.houseRules), 5, { placeholder: 'One rule per line, e.g. Quiet hours after 9:00 PM' });
    f.hostName = text(draft.hostName);
    f.hostBio = area(draft.hostBio, 3);
    const overview = section('Overview & house rules', false,
      field('Description', f.description),
      field('House rules (shown on the Contact tab)', f.houseRules),
      h('div', { class: 'ax-grid2' }, field('Host name', f.hostName), field('About the host', f.hostBio))
    );

    // 3. Photos
    const photosBox = h('div');
    f.thumbnail = text(draft.thumbnail, { placeholder: 'Cover photo (used on the map and lists)' });
    const renderPhotos = () => {
      photosBox.innerHTML = '';
      draft.imageCategories.forEach((cat, ci) => {
        const nameInput = text(cat.category, { oninput: e => { cat.category = e.target.value; } });
        const grid = h('div', { class: 'ax-photo-grid' });
        cat.images.forEach((img, ii) => {
          grid.appendChild(h('div', { class: 'ax-photo' + (draft.thumbnail === img ? ' is-cover' : '') },
            h('img', { src: imgSrc(img), alt: '', loading: 'lazy' }),
            h('div', { class: 'ax-photo-actions' },
              h('button', { type: 'button', title: 'Move left', onclick: () => { if (ii > 0) { [cat.images[ii - 1], cat.images[ii]] = [cat.images[ii], cat.images[ii - 1]]; renderPhotos(); } } }, '◀'),
              h('button', { type: 'button', title: 'Use as cover photo', onclick: () => { draft.thumbnail = img; f.thumbnail.value = img; renderPhotos(); } }, '★'),
              h('button', { type: 'button', title: 'Remove photo', onclick: () => { cat.images.splice(ii, 1); renderPhotos(); } }, '✕'))));
        });
        const fileInput = h('input', { type: 'file', accept: 'image/*', multiple: true, style: 'display:none' });
        fileInput.addEventListener('change', async () => {
          const files = [...fileInput.files];
          if (!files.length) return;
          showToast(`Uploading ${files.length} photo${files.length > 1 ? 's' : ''}…`);
          for (const file of files) {
            try { cat.images.push(await uploadImage(file)); }
            catch (err) { showToast(err.message, 'error'); }
          }
          if (!draft.thumbnail && cat.images[0]) { draft.thumbnail = cat.images[0]; f.thumbnail.value = cat.images[0]; }
          renderPhotos();
          showToast('Photos added — remember to Save');
        });
        photosBox.appendChild(h('div', { class: 'ax-photo-cat' },
          h('div', { class: 'ax-row' },
            field('Photo group', nameInput),
            h('button', { type: 'button', class: 'btn-delete', onclick: () => fileInput.click() }, '⤒ Upload photos'),
            h('button', { type: 'button', class: 'btn-delete', onclick: () => {
              const url = prompt('Paste a photo link (https://…)');
              if (url) { cat.images.push(url.trim()); renderPhotos(); }
            } }, '🔗 Add link'),
            h('button', { type: 'button', class: 'btn-delete', onclick: () => {
              if (!cat.images.length || confirm(`Remove the "${cat.category}" group and its ${cat.images.length} photos?`)) { draft.imageCategories.splice(ci, 1); renderPhotos(); }
            } }, 'Remove group')),
          fileInput,
          cat.images.length ? grid : h('div', { class: 'ax-hint' }, 'No photos yet.')));
      });
      photosBox.appendChild(h('button', { type: 'button', class: 'btn-delete ax-add', onclick: () => {
        draft.imageCategories.push({ category: 'New group', images: [] }); renderPhotos();
      } }, '＋ Add photo group (e.g. Bedroom 1)'));
    };
    renderPhotos();
    const photos = section('Gallery photos', false,
      h('div', { class: 'ax-hint', style: 'margin-bottom:12px' }, 'Photos are shrunk automatically before upload. ★ sets the cover photo shown on the map.'),
      field('Cover photo', f.thumbnail), photosBox);

    // 4. Amenities
    const amenBox = h('div');
    const renderAmenities = () => {
      amenBox.innerHTML = '';
      draft.amenityCategories.forEach((cat, ci) => {
        const items = h('div', { class: 'ax-list' });
        cat.items.forEach((it, ii) => {
          const sel = iconSelect(it.icon); sel.addEventListener('change', e => { it.icon = e.target.value; });
          items.appendChild(h('div', { class: 'ax-row' },
            text(it.name, { oninput: e => { it.name = e.target.value; } }), sel,
            h('button', { type: 'button', class: 'btn-delete', onclick: () => { cat.items.splice(ii, 1); renderAmenities(); } }, '✕')));
        });
        amenBox.appendChild(h('div', { class: 'ax-photo-cat' },
          h('div', { class: 'ax-row' },
            field('Group', text(cat.category, { oninput: e => { cat.category = e.target.value; } })),
            h('button', { type: 'button', class: 'btn-delete', onclick: () => { cat.items.push({ name: '', icon: 'check_circle' }); renderAmenities(); } }, '＋ Item'),
            h('button', { type: 'button', class: 'btn-delete', onclick: () => { draft.amenityCategories.splice(ci, 1); renderAmenities(); } }, 'Remove group')),
          items));
      });
      amenBox.appendChild(h('button', { type: 'button', class: 'btn-delete ax-add', onclick: () => {
        draft.amenityCategories.push({ category: 'New group', items: [{ name: '', icon: 'check_circle' }] }); renderAmenities();
      } }, '＋ Add amenity group'));
    };
    renderAmenities();
    const amenities = section('Amenities', false, amenBox);

    // 5. Map pin & nearby places
    f.coords = text(`${draft.coordinates.lat}, ${draft.coordinates.lng}`, { placeholder: '11.9348, 79.8298' });
    const placesBox = h('div');
    const renderPlaces = () => {
      placesBox.innerHTML = '';
      draft.nearbyPlaces.forEach((pl, i) => {
        const type = h('select', { onchange: e => { pl.type = e.target.value; } },
          h('option', { value: 'beach' }, 'Beach'), h('option', { value: 'landmark' }, 'Landmark'),
          h('option', { value: 'food' }, 'Food & café'), h('option', { value: 'other' }, 'Other'));
        type.value = pl.type || 'beach';
        placesBox.appendChild(h('div', { class: 'ax-row ax-place' },
          text(pl.name, { placeholder: 'Name, e.g. Rock Beach', oninput: e => { pl.name = e.target.value; } }),
          type,
          text(Number.isFinite(pl.lat) ? `${pl.lat}, ${pl.lng}` : '', { placeholder: 'lat, lng', oninput: e => {
            const m = e.target.value.match(/(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/);
            if (m) { pl.lat = parseFloat(m[1]); pl.lng = parseFloat(m[2]); }
          } }),
          numberInput(pl.walkMinutes, { placeholder: 'Walk min (auto)', min: 1, title: 'Leave blank to estimate from distance', oninput: e => { pl.walkMinutes = e.target.value ? parseInt(e.target.value, 10) : null; } }),
          h('button', { type: 'button', class: 'btn-delete', onclick: () => { draft.nearbyPlaces.splice(i, 1); renderPlaces(); } }, '✕')));
      });
      placesBox.appendChild(h('button', { type: 'button', class: 'btn-delete ax-add', onclick: () => {
        draft.nearbyPlaces.push({ name: '', type: 'beach', lat: NaN, lng: NaN, walkMinutes: null }); renderPlaces();
      } }, '＋ Add nearby place'));
    };
    renderPlaces();
    const mapSec = section('Map pin & nearby places', false,
      field('Stay location (latitude, longitude)', f.coords, 'In Google Maps, right-click the building and click the numbers at the top of the menu to copy them, then paste here.'),
      h('div', { class: 'ax-hint', style: 'margin:16px 0 8px' }, 'Nearby beaches and places get a dotted walking line on the map. Walking time is estimated from distance unless you type your own.'),
      placesBox);

    // 6. Rooms (for stays like the 3BHK villa)
    f.bookingMode = h('select', {},
      h('option', { value: 'whole' }, 'Whole stay only'),
      h('option', { value: 'rooms' }, 'Whole villa OR individual rooms'));
    f.bookingMode.value = draft.bookingMode === 'rooms' ? 'rooms' : 'whole';
    f.wholeLabel = text(draft.wholeLabel || 'Whole villa');
    f.layoutDetails = area(lines(draft.layoutDetails), 4, { placeholder: 'One per line, e.g. Ground floor: bedroom with attached bathroom' });
    f.guestInstructions = area(lines(draft.guestInstructions), 4, { placeholder: 'One per line, shown to guests who book single rooms' });
    const roomsBox = h('div');
    const renderRooms = () => {
      roomsBox.innerHTML = '';
      draft.rooms.forEach((r, i) => {
        roomsBox.appendChild(h('div', { class: 'ax-row ax-room' },
          text(r.name, { placeholder: 'Room name', oninput: e => { r.name = e.target.value; } }),
          text(r.description, { placeholder: 'Short description (floor, bed, bathroom)', oninput: e => { r.description = e.target.value; } }),
          numberInput(r.capacity, { placeholder: 'Sleeps', min: 1, oninput: e => { r.capacity = parseInt(e.target.value, 10) || 1; } }),
          h('button', { type: 'button', class: 'btn-delete', onclick: () => { draft.rooms.splice(i, 1); renderRooms(); } }, '✕')));
      });
      roomsBox.appendChild(h('button', { type: 'button', class: 'btn-delete ax-add', onclick: () => {
        draft.rooms.push({ id: 'room-' + Math.random().toString(36).slice(2, 8), name: '', description: '', capacity: 2 }); renderRooms();
      } }, '＋ Add room'));
    };
    renderRooms();
    const roomsSec = section('Rooms & villa details', false,
      h('div', { class: 'ax-grid2' }, field('How guests can book', f.bookingMode), field('Name for booking everything', f.wholeLabel)),
      h('div', { class: 'ax-hint', style: 'margin:8px 0' }, 'Room prices and the Friday/Saturday switch are in Pricing Settings after saving.'),
      roomsBox,
      field('Villa layout (shown on the Overview tab)', f.layoutDetails),
      field('Instructions for guests booking single rooms', f.guestInstructions));

    // Save / delete
    const saveBtn = h('button', { type: 'button', class: 'btn btn-primary', onclick: () => saveStay(f, saveBtn) }, '💾  Save stay');
    const delBtn = h('button', { type: 'button', class: 'btn-delete', style: 'margin-top:12px; width:100%', onclick: () => deleteStay() }, 'Delete this stay');

    host.append(basics, overview, photos, amenities, mapSec, roomsSec, saveBtn, delBtn);
  }

  function section(title, open, ...children) {
    return h('details', { class: 'ax-section', open: open || undefined }, h('summary', {}, title), h('div', { class: 'ax-section-body' }, ...children));
  }

  function collectStay(f) {
    const m = f.coords.value.match(/(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/);
    if (!m) throw new Error('Please enter the stay location as "latitude, longitude".');
    const places = draft.nearbyPlaces.filter(p => p.name.trim());
    const badPlace = places.find(p => !Number.isFinite(p.lat) || !Number.isFinite(p.lng));
    if (badPlace) throw new Error(`Please add coordinates for "${badPlace.name}".`);
    return {
      name: f.name.value.trim(),
      published: f.published.checked,
      tagline: f.tagline.value.trim(),
      city: f.city.value.trim(),
      areaName: f.areaName.value.trim(),
      area: f.area.value.trim(),
      description: f.description.value.trim(),
      capacity: parseInt(f.capacity.value, 10) || 1,
      bedrooms: parseInt(f.bedrooms.value, 10) || 0,
      bathrooms: num(f.bathrooms.value),
      location: f.location.value.trim(),
      coordinates: { lat: parseFloat(m[1]), lng: parseFloat(m[2]) },
      phone: f.phone.value.trim(),
      whatsapp: f.whatsapp.value.trim(),
      email: f.email.value.trim(),
      thumbnail: f.thumbnail.value.trim(),
      imageCategories: draft.imageCategories.filter(c => c.category.trim()).map(c => ({ category: c.category.trim(), images: c.images })),
      amenityCategories: draft.amenityCategories.filter(c => c.category.trim())
        .map(c => ({ category: c.category.trim(), items: c.items.filter(i => i.name.trim()).map(i => ({ name: i.name.trim(), icon: i.icon })) })),
      nearbyPlaces: places.map(p => ({ name: p.name.trim(), type: p.type || 'beach', lat: p.lat, lng: p.lng, walkMinutes: p.walkMinutes || null })),
      houseRules: splitLines(f.houseRules.value),
      hostName: f.hostName.value.trim(),
      hostBio: f.hostBio.value.trim(),
      bookingMode: f.bookingMode.value,
      wholeLabel: f.wholeLabel.value.trim(),
      rooms: draft.rooms.filter(r => r.name.trim()).map(r => ({ id: r.id, name: r.name.trim(), description: (r.description || '').trim(), capacity: r.capacity || 1 })),
      layoutDetails: splitLines(f.layoutDetails.value),
      guestInstructions: splitLines(f.guestInstructions.value)
    };
  }

  async function saveStay(f, btn) {
    let body;
    try { body = collectStay(f); } catch (err) { return showToast(err.message, 'error'); }
    if (body.bookingMode === 'rooms' && body.rooms.length === 0) return showToast('Add at least one room, or choose "Whole stay only".', 'error');
    btn.disabled = true;
    try {
      const { stay } = await api('/api/admin/homestays/' + encodeURIComponent(getPropertyId()), 'PUT', body);
      const list = stays();
      list[list.findIndex(s => s.id === stay.id)] = stay;
      refreshPropertySelect(stay.id);
      showToast('Saved — the website now shows these changes');
      renderEditor(); renderPricingExtras(); renderBlockUnits();
    } catch (err) {
      showToast(err.message, 'error');
    } finally { btn.disabled = false; }
  }

  async function deleteStay(force = false) {
    const stay = currentStay();
    if (!stay) return;
    if (!force && !confirm(`Delete "${stay.name}" from the website?\n\nThis can't be undone. To take it down for now, untick "Show this stay on the website" instead.`)) return;
    try {
      await api('/api/admin/homestays/' + encodeURIComponent(stay.id) + (force ? '?force=true' : ''), 'DELETE');
      await reloadStays(stays().find(s => s.id !== stay.id)?.id);
      showToast('Stay deleted');
      window.onAdminPropertyChange();
    } catch (err) {
      if (err.status === 409 && confirm(err.message)) return deleteStay(true);
      showToast(err.message, 'error');
    }
  }

  async function addStay() {
    const name = prompt('Name of the new stay (you can change it later)');
    if (!name || name.trim().length < 2) return;
    try {
      const { stay } = await api('/api/admin/homestays', 'POST', {
        name: name.trim(), published: false, capacity: 2, bedrooms: 1, bathrooms: 1,
        city: 'Pondicherry', coordinates: { lat: 11.9341, lng: 79.8306 }
      });
      await reloadStays(stay.id);
      window.onAdminPropertyChange();
      showToast('Stay created (hidden). Add photos, location and prices, then tick "Show this stay on the website".');
      document.getElementById('stayEditorCard')?.scrollIntoView({ behavior: 'smooth' });
    } catch (err) { showToast(err.message, 'error'); }
  }

  /* ══════════════════════════════════════════════════════════════════════
     PRICING EXTRAS (rooms, weekend switch, price periods)
     ══════════════════════════════════════════════════════════════════════ */
  let seasonsDraft = [];
  function renderPricingExtras() {
    const host = document.getElementById('pricingExtras');
    if (!host) return;
    host.innerHTML = '';
    const stay = currentStay();
    if (!stay) return;
    const roomsMode = stay.bookingMode === 'rooms' && (stay.rooms || []).length > 0;

    if (roomsMode) {
      const sw = h('input', { type: 'checkbox', id: 'axWeekendRooms', checked: Boolean(stay.roomBooking?.allowOnWeekends) });
      const roomRows = (stay.rooms || []).map(r => h('div', { class: 'ax-row' },
        h('div', { style: 'flex:2; font-size:14px' }, r.name),
        numberInput(r.price?.weekday || '', { 'data-room': r.id, 'data-kind': 'weekday', placeholder: 'Weekday ₹' }),
        numberInput(r.price?.weekend || '', { 'data-room': r.id, 'data-kind': 'weekend', placeholder: 'Fri/Sat ₹ (if allowed)' })));
      host.appendChild(h('div', { class: 'ax-block' },
        h('div', { class: 'card-title', style: 'margin-bottom:8px' }, 'Single-room prices (per night)'),
        h('div', { class: 'ax-hint', style: 'margin-bottom:12px' }, 'The Weekday / Weekend prices above are for the whole villa.'),
        ...roomRows,
        h('label', { class: 'ax-switch', style: 'margin-top:12px' }, sw,
          h('span', {}, 'Allow single-room bookings on Friday & Saturday nights (off-season)')),
        h('div', { class: 'ax-hint' }, 'Off by default, so one small room can’t block a weekend whole-villa booking.')));
    }

    seasonsDraft = clone(stay.seasons || []);
    const seasonsBox = h('div');
    const renderSeasons = () => {
      seasonsBox.innerHTML = '';
      seasonsDraft.forEach((se, i) => {
        se.pricing ||= { weekday: 0, weekend: 0 };
        se.roomPrices ||= {};
        const roomInputs = roomsMode ? (stay.rooms || []).map(r => numberInput(se.roomPrices[r.id]?.weekday || '', {
          placeholder: r.name + ' ₹', title: r.name, oninput: e => { se.roomPrices[r.id] = { weekday: num(e.target.value), weekend: num(e.target.value) }; }
        })) : [];
        seasonsBox.appendChild(h('div', { class: 'ax-season' },
          h('div', { class: 'ax-row' },
            text(se.name, { placeholder: 'Name, e.g. Year-end', oninput: e => { se.name = e.target.value; } }),
            h('input', { type: 'date', value: se.from, title: 'First night', oninput: e => { se.from = e.target.value; } }),
            h('input', { type: 'date', value: se.to, title: 'Last night', oninput: e => { se.to = e.target.value; } }),
            h('button', { type: 'button', class: 'btn-delete', onclick: () => { seasonsDraft.splice(i, 1); renderSeasons(); } }, '✕')),
          h('div', { class: 'ax-row' },
            numberInput(se.pricing.weekday || '', { placeholder: (roomsMode ? 'Whole villa ' : '') + 'weekday ₹', oninput: e => { se.pricing.weekday = num(e.target.value); } }),
            numberInput(se.pricing.weekend || '', { placeholder: (roomsMode ? 'Whole villa ' : '') + 'Fri/Sat ₹', oninput: e => { se.pricing.weekend = num(e.target.value); } }),
            ...roomInputs)));
      });
      seasonsBox.appendChild(h('button', { type: 'button', class: 'btn-delete ax-add', onclick: () => {
        seasonsDraft.push({ name: '', from: '', to: '', pricing: { weekday: 0, weekend: 0 }, roomPrices: {} }); renderSeasons();
      } }, '＋ Add price period'));
    };
    renderSeasons();
    host.appendChild(h('div', { class: 'ax-block' },
      h('div', { class: 'card-title', style: 'margin-bottom:8px' }, 'Price periods'),
      h('div', { class: 'ax-hint', style: 'margin-bottom:12px' }, 'Different prices for set dates, e.g. Year-end from 10 Dec to 6 Jan. Dates are the first and last night. Outside these dates the normal prices apply.'),
      seasonsBox));
  }

  // Called by updatePricing() in the main admin script.
  window.collectExtraPricing = function () {
    const stay = currentStay();
    const extra = {};
    const roomInputs = document.querySelectorAll('#pricingExtras input[data-room]');
    if (roomInputs.length) {
      extra.roomPrices = {};
      roomInputs.forEach(inp => {
        const id = inp.dataset.room;
        extra.roomPrices[id] ||= { weekday: 0, weekend: 0 };
        extra.roomPrices[id][inp.dataset.kind] = num(inp.value);
      });
      const sw = document.getElementById('axWeekendRooms');
      if (sw) extra.allowRoomsOnWeekends = sw.checked;
    }
    const bad = seasonsDraft.find(se => !se.name.trim() || !se.from || !se.to);
    if (bad) throw new Error('Each price period needs a name, a first night and a last night.');
    extra.seasons = seasonsDraft.map(se => ({
      ...(se.id ? { id: se.id } : {}), name: se.name.trim(), from: se.from, to: se.to,
      pricing: { weekday: num(se.pricing.weekday), weekend: num(se.pricing.weekend) || num(se.pricing.weekday) },
      roomPrices: se.roomPrices || {}
    }));
    return extra;
  };

  // Called after a successful pricing save so the editor shows fresh data.
  window.afterPricingSaved = function (body) {
    const stay = currentStay();
    if (!stay) return;
    if (body.roomPrices && stay.rooms) stay.rooms.forEach(r => { if (body.roomPrices[r.id]) r.price = body.roomPrices[r.id]; });
    if (typeof body.allowRoomsOnWeekends === 'boolean') stay.roomBooking = { ...(stay.roomBooking || {}), allowOnWeekends: body.allowRoomsOnWeekends };
    if (body.seasons) stay.seasons = body.seasons;
  };

  /* ══════════════════════════════════════════════════════════════════════
     MANUAL BLOCK: which rooms
     ══════════════════════════════════════════════════════════════════════ */
  function renderBlockUnits() {
    const host = document.getElementById('blockUnitsBlock');
    if (!host) return;
    host.innerHTML = '';
    const stay = currentStay();
    if (!stay || stay.bookingMode !== 'rooms' || !(stay.rooms || []).length) return;
    host.appendChild(h('label', {}, 'What to block'));
    const opts = h('div', { class: 'ax-chips' },
      h('label', {}, h('input', { type: 'radio', name: 'axBlockUnit', value: 'whole', checked: true }), ' ', stay.wholeLabel || 'Whole villa'),
      ...(stay.rooms || []).map(r => h('label', {}, h('input', { type: 'checkbox', name: 'axBlockRoom', value: r.id }), ' ', r.name)));
    opts.addEventListener('change', e => {
      if (e.target.name === 'axBlockRoom') opts.querySelector('input[value="whole"]').checked = !opts.querySelector('input[name="axBlockRoom"]:checked');
      if (e.target.value === 'whole') opts.querySelectorAll('input[name="axBlockRoom"]').forEach(c => { c.checked = false; });
    });
    host.appendChild(opts);
  }
  window.getBlockUnits = function () {
    const rooms = [...document.querySelectorAll('input[name="axBlockRoom"]:checked')].map(c => c.value);
    return rooms.length ? rooms : 'whole';
  };

  /* ══════════════════════════════════════════════════════════════════════
     WEBSITE SETTINGS: contact number + festive themes
     ══════════════════════════════════════════════════════════════════════ */
  async function renderSettings() {
    const host = document.getElementById('siteSettingsBody');
    if (!host) return;
    let settings = {};
    try { settings = await api('/api/admin/site-settings'); } catch (err) { host.textContent = 'Could not load settings.'; return; }
    host.innerHTML = '';
    const c = settings.contact || {};
    const phone = text(c.phone, { placeholder: '+91 …' });
    const whatsapp = text(c.whatsapp, { placeholder: '+91 …' });
    const email = text(c.email);

    // Background Images manager (multiple images transition seamlessly)
    let bgImages = clone(Array.isArray(settings.backgroundImages) ? settings.backgroundImages : []);
    const bgBox = h('div', { style: 'margin-bottom:20px;' });
    const bgFileInput = h('input', { type: 'file', accept: 'image/*', multiple: true, style: 'display:none' });
    bgFileInput.onchange = async () => {
      const files = Array.from(bgFileInput.files || []);
      if (!files.length) return;
      showToast(`Uploading ${files.length} background image${files.length > 1 ? 's' : ''}…`);
      for (const file of files) {
        try {
          const url = await uploadImage(file);
          bgImages.push(url);
        } catch (err) {
          showToast(err.message, 'error');
        }
      }
      bgFileInput.value = '';
      renderBgImages();
    };

    const renderBgImages = () => {
      bgBox.innerHTML = '';
      const grid = h('div', { class: 'ax-photo-grid', style: 'margin-bottom:12px;' });
      if (!bgImages.length) {
        grid.appendChild(h('div', { class: 'empty-state', style: 'grid-column:1/-1; padding:16px; text-align:center;' }, 'No custom background photos yet (using default villa background). Upload 1, 2, 3 or more images for a seamless slideshow!'));
      } else {
        bgImages.forEach((img, i) => {
          const thumb = h('div', { class: 'ax-photo' },
            h('img', { src: imgSrc(img), alt: `Background ${i + 1}` }),
            h('div', { class: 'ax-photo-actions' },
              h('span', { style: 'font-size:11px; color:#fff; padding:2px 6px;' }, `#${i + 1}`),
              h('button', { type: 'button', title: 'Delete image', onclick: () => { bgImages.splice(i, 1); renderBgImages(); } }, '✕')
            )
          );
          grid.appendChild(thumb);
        });
      }
      bgBox.appendChild(grid);
      bgBox.appendChild(h('div', { style: 'display:flex; gap:10px; align-items:center;' },
        h('button', { type: 'button', class: 'btn-delete', onclick: () => bgFileInput.click() }, '⤒ Upload background photos'),
        bgImages.length ? h('button', { type: 'button', class: 'btn-delete', onclick: () => { if (confirm('Reset to default background?')) { bgImages = []; renderBgImages(); } } }, '↺ Reset to default') : null
      ));
    };
    renderBgImages();

    const save = h('button', { type: 'button', class: 'btn btn-primary', onclick: async () => {
      try {
        await api('/api/admin/site-settings', 'PUT', {
          contact: { phone: phone.value.trim(), whatsapp: whatsapp.value.trim(), email: email.value.trim() },
          backgroundImages: bgImages
        });
        showToast('Website settings saved');
      } catch (err) { showToast(err.message, 'error'); }
    } }, '💾  Save website settings');
    host.append(
      h('div', { class: 'card-title', style: 'margin:8px 0 8px' }, '🖼️ Background Images (Seamless Rotating Canvas)'),
      h('div', { class: 'ax-hint', style: 'margin-bottom:12px' }, 'Upload your own background images from admin. If you upload 3 or more images, the website will seamlessly and smoothly cross-fade between them in the background.'),
      bgFileInput,
      bgBox,
      h('div', { class: 'card-title', style: 'margin:24px 0 8px' }, '📞 Contact details'),
      h('div', { class: 'ax-hint', style: 'margin-bottom:12px' }, 'The number guests call and message. A stay uses these unless it has its own number.'),
      h('div', { class: 'ax-grid3' }, field('Phone', phone), field('WhatsApp', whatsapp), field('Email', email)),
      save);
  }

  /* ── wiring ─────────────────────────────────────────────────────────── */
  window.onAdminPropertyChange = function () {
    renderEditor();
    renderPricingExtras();
    renderBlockUnits();
    if (typeof loadPeriods === 'function') loadPeriods();
    if (typeof loadExternalIcal === 'function') loadExternalIcal();
    if (typeof loadPricing === 'function') loadPricing();
  };

  window.initAdminExtras = function () {
    document.getElementById('addStayBtn')?.addEventListener('click', addStay);
    renderEditor();
    renderPricingExtras();
    renderBlockUnits();
    renderSettings();
  };
})();
