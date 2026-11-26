import * as Rules from './lib/booking-rules.js';
import { PUDUCHERRY_BOUNDARY, PUDUCHERRY_SURROUNDING } from './lib/puducherry-boundary.js';

/** Escape text before putting it into HTML (stay details come from the admin panel). */
function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const inr = (n) => '₹' + Math.round(Number(n) || 0).toLocaleString('en-IN');
const imgUrl = (p) => (!p ? '' : /^(https?:)?\//.test(p) ? p : '/' + p);
const toDateStr = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// Show font icons only once the icon font has loaded; if it never does, hide them
// (the tabs use drawn icons, so the page still makes sense).
(function watchIconFont() {
  const loaded = () => document.fonts && [...document.fonts].some(f =>
    f.family.replace(/["']/g, '') === 'Material Symbols Outlined' && f.status === 'loaded');
  const done = () => {
    document.body.classList.remove('icons-loading');
    if (!loaded()) document.body.classList.add('icons-missing');
  };
  if (!document.fonts || !document.fonts.load) { document.body.classList.remove('icons-loading'); return; }
  const timer = setTimeout(done, 4000);
  document.fonts.load('24px "Material Symbols Outlined"', 'home')
    .then(() => { if (loaded()) { clearTimeout(timer); done(); } })
    .catch(() => {});
})();

document.addEventListener('DOMContentLoaded', () => {
  let homestays = [];
  let siteSettings = { contact: {}, backgroundImages: [] };
  let bgSlideshowTimer = null;
  let bgSlideIndex = 0;
  let bookingSelection = { type: 'whole' }; // whole villa or chosen rooms
  let currentPeriods = [];                  // booked periods for the current stay
  let currentHomestay = null;
  let currentSlideIndex = 0;
  let slideshowInterval = null;
  let calendarInstance = null;
  
  // Lightbox state
  let lightboxActiveIndex = 0;
  
  // Elements
  const activePropertyBtn = document.getElementById('activePropertyBtn');
  const propertyDropdown = document.getElementById('propertyDropdown');
  const propertySelector = document.getElementById('propertySelector');

  
  // Tab elements
  const tabs = document.querySelectorAll('.nav-tab');
  const tabPanes = document.querySelectorAll('.tab-pane');
  
  // Overview specs
  const specGuests = document.getElementById('specGuests');
  const specBedrooms = document.getElementById('specBedrooms');
  const specBathrooms = document.getElementById('specBathrooms');
  const specArea = document.getElementById('specArea');
  const overviewTitle = document.getElementById('overviewTitle');
  const propertyDesc = document.getElementById('propertyDesc');
  const amenitiesGrid = document.getElementById('amenitiesGrid');
  const bookingLocation = document.getElementById('bookingLocation');
  
  // Gallery elements
  const galleryGrid = document.getElementById('galleryGrid');
  const lightbox = document.getElementById('lightbox');
  const lightboxImg = document.getElementById('lightboxImg');
  const lightboxCaption = document.getElementById('lightboxCaption');
  const lightboxClose = document.getElementById('lightboxClose');
  const lightboxPrev = document.getElementById('lightboxPrev');
  const lightboxNext = document.getElementById('lightboxNext');
  
  // Contact elements
  const contactPhone = document.getElementById('contactPhone');
  const contactWhatsapp = document.getElementById('contactWhatsapp');
  const contactEmail = document.getElementById('contactEmail');
  const contactLocation = document.getElementById('contactLocation');
  const contactMap = document.getElementById('contactMap');
  
  // Booking Action
  const whatsappBookBtn = document.getElementById('whatsappBookBtn');
  
  // Booking Form State
  let bookingAdults = 2;
  let bookingChildren = 0;
  let maxGuests = 6;

  // --- MapTiler Integration ---
  const MAPTILER_API_KEY = 'WcnnCW2FgJc0HkV8JWrM';
  let stayMap = null;
  let stayMarker = null;

  function initStayMap(homestay) {
    if (!homestay) return;
    const container = document.getElementById('stayMaptilerMap');
    const iframeFallback = document.getElementById('contactMap');
    const directionsBtn = document.getElementById('stayDirectionsBtn');

    const lat = homestay.coordinates?.lat || 11.9348;
    const lng = homestay.coordinates?.lng || 79.8298;

    if (directionsBtn) {
      directionsBtn.href = `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
    }

    // Lazy load: Only initialize MapTiler WebGL if the contact tab is active or stayMap is already active
    const contactPane = document.getElementById('tab-contact');
    const isContactActive = contactPane && contactPane.classList.contains('active');
    if (!isContactActive && !stayMap) {
      return;
    }

    if (typeof window.maptilersdk !== 'undefined') {
      try {
        window.maptilersdk.config.apiKey = MAPTILER_API_KEY;

        const popupHTML = `
          <div class="stay-popup-content">
            <span class="stay-popup-badge">VolGO Stay</span>
            <h4>${esc(homestay.name)}</h4>
            <p>${esc(homestay.location)}</p>
            <a href="https://www.google.com/maps/search/?api=1&query=${lat},${lng}" target="_blank" rel="noopener noreferrer" style="color: #9a3412; font-weight: 600; font-size: 11px; text-decoration: underline;">Open in Google Maps ↗</a>
          </div>
        `;

        if (!stayMap) {
          stayMap = new window.maptilersdk.Map({
            container: 'stayMaptilerMap',
            style: window.maptilersdk.MapStyle.STREETS,
            center: [lng, lat],
            zoom: 15.8,
            navigationControl: false,
            geolocateControl: false
          });

          stayMap.on('load', () => {
            stayMap.resize();
          });

          // Custom Stay Marker
          const markerEl = document.createElement('div');
          markerEl.className = 'maptiler-stay-marker';
          markerEl.innerHTML = '<span class="material-symbols-outlined">hotel</span>';

          const popup = new window.maptilersdk.Popup({ offset: 25 }).setHTML(popupHTML);

          stayMarker = new window.maptilersdk.Marker({ element: markerEl })
            .setLngLat([lng, lat])
            .setPopup(popup)
            .addTo(stayMap);

          setupStayMapStyleSwitches();
          setupMobileDoubleTapMapControl(stayMap, container, container.parentElement);
        } else {
          stayMap.flyTo({
            center: [lng, lat],
            zoom: 15.8,
            essential: true
          });

          if (stayMarker) {
            stayMarker.setLngLat([lng, lat]);
            const popup = new window.maptilersdk.Popup({ offset: 25 }).setHTML(popupHTML);
            stayMarker.setPopup(popup);
          }
        }

        if (iframeFallback) iframeFallback.style.display = 'none';
        if (container) container.style.display = 'block';
      } catch (err) {
        console.warn('MapTiler SDK error, using fallback:', err);
        fallbackStayMapIframe(homestay);
      }
    } else {
      fallbackStayMapIframe(homestay);
    }
  }

  function fallbackStayMapIframe(homestay) {
    const container = document.getElementById('stayMaptilerMap');
    const iframe = document.getElementById('contactMap');
    if (container) container.style.display = 'none';
    if (iframe) {
      iframe.style.display = 'block';
      iframe.src = `https://api.maptiler.com/maps/streets-v2/?key=${MAPTILER_API_KEY}#16.5/${homestay.coordinates?.lat || 11.9348}/${homestay.coordinates?.lng || 79.8298}`;
    }
  }

  function setupStayMapStyleSwitches() {
    const btnStreets = document.getElementById('mapStyleStreets');
    const btnSatellite = document.getElementById('mapStyleSatellite');
    const btnOutdoor = document.getElementById('mapStyleOutdoor');
    const buttons = [btnStreets, btnSatellite, btnOutdoor];

    const setStyle = (activeBtn, style) => {
      if (!stayMap || !window.maptilersdk) return;
      buttons.forEach(b => b?.classList.remove('active'));
      activeBtn?.classList.add('active');
      stayMap.setStyle(style);
    };

    if (btnStreets) {
      btnStreets.onclick = () => setStyle(btnStreets, window.maptilersdk.MapStyle.STREETS);
    }
    if (btnSatellite) {
      btnSatellite.onclick = () => setStyle(btnSatellite, window.maptilersdk.MapStyle.HYBRID);
    }
    if (btnOutdoor) {
      btnOutdoor.onclick = () => setStyle(btnOutdoor, window.maptilersdk.MapStyle.OUTDOOR);
    }
  }

  /* ════════════════════════════════════════════════════════════════════
     PONDICHERRY MAP (left pane): every stay as a pin. Selecting a pin opens
     a photo carousel that links to the stay's details on the right. The
     selected stay shows dotted walking routes to nearby beaches.
     ════════════════════════════════════════════════════════════════════ */
  let staysMap = null;
  const stayMarkers = new Map();   // stay id → marker
  let placeMarkers = [];           // nearby places of the selected stay
  let mapReady = false;
  const PONDY_CENTER = [79.8270, 11.9180];

  const PLACE_ICONS = { beach: 'beach_access', landmark: 'account_balance', food: 'restaurant', other: 'place' };

  function stayPhotos(stay) {
    const list = [];
    if (stay.thumbnail) list.push(stay.thumbnail);
    (stay.imageCategories || []).forEach(c => (c.images || []).forEach(i => { if (!list.includes(i)) list.push(i); }));
    return list.slice(0, 8);
  }

  function stayPopupHtml(stay, activePlaceIdx = 0) {
    const photos = stayPhotos(stay);
    const from = Rules.fromPrice(stay);
    const places = (stay.nearbyPlaces || []).filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lng));

    return `
      <div class="map-popup" data-stay="${esc(stay.id)}">
        ${photos.length ? `
        <div class="map-popup-carousel" data-index="0">
          <div class="map-popup-track">
            ${photos.map((p, i) => `<img src="${esc(imgUrl(p))}" alt="${esc(stay.name)} photo ${i + 1}" ${i ? 'loading="lazy"' : ''}>`).join('')}
          </div>
          ${photos.length > 1 ? `
          <button type="button" class="map-popup-nav prev" aria-label="Previous photo">‹</button>
          <button type="button" class="map-popup-nav next" aria-label="Next photo">›</button>
          <div class="map-popup-dots">${photos.map((_, i) => `<span class="${i ? '' : 'on'}"></span>`).join('')}</div>` : ''}
        </div>` : ''}
        <div class="map-popup-body">
          <div class="map-popup-area">${esc(stay.areaName || stay.city || 'Pondicherry')}</div>
          <h4>${esc(stay.name)}</h4>
          <div class="map-popup-meta">${esc(Rules.hasRooms(stay) ? `${stay.bedrooms} bedrooms · book whole or by room` : `${stay.bedrooms} bed · up to ${stay.capacity} guests`)}</div>
          ${from ? `<div class="map-popup-price">from <strong>${inr(from)}</strong> / night</div>` : ''}
          ${places.length ? `
          <div class="map-popup-nearby-section">
            <div class="map-popup-nearby-title">Nearby Attractions (click to view route):</div>
            <div class="map-popup-nearby-pills">
              ${places.map((p, idx) => {
                const mins = p.walkMinutes || Rules.walkingMinutes(stay.coordinates, p);
                return `
                <button type="button" class="popup-place-btn ${idx === activePlaceIdx ? 'active' : ''}" data-idx="${idx}">
                  ${p.type === 'beach' ? '🏖️' : '📍'} ${esc(p.name)}${mins ? ` (${mins}m)` : ''}
                </button>`;
              }).join('')}
            </div>
          </div>` : ''}
          <button type="button" class="map-popup-cta">Book This Stay →</button>
        </div>
      </div>`;
  }

  function wirePopup(popupEl, stay) {
    if (!popupEl) return;
    const carousel = popupEl.querySelector('.map-popup-carousel');
    if (carousel) {
      const track = carousel.querySelector('.map-popup-track');
      const dots = [...carousel.querySelectorAll('.map-popup-dots span')];
      const count = track.children.length;
      const go = (i) => {
        const idx = (i + count) % count;
        carousel.dataset.index = idx;
        track.style.transform = `translateX(-${idx * 100}%)`;
        dots.forEach((d, j) => d.classList.toggle('on', j === idx));
      };
      carousel.querySelector('.prev')?.addEventListener('click', (e) => { e.stopPropagation(); go(Number(carousel.dataset.index) - 1); });
      carousel.querySelector('.next')?.addEventListener('click', (e) => { e.stopPropagation(); go(Number(carousel.dataset.index) + 1); });
    }

    // User-based route selection: click any attraction pill to view its single route
    popupEl.querySelectorAll('.popup-place-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = Number(btn.dataset.idx);
        popupEl.querySelectorAll('.popup-place-btn').forEach((b, j) => b.classList.toggle('active', j === idx));
        showNearbyPlaces(stay, false, true, true, idx);
      });
    });

    popupEl.querySelector('.map-popup-cta')?.addEventListener('click', () => {
      window.redirectToCalendar(stay.id);
    });
  }

  function makeStayMarkerEl(stay) {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'stay-pin';
    el.setAttribute('aria-label', `${stay.name}, ${stay.areaName || ''}`);
    const from = Rules.fromPrice(stay);
    const priceText = from ? ` · ${Rules.hasRooms(stay) ? 'from ' : ''}${inr(from)}` : '';
    el.innerHTML = `<span class="stay-pin-icon material-symbols-outlined" aria-hidden="true">home</span><span class="stay-pin-label">${esc(stay.areaName || stay.name)}${priceText}</span>`;
    return el;
  }

  // 3D View perspective toggle
  function toggle3dView() {
    if (!staysMap) return;
    const btn = document.getElementById('map3dBtn');
    const txt = document.getElementById('map3dBtnText');
    const is3d = staysMap.getPitch() > 25;

    if (is3d) {
      staysMap.easeTo({
        pitch: 0,
        bearing: 0,
        duration: 700
      });
      if (btn) btn.classList.remove('active');
      if (txt) txt.textContent = '3D View';
    } else {
      staysMap.easeTo({
        pitch: 55,
        bearing: -18,
        duration: 900
      });
      if (btn) btn.classList.add('active');
      if (txt) txt.textContent = '2D View';
    }
  }

  // Cinematic Animated Drone Tour
  let tourRunning = false;
  let tourStopIndex = 0;
  let tourTimeout = null;

  function stopAnimatedTour() {
    tourRunning = false;
    if (tourTimeout) clearTimeout(tourTimeout);
    tourTimeout = null;
    const btn = document.getElementById('mapTourBtn');
    const txt = document.getElementById('mapTourBtnText');
    const icon = btn ? btn.querySelector('.tour-play-icon') : null;
    if (btn) btn.classList.remove('tour-running');
    if (txt) txt.textContent = 'Animated Tour';
    if (icon) icon.textContent = 'play_arrow';
  }

  function startAnimatedTour() {
    if (!staysMap) return;
    tourRunning = true;
    tourStopIndex = 0;
    const btn = document.getElementById('mapTourBtn');
    const txt = document.getElementById('mapTourBtnText');
    const icon = btn ? btn.querySelector('.tour-play-icon') : null;
    if (btn) btn.classList.add('tour-running');
    if (txt) txt.textContent = 'Pause Tour';
    if (icon) icon.textContent = 'pause';

    const tourStops = [
      {
        name: 'Heritage Town — Volgo White Town Stay',
        stayId: 'volgo-homestay-first',
        center: [79.8298, 11.9348],
        zoom: 15.0,
        pitch: 50,
        bearing: -15,
        duration: 2500,
        dwell: 3200
      },
      {
        name: 'Rock Beach & Promenade Coast',
        stayId: 'volgo-homestay-first',
        center: [79.8355, 11.9318],
        zoom: 15.4,
        pitch: 55,
        bearing: 25,
        duration: 2200,
        dwell: 3000
      },

      {
        name: 'Pondicherry Villa Homestay — Ariyankuppam',
        stayId: 'volgo-villa-eden-beach',
        center: [79.8140, 11.8952],
        zoom: 14.8,
        pitch: 52,
        bearing: -8,
        duration: 2800,
        dwell: 3400
      },
      {
        name: 'Pondicherry Panorama Overview',
        stayId: null,
        center: [79.825, 11.915],
        zoom: 12.5,
        pitch: 35,
        bearing: 0,
        duration: 2200,
        dwell: 2500
      }
    ];

    function nextStop() {
      if (!tourRunning) return;
      closeAllPopups();
      const stop = tourStops[tourStopIndex];

      if (stop.stayId) {
        const stay = homestays.find(s => s.id === stop.stayId);
        if (stay) {
          loadHomestay(stay, { fromMap: true });
          showNearbyPlaces(stay, false, true, true);
        }
      }

      staysMap.flyTo({
        center: stop.center,
        zoom: stop.zoom,
        pitch: stop.pitch,
        bearing: stop.bearing,
        duration: stop.duration,
        essential: true
      });

      tourStopIndex = (tourStopIndex + 1) % tourStops.length;
      tourTimeout = setTimeout(() => {
        if (tourRunning) nextStop();
      }, stop.duration + stop.dwell);
    }

    nextStop();
  }

  // Traveler walking beacon along the curved red route
  let travelerMarker = null;
  let travelerAnimId = null;

  function stopTravelerAnimation() {
    if (travelerAnimId) cancelAnimationFrame(travelerAnimId);
    travelerAnimId = null;
    if (travelerMarker) {
      travelerMarker.remove();
      travelerMarker = null;
    }
  }

  function startTravelerAnimation(coords) {
    stopTravelerAnimation();
    if (!coords || coords.length < 2 || !staysMap) return;

    const el = document.createElement('div');
    el.className = 'traveler-pulse-beacon';
    el.innerHTML = `
      <span class="beacon-halo"></span>
      <span class="beacon-dot"></span>
      <span class="material-symbols-outlined beacon-walker">directions_walk</span>
    `;

    travelerMarker = new window.maptilersdk.Marker({ element: el, anchor: 'center' })
      .setLngLat(coords[0])
      .addTo(staysMap);

    let progress = 0;
    let forward = true;
    const speed = 0.004;

    function step() {
      if (!travelerMarker || !staysMap) return;
      if (forward) {
        progress += speed;
        if (progress >= 1) { progress = 1; forward = false; }
      } else {
        progress -= speed;
        if (progress <= 0) { progress = 0; forward = true; }
      }

      const exactIndex = progress * (coords.length - 1);
      const idx = Math.floor(exactIndex);
      const frac = exactIndex - idx;
      const ptA = coords[idx];
      const ptB = coords[Math.min(idx + 1, coords.length - 1)];

      const lng = ptA[0] + (ptB[0] - ptA[0]) * frac;
      const lat = ptA[1] + (ptB[1] - ptA[1]) * frac;

      travelerMarker.setLngLat([lng, lat]);
      travelerAnimId = requestAnimationFrame(step);
    }
    travelerAnimId = requestAnimationFrame(step);
  }

  let routeDashAnimId = null;
  let walkPillMarkers = [];

  const PONDY_REAL_CENTER = [79.826, 11.916];
  let destinationMarker = null;
  let walkBadgeMarker = null;
  let activeStayPopup = null;

  const STAYS_MAP_CATALOG = [
    {
      id: 'volgo-homestay-first',
      pin: 'heritage',
      name: 'Volgo White Town Stay',
      areaName: 'Heritage Town',
      price: '2,700',
      thumb: 'assets/images/volgo_1.webp',
      lngLat: [79.8298, 11.9348],
      beach: {
        name: 'Rock Beach (Promenade)',
        icon: '🌊',
        type: 'Beach & Promenade',
        lngLat: [79.8355, 11.9318],
        distance: '1.0 km',
        time: '12 min walk'
      },
      nearRange: [
        {
          name: 'Rock Beach (Promenade)',
          icon: '🌊',
          type: 'Beach & Promenade',
          lngLat: [79.8355, 11.9318],
          distance: '1.0 km',
          time: '12 min walk'
        },
        {
          name: 'Sri Aurobindo Ashram',
          icon: '🪷',
          type: 'Spiritual Landmark',
          lngLat: [79.8340, 11.9360],
          distance: '0.6 km',
          time: '7 min walk'
        },
        {
          name: 'French Quarter (White Town)',
          icon: '🥐',
          type: 'Heritage Cafes',
          lngLat: [79.8335, 11.9300],
          distance: '0.5 km',
          time: '6 min walk'
        },
        {
          name: 'Goubert Market',
          icon: '🛍️',
          type: 'Heritage Bazaar',
          lngLat: [79.8310, 11.9335],
          distance: '0.3 km',
          time: '4 min walk'
        }
      ]
    },

    {
      id: 'volgo-villa-eden-beach',
      pin: 'eden',
      name: 'Eden Villa 3BHK',
      areaName: 'Ariyankuppam',
      price: 'from 2,700',
      thumb: 'assets/images/volgo_5.webp',
      lngLat: [79.8140, 11.8952],
      beach: {
        name: 'Eden Beach (Blue Flag)',
        icon: '🏖️',
        type: 'Blue Flag Beach',
        lngLat: [79.8238, 11.8941],
        distance: '1.0 km',
        time: '12 min walk'
      },
      nearRange: [
        {
          name: 'Eden Beach (Blue Flag)',
          icon: '🏖️',
          type: 'Blue Flag Beach',
          lngLat: [79.8238, 11.8941],
          distance: '1.0 km',
          time: '12 min walk'
        },
        {
          name: 'Chunnambar Boat House',
          icon: '🚤',
          type: 'Backwaters & Kayak',
          lngLat: [79.8050, 11.8860],
          distance: '1.5 km',
          time: '4 min drive'
        },
        {
          name: 'Paradise Beach Ferry',
          icon: '🏝️',
          type: 'Island Ferry Point',
          lngLat: [79.8090, 11.8845],
          distance: '1.6 km',
          time: '5 min drive'
        },
        {
          name: 'Veerampattinam Coast',
          icon: '🌅',
          type: 'Fishing Village Coast',
          lngLat: [79.8250, 11.8985],
          distance: '1.2 km',
          time: '14 min walk'
        }
      ]
    }
  ];

  window.redirectToCalendar = function(id) {
    if (id) {
      const stay = (homestays && homestays.length ? homestays.find(s => s.id === id) : null) || (homestays && homestays[0]);
      if (stay) {
        loadHomestay(stay, { userClicked: true });
        if (typeof updateVectorMapSelection === 'function') {
          updateVectorMapSelection(stay);
        }
      }
    }

    if (isMapFullscreen && typeof toggleMapFullscreen === 'function') {
      toggleMapFullscreen(false);
    }
    if (typeof closeStayGlassModal === 'function') {
      closeStayGlassModal(true);
    }
    const glassModal = document.getElementById('stayGlassModal');
    if (glassModal) {
      glassModal.style.display = 'none';
      glassModal.classList.remove('open');
      glassModal.setAttribute('aria-hidden', 'true');
    }

    showTab('calendar');

    const overviewCard = document.getElementById('overviewCard');
    if (overviewCard) {
      overviewCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    setTimeout(() => {
      if (!calendarInstance && typeof applyAvailability === 'function') {
        applyAvailability();
      }
      const checkInInput = document.getElementById('checkInDate');
      if (checkInInput) checkInInput.focus();
    }, 120);
  };

  window.selectStayFromMap = window.redirectToCalendar;

  function makeCurvedPath(start, end, curvature = 0.05, numPoints = 25) {
    const coords = [];
    const midX = (start[0] + end[0]) / 2;
    const midY = (start[1] + end[1]) / 2;
    const dx = end[0] - start[0];
    const dy = end[1] - start[1];
    const ctrlX = midX - dy * curvature;
    const ctrlY = midY + dx * curvature;

    for (let i = 0; i <= numPoints; i++) {
      const t = i / numPoints;
      const x = (1 - t) * (1 - t) * start[0] + 2 * (1 - t) * t * ctrlX + t * t * end[0];
      const y = (1 - t) * (1 - t) * start[1] + 2 * (1 - t) * t * ctrlY + t * t * end[1];
      coords.push([x, y]);
    }
    return coords;
  }

  let isMapFullscreen = false;
  let toggleMapFullscreen = null;
  let dataLineAnimId = null;
  let activeStayCatalog = null;
  let activePlaceIndex = 0;

  function showRouteToPlace(catalogStay, place, fly = true) {
    if (!staysMap || !catalogStay || !place) return;

    activeStayCatalog = catalogStay;
    const isEden = catalogStay.pin === 'eden';
    const routeCoords = makeCurvedPath(catalogStay.lngLat, place.lngLat, 0.05, 50);

    const targetKm = parseFloat(place.distance) || 1.0;
    const targetMin = parseInt(place.time, 10) || 10;
    const isDrive = (place.time || '').toLowerCase().includes('drive');
    const act = isDrive ? 'drive' : 'walk';
    const actIcon = isDrive ? '🚗' : '🚶';

    const startSegment = [routeCoords[0], routeCoords[1]];
    const initGeojson = {
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', geometry: { type: 'LineString', coordinates: startSegment } }
      ]
    };

    if (staysMap.getSource('stay-walk-route')) {
      staysMap.getSource('stay-walk-route').setData(initGeojson);
    } else {
      staysMap.addSource('stay-walk-route', { type: 'geojson', data: initGeojson });
      staysMap.addLayer({
        id: 'stay-walk-route-glow',
        type: 'line',
        source: 'stay-walk-route',
        paint: {
          'line-color': '#ea580c',
          'line-width': 8,
          'line-opacity': 0.35,
          'line-blur': 4
        }
      });
      staysMap.addLayer({
        id: 'stay-walk-route-line',
        type: 'line',
        source: 'stay-walk-route',
        paint: {
          'line-color': '#dc2626',
          'line-width': 3.5,
          'line-dasharray': [2, 2.5]
        }
      });
    }

    // Cancel any in-flight line animation
    if (dataLineAnimId) {
      cancelAnimationFrame(dataLineAnimId);
      dataLineAnimId = null;
    }

    // Clean up any old destination marker
    if (destinationMarker) {
      destinationMarker.remove();
      destinationMarker = null;
    }

    // Reflect the particular clicked area on the map with a destination pin marker
    const destEl = document.createElement('div');
    destEl.className = 'beach-dest-marker';
    destEl.innerHTML = `
      <div class="dest-bubble">
        <span class="dest-icon">${place.icon}</span>
        <div class="dest-text-col">
          <span class="dest-label">${place.name}</span>
          <span class="dest-sub">${place.distance} · ${place.time}</span>
        </div>
      </div>
      <div class="dest-pin-base">
        <div class="dest-pin-dot"></div>
        <div class="dest-pin-pulse"></div>
      </div>
    `;
    destinationMarker = new window.maptilersdk.Marker({ element: destEl, anchor: 'bottom' })
      .setLngLat(place.lngLat)
      .addTo(staysMap);

    // Clean up any old walking badge if present
    if (walkBadgeMarker) {
      walkBadgeMarker.remove();
      walkBadgeMarker = null;
    }

    // Update map floating guideline sentence - Stays fixed at top-left once user clicks
    const bar = document.getElementById('mapGuidelineBar');
    const txt = document.getElementById('mapGuidelineText');
    if (bar && txt) {
      txt.textContent = `${catalogStay.areaName} ➔ ${place.name} (${place.distance} · ${place.time})`;
      bar.style.display = 'inline-flex';
    }

    // Progressive connecting animation: draw line point-by-point and count distance
    const animDuration = 1200; // 1.2s smooth progressive connecting animation
    const startTime = performance.now();

    function stepDataLine(now) {
      const elapsed = now - startTime;
      const progress = Math.min(1, elapsed / animDuration);
      const ease = 1 - Math.pow(1 - progress, 2.5);

      const ptCount = Math.max(2, Math.round(ease * (routeCoords.length - 1)) + 1);
      const curCoords = routeCoords.slice(0, ptCount);

      if (staysMap && staysMap.getSource('stay-walk-route')) {
        staysMap.getSource('stay-walk-route').setData({
          type: 'FeatureCollection',
          features: [{
            type: 'Feature',
            geometry: { type: 'LineString', coordinates: curCoords }
          }]
        });
      }

      if (progress < 1) {
        dataLineAnimId = requestAnimationFrame(stepDataLine);
      } else {
        dataLineAnimId = null;
      }
    }

    dataLineAnimId = requestAnimationFrame(stepDataLine);

    // Smoothly fit view to show both the stay and destination
    if (fly) {
      const bounds = new window.maptilersdk.LngLatBounds();
      bounds.extend(catalogStay.lngLat);
      bounds.extend(place.lngLat);
      staysMap.fitBounds(bounds, {
        padding: { top: 60, bottom: 60, left: 60, right: 60 },
        maxZoom: isEden ? 14.5 : 15.4,
        duration: 650
      });
    }
  }

  function openStayGlassModal(catalogStay, initialPlaceIdx = 0) {
    if (!catalogStay) return;
    activeStayCatalog = catalogStay;
    activePlaceIndex = initialPlaceIdx;

    const modal = document.getElementById('stayGlassModal');
    const body = document.getElementById('stayGlassModalBody');
    if (!modal || !body) return;

    const places = catalogStay.nearRange || [catalogStay.beach];
    const initialPlace = places[initialPlaceIdx] || places[0];

    const stayGmapsUrl = `https://www.google.com/maps/search/?api=1&query=${catalogStay.lngLat[1]},${catalogStay.lngLat[0]}`;

    body.innerHTML = `
      <div class="gm-stay-header">
        <div class="gm-photo-wrap">
          <img src="${catalogStay.thumb}" alt="${catalogStay.name}" class="gm-stay-photo" onerror="this.src='assets/images/volgo_1.webp'">
          <span class="gm-area-badge">📍 ${catalogStay.areaName}</span>
        </div>
        <div class="gm-stay-info">
          <div class="gm-stay-title-row">
            <h3 class="gm-stay-title">${catalogStay.name}</h3>
            <span class="gm-stay-price">₹${catalogStay.price}<span>/night</span></span>
          </div>
          <p class="gm-stay-desc">${catalogStay.areaName} · Private Coastal Retreat Pondicherry</p>
          <div class="gm-guideline-banner">
            <span class="gm-guide-icon">⚡</span>
            <span class="gm-guide-text">Pick any area below to shoot animated dotted <b>guidelines / data lines</b> on the map.</span>
          </div>
        </div>
      </div>

      <div class="gm-areas-section">
        <div class="gm-areas-head">
          <div class="gm-areas-title">
            <span class="material-symbols-outlined" style="font-size:18px;color:#ea580c;">explore</span>
            <span>Nearby Areas & Proximity Guidelines</span>
          </div>
          <span class="gm-areas-count">${places.length} Key Spots</span>
        </div>

        <div class="gm-areas-grid">
          ${places.map((p, idx) => `
            <div class="gm-area-card ${idx === initialPlaceIdx ? 'active' : ''}" data-idx="${idx}" tabindex="0">
              <div class="gm-card-icon">${p.icon}</div>
              <div class="gm-card-main">
                <div class="gm-card-title">${p.name}</div>
                <div class="gm-card-type">${p.type}</div>
                <div class="gm-card-guideline-cue">
                  <span class="gm-cue-dot"></span>
                  <span>Shoot Dotted Guideline to Map</span>
                </div>
              </div>
              <div class="gm-card-metrics">
                <div class="gm-card-dist">📏 ${p.distance}</div>
                <div class="gm-card-time">⏱️ ${p.time}</div>
              </div>
            </div>
          `).join('')}
        </div>
      </div>

      <div class="gm-actions-footer">
        <button type="button" class="gm-btn-view-map" id="gmBtnViewMap">
          <span class="material-symbols-outlined" style="font-size:18px;">map</span>
          <span>View Guidelines on Map</span>
        </button>
        <a id="gmBtnGmaps" href="${stayGmapsUrl}" target="_blank" rel="noopener" class="gm-btn-gmaps" title="Open ${catalogStay.name} on Google Maps">
          <span class="material-symbols-outlined" style="font-size:18px;">location_on</span>
          <span>Open in Google Maps</span>
        </a>
        <button type="button" class="gm-btn-book" onclick="window.selectStayFromMap('${catalogStay.id}')">
          <span>Book This Stay →</span>
        </button>
      </div>
    `;

    // In full view or new stay open, reset inline drag coords so it spawns over the sea area by default
    const modalBox = document.getElementById('stayGlassModalBox');
    if (modalBox) {
      modalBox.style.left = '';
      modalBox.style.top = '';
      modalBox.style.transform = '';
      modalBox.style.position = '';
      modalBox.style.margin = '';
    }

    // Open modal with ultra-glossy display
    modal.style.display = 'flex';
    modal.classList.add('open');
    modal.setAttribute('aria-hidden', 'false');

    // Attach card click handlers
    const cards = body.querySelectorAll('.gm-area-card');
    const btnViewMap = body.querySelector('#gmBtnViewMap');

    cards.forEach(card => {
      card.addEventListener('click', () => {
        cards.forEach(c => c.classList.remove('active'));
        card.classList.add('active');
        const idx = parseInt(card.dataset.idx, 10);
        activePlaceIndex = idx;
        const place = places[idx];
        if (place) {
          // Do not move or pan the map camera! Keep view completely stable where it is
          showRouteToPlace(catalogStay, place, false);
        }
      });
    });

    if (btnViewMap) {
      btnViewMap.onclick = () => {
        // Just hide modal to view map, keep guidelines
        closeStayGlassModal(false);
      };
    }

    // Initialize draggable behavior
    setupDraggableModal();

    // Draw initial place route without moving or shifting the map
    showRouteToPlace(catalogStay, initialPlace, false);
  }

  function closeStayGlassModal(cleanAll = true) {
    const modal = document.getElementById('stayGlassModal');
    if (modal) {
      modal.classList.remove('open');
      modal.setAttribute('aria-hidden', 'true');
      modal.style.display = 'none';
      const box = document.getElementById('stayGlassModalBox');
      if (box && cleanAll) {
        box.style.left = '';
        box.style.top = '';
        box.style.transform = '';
      }
    }

    // "once click x button dont show anything" -> Complete clean slate
    if (cleanAll) {
      const guidelineBar = document.getElementById('mapGuidelineBar');
      if (guidelineBar) guidelineBar.style.display = 'none';

      if (destinationMarker) {
        destinationMarker.remove();
        destinationMarker = null;
      }

      if (walkBadgeMarker) {
        walkBadgeMarker.remove();
        walkBadgeMarker = null;
      }

      walkPillMarkers.forEach(m => m.remove());
      walkPillMarkers = [];

      if (dataLineAnimId) {
        cancelAnimationFrame(dataLineAnimId);
        dataLineAnimId = null;
      }

      if (routeDashAnimId) {
        cancelAnimationFrame(routeDashAnimId);
        routeDashAnimId = null;
      }

      if (staysMap && staysMap.getSource('stay-walk-route')) {
        staysMap.getSource('stay-walk-route').setData({
          type: 'FeatureCollection',
          features: []
        });
      }

      if (staysMap && staysMap.getSource('routes-3d-src')) {
        staysMap.getSource('routes-3d-src').setData({
          type: 'FeatureCollection',
          features: []
        });
      }

      if (activeStayPopup) {
        activeStayPopup.remove();
        activeStayPopup = null;
      }
    }
  }

  let dragInitialized = false;
  function setupDraggableModal() {
    const modalBox = document.getElementById('stayGlassModalBox');
    const dragHandle = document.getElementById('glassModalDragHandle');
    if (!modalBox || !dragHandle || dragInitialized) return;
    dragInitialized = true;

    let isDragging = false;
    let startX = 0, startY = 0;
    let initialLeft = 0, initialTop = 0;

    function startDrag(e) {
      if (e.target.closest('.glass-modal-close') || e.target.closest('button') || e.target.closest('a')) return;
      isDragging = true;
      const clientX = e.clientX !== undefined ? e.clientX : (e.touches && e.touches[0].clientX);
      const clientY = e.clientY !== undefined ? e.clientY : (e.touches && e.touches[0].clientY);
      startX = clientX;
      startY = clientY;

      const rect = modalBox.getBoundingClientRect();
      initialLeft = rect.left;
      initialTop = rect.top;

      modalBox.style.transform = 'none';
      modalBox.style.position = 'fixed';
      modalBox.style.left = `${initialLeft}px`;
      modalBox.style.top = `${initialTop}px`;
      modalBox.style.margin = '0';
      modalBox.classList.add('is-dragging');

      window.addEventListener('mousemove', onDrag, { passive: false });
      window.addEventListener('mouseup', endDrag);
      window.addEventListener('touchmove', onDrag, { passive: false });
      window.addEventListener('touchend', endDrag);
    }

    function onDrag(e) {
      if (!isDragging) return;
      if (e.cancelable) e.preventDefault();
      const clientX = e.clientX !== undefined ? e.clientX : (e.touches && e.touches[0].clientX);
      const clientY = e.clientY !== undefined ? e.clientY : (e.touches && e.touches[0].clientY);
      const deltaX = clientX - startX;
      const deltaY = clientY - startY;

      let newLeft = initialLeft + deltaX;
      let newTop = initialTop + deltaY;

      const boxW = modalBox.offsetWidth;
      const boxH = modalBox.offsetHeight;
      const maxLeft = window.innerWidth - boxW - 8;
      const maxTop = window.innerHeight - boxH - 8;

      newLeft = Math.max(8, Math.min(newLeft, maxLeft));
      newTop = Math.max(8, Math.min(newTop, maxTop));

      modalBox.style.left = `${newLeft}px`;
      modalBox.style.top = `${newTop}px`;
    }

    function endDrag() {
      isDragging = false;
      modalBox.classList.remove('is-dragging');
      window.removeEventListener('mousemove', onDrag);
      window.removeEventListener('mouseup', endDrag);
      window.removeEventListener('touchmove', onDrag);
      window.removeEventListener('touchend', endDrag);
    }

    dragHandle.addEventListener('mousedown', startDrag);
    dragHandle.addEventListener('touchstart', startDrag, { passive: true });
  }

  function updateVectorMapSelection(stay) {
    if (!stay) return;

    const isWhite = (stay.areaName || stay.name || '').toLowerCase().includes('white') || stay.id.includes('dummy') || stay.id.includes('white');
    const isEden = (stay.name || '').toLowerCase().includes('eden') || stay.id.includes('eden');
    const key = isEden ? 'eden' : (isWhite ? 'white' : 'heritage');

    // Update markers active status on MapTiler map
    stayMarkers.forEach((marker, id) => {
      const el = marker.getElement();
      if (el) {
        const isThis = (key === 'heritage' && id === 'volgo-homestay-first') ||
                       (key === 'eden' && id === 'volgo-villa-eden-beach');
        el.classList.toggle('hot', isThis);
      }
    });

    // Update stay-cards below map
    document.querySelectorAll('.stay-card').forEach(card => {
      card.classList.toggle('selected', card.dataset.pin === key);
    });

    // Update dock cards in fullscreen mode
    document.querySelectorAll('.mf-dock-card').forEach(card => {
      card.classList.toggle('active', card.dataset.stay === stay.id);
    });
  }

  function render3dRealMarkers() {
    if (!staysMap) return;
    stayMarkers.forEach(m => m.remove());
    stayMarkers.clear();

    STAYS_MAP_CATALOG.forEach(loc => {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'stay-map-pin' + (loc.pin === 'heritage' ? ' hot' : '');
      el.dataset.pin = loc.pin;
      el.dataset.id = loc.id;
      el.innerHTML = `
        <span class="stay-pin-ic">🏠</span>
        <span class="stay-pin-txt"><b>${loc.areaName}</b> · ₹${loc.price}</span>
      `;

      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const stay = homestays.find(s => s.id === loc.id) || homestays[0];
        if (stay) {
          loadHomestay(stay, { userClicked: true });
          updateVectorMapSelection(stay);
          if (staysMap) {
            const isEden = loc.pin === 'eden';
            staysMap.flyTo({
              center: isEden ? [79.818, 11.895] : loc.lngLat,
              zoom: isEden ? 13.5 : 14.2,
              duration: 700
            });
          }
          openStayGlassModal(loc, 0);
        }
      });

      const MarkerClass = window.maptilersdk?.Marker || window.maplibregl?.Marker;
      const m = new MarkerClass({
        element: el,
        anchor: 'bottom'
      })
        .setLngLat(loc.lngLat)
        .addTo(staysMap);

      stayMarkers.set(loc.id, m);
    });
  }

  // Mobile double-tap map interaction handler: only double-tap moves map in mobile view
  function setupMobileDoubleTapMapControl(mapInstance, mapContainer, frameContainer) {
    if (!mapInstance || !mapContainer) return;

    const isMobile = () => window.innerWidth <= 900;
    const target = frameContainer || mapContainer;

    let badge = target.querySelector('.mobile-map-lock-badge');
    if (!badge) {
      badge = document.createElement('div');
      badge.className = 'mobile-map-lock-badge';
      badge.setAttribute('role', 'status');
      badge.innerHTML = '<span class="mmlb-icon">👆</span><span class="mmlb-text">Double tap to move map</span>';
      target.appendChild(badge);
    }

    let isUnlocked = false;
    let unlockTimer = null;
    let lastTapTime = 0;

    function updateTouchAction() {
      try {
        const canvas = mapInstance.getCanvas();
        if (canvas) {
          if (isMobile()) {
            canvas.style.touchAction = isUnlocked ? 'none' : 'pan-y';
          } else {
            canvas.style.touchAction = 'none';
          }
        }
      } catch (e) {}
    }

    function unlock() {
      isUnlocked = true;
      try {
        mapInstance.dragPan.enable();
        mapInstance.touchZoomRotate.enable();
        mapInstance.doubleClickZoom.disable();
      } catch (e) {}
      updateTouchAction();
      if (badge) {
        badge.classList.add('active');
        badge.innerHTML = '<span class="mmlb-icon">🗺️</span><span class="mmlb-text">Map active • Tap to lock</span>';
      }
      resetAutoLock();
    }

    function lock() {
      if (!isMobile()) return;
      isUnlocked = false;
      try {
        mapInstance.dragPan.disable();
        mapInstance.touchZoomRotate.disable();
        mapInstance.doubleClickZoom.disable();
      } catch (e) {}
      updateTouchAction();
      if (badge) {
        badge.classList.remove('active');
        badge.innerHTML = '<span class="mmlb-icon">👆</span><span class="mmlb-text">Double tap to move map</span>';
      }
      if (unlockTimer) {
        clearTimeout(unlockTimer);
        unlockTimer = null;
      }
    }

    function resetAutoLock() {
      if (unlockTimer) clearTimeout(unlockTimer);
      unlockTimer = setTimeout(() => {
        lock();
      }, 7000);
    }

    function flashBadge() {
      if (badge && !isUnlocked) {
        badge.classList.add('flash');
        setTimeout(() => badge.classList.remove('flash'), 350);
      }
    }

    function syncViewport() {
      if (isMobile()) {
        lock();
      } else {
        isUnlocked = true;
        try {
          mapInstance.dragPan.enable();
          mapInstance.touchZoomRotate.enable();
          mapInstance.doubleClickZoom.enable();
        } catch (e) {}
        updateTouchAction();
        if (badge) {
          badge.classList.remove('active');
        }
      }
    }

    target.addEventListener('touchstart', (e) => {
      if (!isMobile()) return;

      if (e.target.closest('.stay-map-pin, .ctrl-btn, .mobile-map-lock-badge, .mgb-btn, .maptiler-stay-marker, button')) {
        return;
      }

      if (e.touches && e.touches.length >= 2) {
        unlock();
        return;
      }

      const now = Date.now();
      const diff = now - lastTapTime;

      if (diff < 360 && diff > 30) {
        lastTapTime = 0;
        unlock();
      } else {
        lastTapTime = now;
        if (!isUnlocked) {
          flashBadge();
        } else {
          resetAutoLock();
        }
      }
    }, { passive: true });

    target.addEventListener('touchmove', () => {
      if (!isMobile()) return;
      if (isUnlocked) {
        resetAutoLock();
      }
    }, { passive: true });

    if (badge) {
      badge.addEventListener('click', (e) => {
        e.stopPropagation();
        if (isUnlocked) lock();
        else unlock();
      });
    }

    document.addEventListener('touchstart', (e) => {
      if (!isMobile() || !isUnlocked) return;
      if (!target.contains(e.target)) {
        lock();
      }
    }, { passive: true });

    window.addEventListener('resize', syncViewport);

    mapInstance.on('load', () => {
      syncViewport();
    });
    syncViewport();
  }

  function initStaysMap() {
    const container = document.getElementById('staysMap');
    if (!container || typeof window.maptilersdk === 'undefined' || staysMap) return;

    try {
      window.maptilersdk.config.apiKey = MAPTILER_API_KEY;
      staysMap = new window.maptilersdk.Map({
        container: 'staysMap',
        style: window.maptilersdk.MapStyle.STREETS,
        center: PONDY_REAL_CENTER,
        zoom: 12.0,
        pitch: 0,
        bearing: 0,
        maxPitch: 65,
        minZoom: 10.5,
        maxZoom: 18.0,
        dragPan: true,
        scrollZoom: false,
        navigationControl: false,
        geolocateControl: false,
        attributionControl: { compact: true }
      });
      window.staysMap = staysMap;
      setupMobileDoubleTapMapControl(staysMap, container, document.getElementById('staysMapFrame'));

      function initSeaWaves() {
        if (!staysMap || staysMap.getSource('sea-waves-source')) return;

        // Coast-parallel wave contours (Shore, Mid, Outer) along Bay of Bengal
        const shoreWave = [
          [79.8385, 11.965], [79.8375, 11.948], [79.8362, 11.932],
          [79.8335, 11.915], [79.8275, 11.895], [79.8220, 11.880], [79.8180, 11.865]
        ];
        const midWave = [
          [79.8430, 11.965], [79.8420, 11.948], [79.8405, 11.932],
          [79.8380, 11.915], [79.8320, 11.895], [79.8265, 11.880], [79.8225, 11.865]
        ];
        const outerWave = [
          [79.8475, 11.965], [79.8465, 11.948], [79.8450, 11.932],
          [79.8425, 11.915], [79.8365, 11.895], [79.8310, 11.880], [79.8270, 11.865]
        ];

        staysMap.addSource('sea-waves-source', {
          type: 'geojson',
          data: {
            type: 'FeatureCollection',
            features: [
              { type: 'Feature', properties: { wave: 'shore' }, geometry: { type: 'LineString', coordinates: shoreWave } },
              { type: 'Feature', properties: { wave: 'mid' }, geometry: { type: 'LineString', coordinates: midWave } },
              { type: 'Feature', properties: { wave: 'outer' }, geometry: { type: 'LineString', coordinates: outerWave } }
            ]
          }
        });

        // Soft cyan/blue ocean glow under waves
        staysMap.addLayer({
          id: 'sea-waves-glow',
          type: 'line',
          source: 'sea-waves-source',
          paint: {
            'line-color': '#38bdf8',
            'line-width': 5,
            'line-opacity': 0.4,
            'line-blur': 3
          }
        });

        // Crisp white wave foam crests
        staysMap.addLayer({
          id: 'sea-waves-crests',
          type: 'line',
          source: 'sea-waves-source',
          paint: {
            'line-color': '#ffffff',
            'line-width': 2.2,
            'line-opacity': 0.85,
            'line-dasharray': [3, 4]
          }
        });

        // Normal gentle rolling sea wave animation
        let waveCycle = 0;
        const wavePatterns = [
          [0.2, 4, 2.8, 4],
          [0.8, 4, 2.2, 4],
          [1.5, 4, 1.5, 4],
          [2.2, 4, 0.8, 4],
          [2.8, 4, 0.2, 4],
          [3.5, 4, 0.0, 4.5]
        ];

        if (window.seaWaveInterval) clearInterval(window.seaWaveInterval);
        window.seaWaveInterval = setInterval(() => {
          if (!staysMap || !staysMap.getLayer('sea-waves-crests')) return;
          waveCycle = (waveCycle + 1) % wavePatterns.length;
          staysMap.setPaintProperty('sea-waves-crests', 'line-dasharray', wavePatterns[waveCycle]);
          const tideAlpha = 0.55 + 0.3 * Math.sin(waveCycle * (Math.PI / 3));
          staysMap.setPaintProperty('sea-waves-crests', 'line-opacity', tideAlpha);
        }, 150);


      }

      function fitAllStaysView(animate = true, closePopup = true) {
        if (!staysMap) return;
        if (closePopup) {
          closeStayGlassModal(true);
        }

        // Bounds enclosing all 3 stays in Pondicherry
        const bounds = [
          [79.800, 11.885],
          [79.845, 11.945]
        ];

        if (animate) {
          staysMap.fitBounds(bounds, {
            padding: { top: 70, bottom: 70, left: 55, right: 55 },
            maxZoom: 13.5,
            duration: 700
          });
        } else {
          staysMap.fitBounds(bounds, {
            padding: { top: 70, bottom: 70, left: 55, right: 55 },
            maxZoom: 13.5
          });
        }
      }

      staysMap.on('load', () => {
        mapReady = true;
        render3dRealMarkers();
        initSeaWaves();
        fitAllStaysView(false);
      });

      toggleMapFullscreen = function(forceState) {
        if (!staysMap) return;
        const frame = document.getElementById('staysMapFrame');
        const btnText = document.getElementById('btnResetViewText');
        const dock = document.getElementById('mapFsDock');
        if (!frame) return;

        isMapFullscreen = typeof forceState === 'boolean' ? forceState : !isMapFullscreen;

        if (isMapFullscreen) {
          frame.classList.add('is-fullscreen');
          document.body.classList.add('map-fullscreen-active');
          if (btnText) btnText.textContent = 'Exit Full View';
          if (dock) dock.style.display = 'flex';
          const svg = btnReset?.querySelector('svg');
          if (svg) svg.innerHTML = '<path d="M18 6L6 18M6 6l12 12"/>';

          closeStayGlassModal(true);

          setTimeout(() => {
            if (staysMap) {
              staysMap.resize();
              fitAllStaysView(true, true);
            }
          }, 120);
        } else {
          frame.classList.remove('is-fullscreen');
          document.body.classList.remove('map-fullscreen-active');
          if (btnText) btnText.textContent = 'Full View';
          if (dock) dock.style.display = 'none';
          const svg = btnReset?.querySelector('svg');
          if (svg) svg.innerHTML = '<path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/>';
          closeStayGlassModal(true);
          setTimeout(() => {
            if (staysMap) {
              staysMap.resize();
              fitAllStaysView(true, true);
            }
          }, 120);
        }
      };

      const btnReset = document.getElementById('btnResetView');
      if (btnReset) {
        btnReset.onclick = () => {
          toggleMapFullscreen();
        };
      }

      // 3D View Toggle Control
      const btn3d = document.getElementById('btn3dToggle');
      const txt3d = document.getElementById('btn3dText');
      if (btn3d) {
        btn3d.onclick = () => {
          if (!staysMap) return;
          staysMap.stop();
          const is3d = staysMap.getPitch() > 20;
          if (is3d) {
            staysMap.easeTo({ pitch: 0, bearing: 0, duration: 550 });
            btn3d.classList.remove('active');
            if (txt3d) txt3d.textContent = '3D View';
          } else {
            staysMap.easeTo({ pitch: 52, bearing: -14, duration: 650 });
            btn3d.classList.add('active');
            if (txt3d) txt3d.textContent = '2D View';
          }
        };

        if (staysMap) {
          staysMap.on('pitch', () => {
            const is3d = staysMap.getPitch() > 20;
            if (is3d) {
              btn3d.classList.add('active');
              if (txt3d) txt3d.textContent = '2D View';
            } else {
              btn3d.classList.remove('active');
              if (txt3d) txt3d.textContent = '3D View';
            }
          });
        }
      }

      // Zoom In & Out Controls
      const btnZoomIn = document.getElementById('btnZoomIn');
      if (btnZoomIn) {
        btnZoomIn.onclick = () => {
          if (staysMap) staysMap.zoomIn({ duration: 250 });
        };
      }

      const btnZoomOut = document.getElementById('btnZoomOut');
      if (btnZoomOut) {
        btnZoomOut.onclick = () => {
          if (staysMap) staysMap.zoomOut({ duration: 250 });
        };
      }

      // Wire dock cards in fullscreen mode
      document.querySelectorAll('.mf-dock-card').forEach(dockCard => {
        dockCard.addEventListener('click', () => {
          const stayId = dockCard.dataset.stay;
          const stay = homestays.find(s => s.id === stayId) || homestays[0];
          const catalogStay = STAYS_MAP_CATALOG.find(c => c.id === stayId);
          if (stay && catalogStay && staysMap) {
            document.querySelectorAll('.mf-dock-card').forEach(c => c.classList.remove('active'));
            dockCard.classList.add('active');
            loadHomestay(stay, { userClicked: true });
            updateVectorMapSelection(stay);
            const isEden = catalogStay.pin === 'eden';
            const curPitch = staysMap.getPitch();
            const curBearing = staysMap.getBearing();
            staysMap.flyTo({
              center: isEden ? [79.818, 11.895] : catalogStay.lngLat,
              zoom: isEden ? 13.5 : 14.2,
              pitch: curPitch,
              bearing: curBearing,
              duration: 700
            });
            openStayGlassModal(catalogStay, 0);
          }
        });
      });

      // Close modal button
      const closeBtn = document.getElementById('closeStayGlassModal');
      if (closeBtn) closeBtn.onclick = () => closeStayGlassModal(true);

      // Overlay backdrop click closes modal
      const modalOverlay = document.getElementById('stayGlassModal');
      if (modalOverlay) {
        modalOverlay.onclick = (e) => {
          if (e.target === modalOverlay) closeStayGlassModal(true);
        };
      }

      // Escape key closes modal & exits fullscreen map
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          closeStayGlassModal(true);
          if (isMapFullscreen) toggleMapFullscreen(false);
        }
      });

      // Connect stay-cards below the map - ONLY place that triggers proximity popup
      document.querySelectorAll('.stay-card').forEach(card => {
        card.addEventListener('click', () => {
          const id = card.dataset.id;
          const stay = homestays.find(s => s.id === id) || homestays[0];
          if (stay) {
            loadHomestay(stay, { userClicked: true });
            updateVectorMapSelection(stay);
            const catalogStay = STAYS_MAP_CATALOG.find(c => c.id === stay.id) || STAYS_MAP_CATALOG[0];
            if (staysMap && catalogStay) {
              const isEden = catalogStay.pin === 'eden';
              staysMap.flyTo({
                center: isEden ? [79.818, 11.895] : catalogStay.lngLat,
                zoom: isEden ? 13.5 : 14.2,
                duration: 700
              });
            }
            openStayGlassModal(catalogStay, 0);
          }
        });
      });
    } catch (err) {
      console.warn('Map initialization failed:', err);
    }
  }

  function startMapWhenReady() {
    if (typeof window.maptilersdk !== 'undefined') {
      initStaysMap();
    } else {
      let attempts = 0;
      const checkSdk = setInterval(() => {
        attempts++;
        if (typeof window.maptilersdk !== 'undefined') {
          clearInterval(checkSdk);
          initStaysMap();
        } else if (attempts > 50) {
          clearInterval(checkSdk);
        }
      }, 35);
    }
  }

  // Launch map immediately on DOM ready for zero-delay display
  startMapWhenReady();

  function showNearbyPlaces(stay, fly = true, popupOpen = false) {
    // Only show the 3 stays and the walkable beach route (no nearby clutter as requested)
    updateVectorMapSelection(stay);
  }

  /** Clickable chips under the map (also the fallback if the map can't load). */
  function renderStayChips() {
    const list = document.getElementById('staysMapList');
    if (!list) return;
    list.innerHTML = '';
    homestays.forEach(stay => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'stay-chip' + (currentHomestay?.id === stay.id ? ' active' : '');
      btn.dataset.id = stay.id;
      const from = Rules.fromPrice(stay);
      btn.innerHTML = `<span class="stay-chip-name">${esc(stay.name)}</span><span class="stay-chip-meta">${esc(stay.areaName || stay.city || '')}${from ? ` · from ${inr(from)}` : ''}</span>`;
      btn.addEventListener('click', () => {
        const marker = stayMarkers.get(stay.id);
        // Opening the pin's pop-up also selects the stay (and leaves room for the pop-up)
        if (marker && !marker.getPopup().isOpen()) marker.togglePopup();
        else loadHomestay(stay);
      });
      list.appendChild(btn);
    });
  }

  function showTab(name) {
    document.querySelector(`.nav-tab[data-tab="${name}"]`)?.click();
  }

  // --- Vanilla BorderGlow Port ---
  function initBorderGlow() {
    const card = document.getElementById('overviewCard');
    if (!card) return;

    function getCenterOfElement(el) {
      const rect = el.getBoundingClientRect();
      return [rect.width / 2, rect.height / 2];
    }

    function getEdgeProximity(el, x, y) {
      const [cx, cy] = getCenterOfElement(el);
      const dx = x - cx;
      const dy = y - cy;
      let kx = Infinity;
      let ky = Infinity;
      if (dx !== 0) kx = cx / Math.abs(dx);
      if (dy !== 0) ky = cy / Math.abs(dy);
      return Math.min(Math.max(1 / Math.min(kx, ky), 0), 1);
    }

    function getCursorAngle(el, x, y) {
      const [cx, cy] = getCenterOfElement(el);
      const dx = x - cx;
      const dy = y - cy;
      if (dx === 0 && dy === 0) return 0;
      const radians = Math.atan2(dy, dx);
      let degrees = radians * (180 / Math.PI) + 90;
      if (degrees < 0) degrees += 360;
      return degrees;
    }

    let ticking = false;
    card.addEventListener('pointermove', (e) => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        const rect = card.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        const edge = getEdgeProximity(card, x, y);
        const angle = getCursorAngle(card, x, y);

        card.style.setProperty('--edge-proximity', `${(edge * 100).toFixed(1)}`);
        card.style.setProperty('--cursor-angle', `${angle.toFixed(1)}deg`);
        ticking = false;
      });
    });
    
    // Trigger initial state
    card.style.setProperty('--edge-proximity', '0');
    card.style.setProperty('--cursor-angle', '45deg');
  }
  
  initBorderGlow();

  // Instant hydration from local cache for 0ms seamless paint on refresh:
  const CACHE_KEY_HOMESTAYS = 'volgo_cached_homestays';
  const CACHE_KEY_SETTINGS = 'volgo_cached_settings';

  let hydratedFromCache = false;
  try {
    const rawStays = localStorage.getItem(CACHE_KEY_HOMESTAYS);
    const rawSettings = localStorage.getItem(CACHE_KEY_SETTINGS);
    if (rawStays) {
      const cachedStays = JSON.parse(rawStays);
      if (Array.isArray(cachedStays) && cachedStays.length) {
        homestays = cachedStays;
        if (rawSettings) {
          siteSettings = { contact: {}, backgroundImages: [], ...JSON.parse(rawSettings) };
          applySiteSettings();
        }
        const wanted = new URLSearchParams(location.search).get('stay');
        const first = homestays.find(h => h.id === wanted) || homestays[0];
        initStaysMap();
        loadHomestay(first);
        setupAreaSwitcher();
        renderStayChips();
        hydratedFromCache = true;
      }
    }
  } catch (e) {
    console.warn('Cache hydration skipped:', e);
  }

  // Load site settings (contact number & background images) and the stays together from server.
  Promise.all([
    fetch('/api/site-settings').then(r => (r.ok ? r.json() : {})).catch(() => ({})),
    fetch('/api/homestays').then(res => res.json())
  ])
    .then(([settings, data]) => {
      siteSettings = { contact: {}, backgroundImages: [], ...settings };
      applySiteSettings();
      const freshStays = Array.isArray(data) ? data : [];
      const mainLayout = document.querySelector('.viewport-layout');
      if (!freshStays.length) {
        homestays = [];
        try { localStorage.removeItem(CACHE_KEY_HOMESTAYS); } catch (_) {}
        if (mainLayout) mainLayout.style.display = 'none';
        return;
      }
      if (mainLayout) mainLayout.style.display = '';

      try {
        localStorage.setItem(CACHE_KEY_SETTINGS, JSON.stringify(settings));
        localStorage.setItem(CACHE_KEY_HOMESTAYS, JSON.stringify(freshStays));
      } catch (_) {}

      const staysChanged = JSON.stringify(homestays) !== JSON.stringify(freshStays);
      homestays = freshStays;

      if (!hydratedFromCache || staysChanged) {
        // ?stay=<id> opens a particular stay (handy for sharing a link)
        const wanted = new URLSearchParams(location.search).get('stay');
        const first = homestays.find(h => h.id === wanted) || homestays[0];
        initStaysMap();
        loadHomestay(first);
        setupAreaSwitcher();
        renderStayChips();
      }
    })
    .catch(err => console.error("Error loading homestay data:", err));

  // Auto-sync live admin changes (pricing, settings, stays) every 15s and on tab focus
  async function syncLiveUpdates() {
    if (document.hidden) return;
    try {
      const [settingsRes, staysRes] = await Promise.all([
        fetch('/api/site-settings', { cache: 'no-store' }).then(r => (r.ok ? r.json() : null)).catch(() => null),
        fetch('/api/homestays', { cache: 'no-store' }).then(r => (r.ok ? r.json() : null)).catch(() => null)
      ]);
      if (settingsRes && JSON.stringify(siteSettings) !== JSON.stringify({ contact: {}, backgroundImages: [], ...settingsRes })) {
        siteSettings = { contact: {}, backgroundImages: [], ...settingsRes };
        applySiteSettings();
        try { localStorage.setItem(CACHE_KEY_SETTINGS, JSON.stringify(settingsRes)); } catch (_) {}
      }
      if (Array.isArray(staysRes) && JSON.stringify(homestays) !== JSON.stringify(staysRes)) {
        homestays = staysRes;
        const mainLayout = document.querySelector('.viewport-layout');
        if (!staysRes.length) {
          try { localStorage.removeItem(CACHE_KEY_HOMESTAYS); } catch (_) {}
          if (mainLayout) mainLayout.style.display = 'none';
        } else {
          if (mainLayout) mainLayout.style.display = '';
          try { localStorage.setItem(CACHE_KEY_HOMESTAYS, JSON.stringify(staysRes)); } catch (_) {}
          const currentId = window.selectedStayId || homestays[0]?.id;
          const activeStay = homestays.find(h => h.id === currentId) || homestays[0];
          if (activeStay) loadHomestay(activeStay);
          renderStayChips();
        }
      }
    } catch (_) {}
  }
  setInterval(syncLiveUpdates, 15000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) syncLiveUpdates(); });

  function applySiteSettings() {
    const phone = siteSettings.contact?.phone;
    const headerContact = document.getElementById('headerContact');
    if (headerContact && phone) {
      headerContact.href = `tel:${phone.replace(/[^+\d]/g, '')}`;
      document.getElementById('headerContactText').textContent = phone;
    }
    const wa = siteSettings.contact?.whatsapp || phone || '919500508790';
    const waHref = `https://wa.me/${wa.replace(/[^0-9]/g, '')}?text=${encodeURIComponent('Hi VolGO Stays, I would like to enquire about a homestay booking.')}`;
    const floatingWa = document.getElementById('floatingWhatsappBtn');
    if (floatingWa) floatingWa.href = waHref;
    const headerWa = document.getElementById('headerWhatsapp');
    if (headerWa) headerWa.href = waHref;

    updateBackgroundSlideshow(siteSettings.backgroundImages);
  }

  /** Seamless rotating background canvas from admin images */
  function updateBackgroundSlideshow(images) {
    const container = document.getElementById('app-background');
    if (!container) return;

    if (bgSlideshowTimer) {
      clearInterval(bgSlideshowTimer);
      bgSlideshowTimer = null;
    }

    const list = Array.isArray(images) ? images.filter(Boolean) : [];
    if (!list.length) {
      container.classList.remove('has-slides');
      container.innerHTML = '';
      return;
    }

    container.classList.add('has-slides');
    container.innerHTML = '';

    // Create slides with smooth opacity transitions
    const slideEls = list.map((src, idx) => {
      const slide = document.createElement('div');
      slide.className = 'bg-slide' + (idx === 0 ? ' active' : '');
      const cleanSrc = (/^(https?:)?\//.test(src) ? src : '/' + src);
      slide.style.backgroundImage = `url('${cleanSrc}')`;
      container.appendChild(slide);
      return slide;
    });

    // Add luxury ambient gradient overlay on top of rotating slides
    const overlay = document.createElement('div');
    overlay.className = 'page-bg-overlay';
    container.appendChild(overlay);

    if (slideEls.length > 1) {
      bgSlideIndex = 0;
      bgSlideshowTimer = setInterval(() => {
        slideEls[bgSlideIndex].classList.remove('active');
        bgSlideIndex = (bgSlideIndex + 1) % slideEls.length;
        slideEls[bgSlideIndex].classList.add('active');
      }, 6000);
    }
  }

  /** A stay's own contact details, falling back to the website's. */
  function contactFor(stay) {
    const c = siteSettings.contact || {};
    return {
      phone: stay.phone || c.phone || '',
      whatsapp: stay.whatsapp || c.whatsapp || stay.phone || c.phone || '',
      email: stay.email || c.email || ''
    };
  }

  // Switch tabs
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const targetTab = tab.dataset.tab;
      
      // Update buttons
      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      
      // Update panels
      tabPanes.forEach(pane => {
        pane.classList.remove('active');
        if (pane.id === `tab-${targetTab}`) {
          pane.classList.add('active');
        }
      });
      

      // Dispatch resize event to recalculate layout for newly visible elements (e.g. gallery carousels, maps)
      setTimeout(() => {
        window.dispatchEvent(new Event('resize'));
        if (targetTab === 'contact') {
          if (!stayMap && currentHomestay) {
            initStayMap(currentHomestay);
          } else if (stayMap) {
            stayMap.resize();
            if (currentHomestay) {
              const lat = currentHomestay.coordinates?.lat || 11.9348;
              const lng = currentHomestay.coordinates?.lng || 79.8298;
              stayMap.setCenter([lng, lat]);
            }
          }
        }
      }, 60);

      setTimeout(() => {
        if (targetTab === 'contact' && stayMap) {
          stayMap.resize();
        }
      }, 250);
    });
  });

  // Stay pickers: the Pondicherry list in the booking form and the Overview tab buttons
  let areaSwitcherWired = false;
  function setupAreaSwitcher() {
    const pStaysList = document.getElementById('pondicherryStaysList');
    const overviewContainer = document.getElementById('overviewAreaOptions');
    const toggleBtn = document.getElementById('pondicherryToggleBtn');
    const card = document.getElementById('pondicherryLocationCard');

    if (!homestays || homestays.length === 0) return;

    if (pStaysList) pStaysList.innerHTML = '';
    if (overviewContainer) overviewContainer.innerHTML = '';

    const pPill = document.getElementById('pondicherryCountPill');
    if (pPill) pPill.textContent = `${homestays.length} ${homestays.length === 1 ? 'Stay' : 'Stays'}`;

    homestays.forEach(homestay => {
      const isSelected = currentHomestay && currentHomestay.id === homestay.id;
      const thumbImg = imgUrl(homestay.thumbnail || stayPhotos(homestay)[0] || 'assets/bg-optimized/bg-1.webp');
      const isDummy = Boolean(homestay.isDummy);
      const areaLabel = homestay.areaName || homestay.name;
      const from = Rules.fromPrice(homestay);
      const roomsMode = Rules.hasRooms(homestay);

      if (pStaysList) {
        const item = document.createElement('button');
        item.className = `p-stay-item ${isSelected ? 'active' : ''}`;
        item.setAttribute('type', 'button');
        item.setAttribute('data-id', homestay.id);
        item.innerHTML = `
          <div class="p-stay-thumb">
            <img src="${esc(thumbImg)}" alt="" loading="lazy">
          </div>
          <div class="p-stay-details">
            <div class="p-stay-top-line">
              <span class="p-stay-title">${esc(homestay.name)}</span>
            </div>
            <div class="p-stay-label-below">
              ${esc(areaLabel)} • ${Number(homestay.bedrooms) || 1} Bed • ${Number(homestay.bathrooms) || 1} Bath${homestay.area ? ' • ' + esc(homestay.area) : ''}
            </div>
            <div class="p-stay-price-line">
              ${from ? `<span style="font-size:11px; opacity:0.8;">${roomsMode ? 'rooms from' : 'from'}</span> <span class="p-price">${inr(from)}</span> <span style="font-size:11px; opacity:0.8;">/ night</span>` : ''}
            </div>
          </div>
          <div class="p-stay-radio">
            <span class="material-symbols-outlined check-icon">check_circle</span>
          </div>
        `;
        item.addEventListener('click', (e) => {
          e.stopPropagation();
          loadHomestay(homestay);
          if (card && toggleBtn) {
            card.classList.remove('open');
            toggleBtn.setAttribute('aria-expanded', 'false');
          }
        });
        pStaysList.appendChild(item);
      }

      if (overviewContainer) {
        const btn = document.createElement('button');
        btn.className = `overview-area-btn ${isSelected ? 'active' : ''}`;
        btn.setAttribute('type', 'button');
        btn.setAttribute('data-id', homestay.id);
        btn.innerHTML = `
          <span class="btn-area-name">${esc(areaLabel)}</span>
          <span class="btn-area-meta">${esc(homestay.area || (roomsMode ? `${homestay.bedrooms} BHK` : ''))}</span>
        `;
        btn.addEventListener('click', () => loadHomestay(homestay));
        overviewContainer.appendChild(btn);
      }
    });

    // Toggle Pondicherry stays panel (wire once)
    if (toggleBtn && card && !areaSwitcherWired) {
      areaSwitcherWired = true;
      toggleBtn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        const isOpen = card.classList.toggle('open');
        toggleBtn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
      };

      document.addEventListener('click', (e) => {
        if (!card.contains(e.target)) {
          card.classList.remove('open');
          toggleBtn.setAttribute('aria-expanded', 'false');
        }
      });

      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          card.classList.remove('open');
          toggleBtn.setAttribute('aria-expanded', 'false');
        }
      });
    }
  }

  function updateAreaSwitcherActiveState(selectedId) {
    const homestay = homestays.find(h => h.id === selectedId);
    if (!homestay) return;
    const isDummy = Boolean(homestay.isDummy);
    const areaLabel = homestay.areaName || homestay.name;

    // Reflect Stay Name in Location Header Button
    const stayNameHeader = document.getElementById('selectedStayHeaderName');
    const stayAreaHeader = document.getElementById('selectedStayHeaderArea');
    if (stayNameHeader) stayNameHeader.textContent = homestay.name;
    if (stayAreaHeader) stayAreaHeader.textContent = `${areaLabel}, Pondicherry`;

    // Update Left Side Hero Cards
    document.querySelectorAll('.area-card').forEach(c => {
      const matches = c.getAttribute('data-id') === selectedId;
      c.classList.toggle('active', matches);
      const badge = c.querySelector('.area-card-badge');
      if (badge) {
        const dummyBadge = badge.classList.contains('dummy-badge');
        if (matches) badge.textContent = dummyBadge ? 'Active Dummy' : 'Selected';
        else badge.textContent = dummyBadge ? 'Dummy Area' : 'Explore';
      }
    });

    // Update stay chips under the map
    document.querySelectorAll('.stay-chip').forEach(c => c.classList.toggle('active', c.dataset.id === selectedId));

    // Update Pondicherry Stays List Items
    document.querySelectorAll('.p-stay-item').forEach(item => {
      const matches = item.getAttribute('data-id') === selectedId;
      item.classList.toggle('active', matches);
    });

    // Update Overview Tab Buttons
    document.querySelectorAll('.overview-area-btn').forEach(b => {
      b.classList.toggle('active', b.getAttribute('data-id') === selectedId);
    });

    // Update hidden booking location input for WhatsApp / booking payload
    const bookingLocation = document.getElementById('bookingLocation');
    if (bookingLocation) {
      bookingLocation.value = `${areaLabel}, Pondicherry`;
    }
  }

  // Load selected homestay details
  function loadHomestay(homestay, opts = {}) {
    const switching = !currentHomestay || currentHomestay.id !== homestay.id;
    currentHomestay = homestay;
    if (switching) bookingSelection = { type: 'whole' };

    document.title = `${homestay.name} | VolGO Stays Pondicherry`;
    const contact = contactFor(homestay);

    // Dynamic WhatsApp Owner link for the selected stay
    const waNum = (contact.whatsapp || contact.phone || '919500508790').replace(/[^0-9]/g, '');
    const waText = encodeURIComponent(`Hi, I am interested in booking ${homestay.name} in Pondicherry. Could you share details & availability?`);
    const waHref = `https://wa.me/${waNum}?text=${waText}`;

    const floatingWa = document.getElementById('floatingWhatsappBtn');
    if (floatingWa) floatingWa.href = waHref;

    const headerWa = document.getElementById('headerWhatsapp');
    if (headerWa) headerWa.href = waHref;

    // Reflect stay name in Location header
    const stayNameHeader = document.getElementById('selectedStayHeaderName');
    const stayAreaHeader = document.getElementById('selectedStayHeaderArea');
    if (stayNameHeader) stayNameHeader.textContent = homestay.name;
    if (stayAreaHeader) stayAreaHeader.textContent = `${homestay.areaName || homestay.city || 'Pondicherry'}, Pondicherry`;

    // Morning breakfast is ONLY for Ariyankuppam stay
    const isAriyankuppam = (homestay.areaName || '').toLowerCase().includes('ariyan') || 
                           (homestay.id || '').includes('eden') || 
                           (homestay.name || '').toLowerCase().includes('eden') ||
                           (homestay.location || '').toLowerCase().includes('ariyan');
    const breakfastGroup = document.getElementById('breakfastOptionGroup');
    const breakfastInput = document.getElementById('includeBreakfast');
    if (breakfastGroup) {
      breakfastGroup.style.display = isAriyankuppam ? 'block' : 'none';
      if (!isAriyankuppam && breakfastInput) {
        breakfastInput.checked = false;
      }
    }

    // Overview tab details
    if (overviewTitle) overviewTitle.textContent = homestay.name;
    if (specGuests) specGuests.textContent = `Up to ${homestay.capacity} Guests`;
    if (specBedrooms) specBedrooms.textContent = `${homestay.bedrooms} Bedroom${Number(homestay.bedrooms) === 1 ? '' : 's'}`;
    if (specBathrooms) specBathrooms.textContent = `${homestay.bathrooms} Bath${Number(homestay.bathrooms) === 1 ? '' : 's'}`;
    if (specArea) {
      specArea.textContent = homestay.area || '';
      const item = specArea.closest('.spec-item');
      if (item) {
        item.hidden = !homestay.area;
        if (item.previousElementSibling?.classList.contains('spec-divider')) item.previousElementSibling.hidden = !homestay.area;
      }
    }
    if (propertyDesc) {
      // Plain text from the admin panel; blank lines start new paragraphs.
      propertyDesc.innerHTML = String(homestay.description || '')
        .split(/\n\s*\n/).map(p => p.trim()).filter(Boolean)
        .map(p => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('');
    }
    renderVillaLayout(homestay);

    if (bookingLocation) {
      bookingLocation.value = `${homestay.areaName || homestay.name}, ${homestay.city || 'Pondicherry'}`;
    }

    // Static consistent resort sunset background (no dynamic photo switching across stays)

    updateAreaSwitcherActiveState(homestay.id);
    updateVectorMapSelection(homestay);
    if (staysMap) {
      showNearbyPlaces(homestay, true, Boolean(opts.fromMap), Boolean(opts.fromMap || opts.userClicked));
    }

    // Amenities
    amenitiesGrid.innerHTML = '';
    (homestay.amenityCategories || []).forEach(category => {
      const catTitle = document.createElement('h4');
      catTitle.className = 'amenity-category-title';
      catTitle.textContent = category.category;
      amenitiesGrid.appendChild(catTitle);
      (category.items || []).forEach(amenity => {
        const box = document.createElement('div');
        box.classList.add('amenity-card');
        box.innerHTML = `
          <span class="material-symbols-outlined amenity-icon" aria-hidden="true">${esc(amenity.icon)}</span>
          <span class="amenity-name">${esc(amenity.name)}</span>
        `;
        amenitiesGrid.appendChild(box);
      });
    });
    const amenTitle = amenitiesGrid.previousElementSibling;
    if (amenTitle?.classList.contains('section-subtitle')) amenTitle.hidden = !(homestay.amenityCategories || []).length;

    // Gallery
    galleryGrid.innerHTML = '';
    homestay.images = [];
    let globalIndex = 0;
    (homestay.imageCategories || []).filter(c => (c.images || []).length).forEach(category => {
      const catTitle = document.createElement('h4');
      catTitle.className = 'amenity-category-title';
      catTitle.textContent = category.category;
      galleryGrid.appendChild(catTitle);

      const carouselWrapper = document.createElement('div');
      carouselWrapper.className = 'gallery-carousel-wrapper';
      carouselWrapper.style.gridColumn = '1 / -1';

      const prevBtn = document.createElement('button');
      prevBtn.className = 'gallery-nav-btn prev';
      prevBtn.setAttribute('aria-label', 'Previous photos');
      prevBtn.innerHTML = '<span class="material-symbols-outlined">chevron_left</span>';
      const nextBtn = document.createElement('button');
      nextBtn.className = 'gallery-nav-btn next';
      nextBtn.setAttribute('aria-label', 'More photos');
      nextBtn.innerHTML = '<span class="material-symbols-outlined">chevron_right</span>';

      const carousel = document.createElement('div');
      carousel.className = 'gallery-carousel';
      prevBtn.onclick = () => carousel.scrollBy({ left: -300, behavior: 'smooth' });
      nextBtn.onclick = () => carousel.scrollBy({ left: 300, behavior: 'smooth' });

      category.images.forEach(imgPath => {
        homestay.images.push(imgPath);
        const idx = globalIndex++;
        const wrapper = document.createElement('div');
        wrapper.classList.add('gallery-item');
        wrapper.innerHTML = `
          <img src="${esc(imgUrl(imgPath))}" alt="${esc(homestay.name)} – ${esc(category.category)}" loading="lazy">
          <div class="gallery-hover-overlay">
            <span class="material-symbols-outlined">zoom_in</span>
          </div>
        `;
        wrapper.addEventListener('click', () => openLightbox(idx));
        carousel.appendChild(wrapper);
      });

      const checkButtons = () => {
        const maxScrollLeft = carousel.scrollWidth - carousel.clientWidth;
        prevBtn.style.display = carousel.scrollLeft <= 0 ? 'none' : 'flex';
        nextBtn.style.display = carousel.scrollLeft >= maxScrollLeft - 1 ? 'none' : 'flex';
        if (carousel.scrollWidth <= carousel.clientWidth) {
          prevBtn.style.display = 'none';
          nextBtn.style.display = 'none';
        }
      };
      carousel.addEventListener('scroll', checkButtons, { passive: true });
      window.addEventListener('resize', checkButtons);

      carouselWrapper.append(prevBtn, carousel, nextBtn);
      galleryGrid.appendChild(carouselWrapper);
      requestAnimationFrame(() => setTimeout(checkButtons, 50));
    });
    if (!homestay.images.length) {
      galleryGrid.innerHTML = '<p class="empty-note">Photos coming soon.</p>';
    }

    // Contacts
    contactPhone.textContent = contact.phone;
    contactPhone.href = `tel:${contact.phone.replace(/[^+\d]/g, '')}`;
    contactWhatsapp.href = `https://wa.me/${contact.whatsapp.replace(/[^\d]/g, '')}`;
    contactEmail.textContent = contact.email;
    contactEmail.href = `mailto:${contact.email}`;
    contactLocation.textContent = homestay.location || '';
    renderHostDetails(homestay);
    initStayMap(homestay);

    // Booking: whole villa / rooms picker, rates, then availability
    renderUnitPicker();
    renderRates();
    refreshAvailability();

    // Reset guests
    if (switching) {
      bookingAdults = 2;
      bookingChildren = 0;
    }
    updateGuestLimit();

    const proceedContainer = document.getElementById('mobileProceedContainer');
    if (proceedContainer) proceedContainer.classList.remove('show');
  }

  /* ── Villa layout, host & house rules ─────────────────────────────── */
  function fillList(ul, items) {
    ul.innerHTML = '';
    (items || []).forEach(t => { const li = document.createElement('li'); li.textContent = t; ul.appendChild(li); });
  }

  function renderVillaLayout(stay) {
    const box = document.getElementById('villaLayout');
    if (!box) return;
    const roomsMode = Rules.hasRooms(stay);
    const hasLayout = (stay.layoutDetails || []).length > 0;
    box.hidden = !roomsMode && !hasLayout;
    if (box.hidden) return;

    const roomsEl = document.getElementById('villaRooms');
    roomsEl.innerHTML = roomsMode ? stay.rooms.map(r => `
      <div class="villa-room">
        <div class="villa-room-name">${esc(r.name)}</div>
        <div class="villa-room-meta">${esc(r.description || '')}${r.description ? ' · ' : ''}sleeps ${Number(r.capacity) || 2}</div>
        ${Number(r.price?.weekday) > 0 ? `<div class="villa-room-price">${inr(r.price.weekday)} <span>/ night, Sun–Thu</span></div>` : ''}
      </div>`).join('') + (Number(stay.pricing?.weekday) > 0 ? `
      <div class="villa-room villa-room-whole">
        <div class="villa-room-name">${esc(stay.wholeLabel || 'Whole villa')}</div>
        <div class="villa-room-meta">All ${stay.rooms.length} bedrooms · sleeps ${Number(stay.capacity) || ''}</div>
        <div class="villa-room-price">${inr(stay.pricing.weekday)} <span>/ night${Number(stay.pricing.weekend) && stay.pricing.weekend !== stay.pricing.weekday ? `, Fri & Sat ${inr(stay.pricing.weekend)}` : ''}</span></div>
      </div>` : '') : '';
    fillList(document.getElementById('villaLayoutList'), stay.layoutDetails);

    const note = document.getElementById('villaGuestNote');
    note.hidden = !roomsMode || !(stay.guestInstructions || []).length;
    fillList(document.getElementById('villaGuestNoteList'), stay.guestInstructions);
  }

  function renderHostDetails(stay) {
    const rulesCard = document.getElementById('houseRulesCard');
    const rules = stay.houseRules || [];
    if (rulesCard) {
      rulesCard.hidden = rules.length === 0;
      document.getElementById('houseRulesIntro').textContent =
        `Thank you for considering ${stay.name}${stay.location ? `, ${stay.location}` : ''}. A few things to know before you book:`;
      fillList(document.getElementById('houseRulesList'), rules);
    }
    const host = document.getElementById('hostSection');
    if (host) {
      host.hidden = !stay.hostName && !stay.hostBio;
      document.getElementById('hostName').textContent = stay.hostName ? `Hosted by ${stay.hostName}` : 'Your host';
      document.getElementById('hostBio').textContent = stay.hostBio || '';
    }
  }

  /* ── Whole villa or single rooms ──────────────────────────────────── */
  function renderUnitPicker() {
    const picker = document.getElementById('unitPicker');
    const optionsEl = document.getElementById('unitOptions');
    const ruleEl = document.getElementById('unitRule');
    if (!picker) return;
    const stay = currentHomestay;
    if (!Rules.hasRooms(stay)) { picker.hidden = true; return; }
    picker.hidden = false;
    bookingSelection = Rules.normalizeSelection(stay, bookingSelection);
    const sel = bookingSelection;

    const opt = (id, name, meta, price, checked, role) => `
      <button type="button" class="unit-option${checked ? ' selected' : ''}" data-unit="${esc(id)}" role="${role}" aria-checked="${checked}">
        <span class="unit-check material-symbols-outlined" aria-hidden="true">${checked ? 'check_circle' : 'radio_button_unchecked'}</span>
        <span class="unit-text"><span class="unit-name">${esc(name)}</span><span class="unit-meta">${esc(meta)}</span></span>
        ${price ? `<span class="unit-price">${inr(price)}</span>` : ''}
      </button>`;

    optionsEl.innerHTML =
      opt('whole', stay.wholeLabel || 'Whole villa', `All ${stay.rooms.length} bedrooms · up to ${stay.capacity} guests`, stay.pricing?.weekday, sel.type === 'whole', 'radio') +
      '<div class="unit-divider"><span>or single rooms</span></div>' +
      stay.rooms.map(r => opt(r.id, r.name, `${r.description ? r.description + ' · ' : ''}sleeps ${r.capacity}`,
        r.price?.weekday, sel.type === 'rooms' && sel.rooms.includes(r.id), 'checkbox')).join('');

    optionsEl.querySelectorAll('.unit-option').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.unit;
        if (id === 'whole') {
          bookingSelection = { type: 'whole' };
        } else {
          const rooms = bookingSelection.type === 'rooms' ? [...bookingSelection.rooms] : [];
          const i = rooms.indexOf(id);
          if (i >= 0) rooms.splice(i, 1); else rooms.push(id);
          bookingSelection = Rules.normalizeSelection(stay, { type: 'rooms', rooms });
        }
        renderUnitPicker();
        renderRates();
        applyAvailability();
        updateGuestLimit();
        if (window.updatePriceDisplay) window.updatePriceDisplay();
      });
    });

    ruleEl.textContent = Rules.roomsAllowedOnWeekends(stay)
      ? 'Single rooms can be booked any night. Booking the whole villa makes the single rooms unavailable for those dates, and the other way round.'
      : 'Friday & Saturday nights: whole villa only. Single rooms can be booked Sunday to Thursday nights.';
  }

  function renderRates() {
    const ratesDisplay = document.getElementById('bookingRatesDisplay');
    if (!ratesDisplay) return;
    const stay = currentHomestay;
    const sel = Rules.normalizeSelection(stay, bookingSelection);
    // Use the next weekday / weekend night so the banner reflects today's price period.
    const today = toDateStr(new Date());
    let wdNight = today, weNight = today;
    for (let i = 0; i < 7; i++) {
      const n = Rules.addDays(today, i);
      if (Rules.isWeekendNight(n)) { if (weNight === today) weNight = n; } else if (wdNight === today) wdNight = n;
    }
    const wd = Rules.nightPrice(stay, sel, wdNight);
    const we = Rules.nightPrice(stay, sel, weNight);
    const weekendText = Rules.weekendRuleApplies(stay, sel)
      ? '<span style="font-size: 11px; opacity: 0.8;">Fri & Sat: whole villa only</span>'
      : `<span class="rate-amount">${inr(we)}</span> <span style="font-size: 11px; opacity: 0.8;">Fri & Sat</span>`;
    ratesDisplay.innerHTML = wd
      ? `<span class="rate-amount">${inr(wd)}</span> <span style="font-size: 11px; opacity: 0.8;">Sun–Thu</span> &bull; ${weekendText}`
      : '<span style="font-size: 12px;">Contact us for prices</span>';
  }

  /** Fetch booked dates for the current stay, then update the calendar. */
  function refreshAvailability() {
    const stayId = currentHomestay.id;
    if (!calendarInstance) {
      applyAvailability();
    }
    fetch('/api/periods/' + encodeURIComponent(stayId) + '?_t=' + Date.now(), { cache: 'no-store' })
      .then(res => {
        if (!res.ok) throw new Error('Failed to fetch live availability');
        return res.json();
      })
      .then(periods => {
        if (currentHomestay.id !== stayId) return; // user moved on
        currentPeriods = Array.isArray(periods) ? periods : [];
        applyAvailability();
      })
      .catch(err => {
        console.error(err);
        const calEl = document.getElementById('bookingCalendar');
        if (calEl && !calendarInstance) {
          calEl.innerHTML = '<div style="padding: 40px; text-align: center; color: var(--danger);">Unable to retrieve live availability. Please try again shortly.</div>';
          calendarInstance = null;
        }
      });
  }

  /** Apply booked nights + the weekend rule for the current selection. */
  function applyAvailability() {
    const stay = currentHomestay;
    const sel = Rules.normalizeSelection(stay, bookingSelection);
    const booked = [...Rules.blockedNightsFor(stay, currentPeriods, sel)];
    const weekendLocked = Rules.weekendRuleApplies(stay, sel);
    const isRestricted = weekendLocked ? (d) => Rules.isWeekendNight(d) : null;
    const label = 'Fri & Sat nights: whole villa only';

    if (calendarInstance) {
      calendarInstance.setBookedDates(booked, isRestricted, label);
      calendarInstance.setMaxGuests(Rules.capacityFor(stay, sel));
    } else if (document.getElementById('bookingCalendar')) {
      calendarInstance = new HomestayCalendar('bookingCalendar', {
        bookedDates: booked,
        isRestricted: isRestricted || undefined,
        restrictedLabel: label,
        maxGuests: Rules.capacityFor(stay, sel),
        onSelectionChange: handleDateSelection
      });
    }
    // Keep the form in step with whatever the calendar still has selected
    if (calendarInstance) {
      handleDateSelection({ checkIn: calendarInstance.checkIn, checkOut: calendarInstance.checkOut }, { quiet: true });
    }
  }

  function updateGuestLimit() {
    maxGuests = Rules.capacityFor(currentHomestay, bookingSelection);
    while (bookingAdults + bookingChildren > maxGuests && bookingChildren > 0) bookingChildren--;
    while (bookingAdults + bookingChildren > maxGuests && bookingAdults > 1) bookingAdults--;
    updateGuestDisplay();
  }

  function updateGuestDisplay() {
    const countAdults = document.getElementById('countAdults');
    const countChildren = document.getElementById('countChildren');
    const btnAdultDec = document.getElementById('btnAdultDec');
    const btnAdultInc = document.getElementById('btnAdultInc');
    const btnChildDec = document.getElementById('btnChildDec');
    const btnChildInc = document.getElementById('btnChildInc');
    
    if (!countAdults || !countChildren) return;
    
    const total = bookingAdults + bookingChildren;
    
    countAdults.textContent = bookingAdults;
    countChildren.textContent = bookingChildren;
    
    btnAdultDec.disabled = bookingAdults <= 1;
    btnAdultInc.disabled = total >= maxGuests;
    btnChildDec.disabled = bookingChildren <= 0;
    btnChildInc.disabled = total >= maxGuests;
  }

  // Full Canvas Background Setup - Keep static CSS background
  function initFullCanvasBackground() {
    // Keep consistent sunset beach theme background
  }

  // Handle Date Selection from calendar
  function handleDateSelection(selection, { quiet = false } = {}) {
    const { checkIn, checkOut } = selection;
    
    const checkInInput = document.getElementById('checkInDate');
    const checkOutInput = document.getElementById('checkOutDate');
    const options = { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' };
    
    checkInInput.value = checkIn ? checkIn.toLocaleDateString('en-US', options) : '';
    checkOutInput.value = checkOut ? checkOut.toLocaleDateString('en-US', options) : '';
    
    document.querySelectorAll('.clear-date-btn').forEach(btn => {
      btn.style.display = (checkIn || checkOut) ? 'block' : 'none';
    });
    
    if (checkIn && checkOut) {
      whatsappBookBtn.disabled = false;
      whatsappBookBtn.classList.add('active');
      if (window.updatePriceDisplay) window.updatePriceDisplay();
      if (quiet) return;
      
      // Auto-close modal when both are selected
      const overlay = document.getElementById('calendarModalOverlay');
      if (overlay) overlay.classList.remove('active');
      
      const proceedContainer = document.getElementById('mobileProceedContainer');
      if (proceedContainer) proceedContainer.classList.remove('show');
      
      // Auto-scroll down to show the "Request Booking" form
      setTimeout(() => {
        if (whatsappBookBtn) whatsappBookBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 300);
    } else {
      whatsappBookBtn.disabled = true;
      whatsappBookBtn.classList.remove('active');
      const priceContainer = document.getElementById('priceSummaryContainer');
      if (priceContainer) priceContainer.style.display = 'none';
    }
  }

  // Send the booking request (dates, rooms and guests are read when clicked)
  whatsappBookBtn.addEventListener('click', async () => {
    if (!calendarInstance || !calendarInstance.checkIn || !calendarInstance.checkOut) return;
    const checkIn = calendarInstance.checkIn;
    const checkOut = calendarInstance.checkOut;
    const options = { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' };

    const guestNameEl = document.getElementById('guestName');
    const guestPhoneEl = document.getElementById('guestPhone');
    const promoCodeEl = document.getElementById('promoCode');
    const noteEl = document.getElementById('bookingNote');

    const guestName = guestNameEl ? guestNameEl.value.trim() : '';
    const guestPhone = guestPhoneEl ? guestPhoneEl.value.replace(/[\s-]/g, '') : '';
    const promoCode = promoCodeEl ? promoCodeEl.value.trim().toUpperCase() : '';
    const noteText = noteEl ? noteEl.value.trim() : '';

    if (!guestName || !guestPhone) {
      alert('Please provide your Full Name and WhatsApp Number.');
      return;
    }
    if (!/^\+?[0-9]{10,15}$/.test(guestPhone)) {
      alert('Please enter a valid phone number (10-15 digits), optionally starting with +.');
      return;
    }

    const sel = Rules.normalizeSelection(currentHomestay, bookingSelection);
    const checkInDate = toDateStr(checkIn);
    const checkOutDate = toDateStr(checkOut);
    const problem = Rules.validateBooking(currentHomestay, currentPeriods, sel, checkInDate, checkOutDate);
    if (problem) { alert(problem); return; }

    whatsappBookBtn.disabled = true;
    const label = whatsappBookBtn.querySelector('span');
    const originalText = label.textContent;
    label.textContent = 'Sending...';

    const priceData = window.updatePriceDisplay ? window.updatePriceDisplay() : null;
    const requestPayload = {
      homestayId: currentHomestay.id,
      homestayName: currentHomestay.name,
      checkIn: checkIn.toLocaleDateString('en-US', options),
      checkOut: checkOut.toLocaleDateString('en-US', options),
      adults: bookingAdults,
      children: bookingChildren,
      guestName,
      guestPhone,
      promoCode,
      note: (noteText + (document.getElementById('includeBreakfast')?.checked ? (noteText ? '\n' : '') + '[Add-on: Morning Breakfast Included @ ₹200/person/day]' : '')).trim(),
      breakfast: Boolean(document.getElementById('includeBreakfast')?.checked),
      checkInMs: checkIn.getTime(),
      checkOutMs: checkOut.getTime(),
      checkInDate,
      checkOutDate,
      units: Rules.selectionToUnits(sel),
      totalAmount: priceData ? priceData.total : 0
    };

    try {
      const res = await fetch('/api/request-booking', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestPayload)
      });
      
      if (res.ok) {
        label.textContent = 'Request Sent!';
        alert("Thank you for choosing to stay with us! 😊\n\nYour selected dates have been reserved for the next 6 hours while we prepare your booking.\n\nWe'll get in touch with you on WhatsApp shortly with the payment details.\n\nOnce your payment is received, your booking will be confirmed and your reservation will be secured.\n\nIf you're unable to complete the payment within 6 hours, no worries—your reserved dates will simply become available for other guests to book.\n\nWe look forward to hosting you!");
        if (guestNameEl) guestNameEl.value = '';
        if (guestPhoneEl) guestPhoneEl.value = '';
        if (promoCodeEl) promoCodeEl.value = '';
        if (noteEl) noteEl.value = '';
        calendarInstance.checkIn = null;
        calendarInstance.checkOut = null;
        calendarInstance._drawGrid();
        calendarInstance._notify();
        refreshAvailability(); // the held dates now show as taken
        setTimeout(() => { label.textContent = originalText; }, 1000);
      } else {
        const errData = await res.json().catch(() => ({}));
        alert(errData.error || 'Failed to send request. Please try again.');
        whatsappBookBtn.disabled = false;
        label.textContent = originalText;
        if (res.status === 409) refreshAvailability();
      }
    } catch (err) {
      console.error(err);
      alert('Error sending request.');
      whatsappBookBtn.disabled = false;
      label.textContent = originalText;
    }
  });

  // Lightbox View Logic
  function openLightbox(index) {
    lightboxActiveIndex = index;
    updateLightboxContent();
    lightbox.classList.add('active');
    document.addEventListener('keydown', handleLightboxKeydown);
  }

  function closeLightbox() {
    lightbox.classList.remove('active');
    document.removeEventListener('keydown', handleLightboxKeydown);
  }

  function updateLightboxContent() {
    const imageUrl = currentHomestay.images[lightboxActiveIndex];
    lightboxImg.src = imageUrl;
    lightboxCaption.textContent = `${currentHomestay.name} - View ${lightboxActiveIndex + 1} of ${currentHomestay.images.length}`;
  }

  function nextLightboxImage() {
    lightboxActiveIndex = (lightboxActiveIndex + 1) % currentHomestay.images.length;
    updateLightboxContent();
  }

  function prevLightboxImage() {
    lightboxActiveIndex = (lightboxActiveIndex - 1 + currentHomestay.images.length) % currentHomestay.images.length;
    updateLightboxContent();
  }

  function handleLightboxKeydown(e) {
    if (e.key === 'Escape') closeLightbox();
    if (e.key === 'ArrowRight') nextLightboxImage();
    if (e.key === 'ArrowLeft') prevLightboxImage();
  }

  lightboxClose.addEventListener('click', closeLightbox);
  lightboxNext.addEventListener('click', nextLightboxImage);
  lightboxPrev.addEventListener('click', prevLightboxImage);
  
  // Close lightbox on clicking dark background scrim
  lightbox.addEventListener('click', (e) => {
    if (e.target === lightbox || e.target.classList.contains('lightbox-content')) {
      closeLightbox();
    }
  });

  // Initialize Calendar Modal Triggers
  const calendarModalOverlay = document.getElementById('calendarModalOverlay');
  const closeCalendarBtn = document.getElementById('closeCalendarBtn');
  const dateTriggers = document.querySelectorAll('.date-trigger');
  
  if (calendarModalOverlay) {
    dateTriggers.forEach(btn => {
      btn.addEventListener('click', () => {
        calendarModalOverlay.classList.add('active');
      });
    });
    
    closeCalendarBtn.addEventListener('click', () => {
      calendarModalOverlay.classList.remove('active');
    });
    
    calendarModalOverlay.addEventListener('click', (e) => {
      if (e.target === calendarModalOverlay) {
        calendarModalOverlay.classList.remove('active');
      }
    });
  }

  // Real-time price calculation logic (same rules the server uses)
  window.updatePriceDisplay = function() {
    const priceContainer = document.getElementById('priceSummaryContainer');
    if (!currentHomestay || !calendarInstance || !calendarInstance.checkIn || !calendarInstance.checkOut) {
      if (priceContainer) priceContainer.style.display = 'none';
      return null;
    }
    const promoCodeEl = document.getElementById('promoCode');
    const q = Rules.quote(currentHomestay, bookingSelection,
      toDateStr(calendarInstance.checkIn), toDateStr(calendarInstance.checkOut), promoCodeEl ? promoCodeEl.value : '');

    const breakdownListEl = document.getElementById('priceBreakdownList');
    if (breakdownListEl) {
      const what = Rules.hasRooms(currentHomestay)
        ? `<div class="price-line price-line-what">${esc(Rules.selectionLabel(currentHomestay, q.selection))}</div>` : '';
      breakdownListEl.innerHTML = what + q.lines.map(l => `
        <div class="price-line">
          <span>${l.nights} ${esc(l.label)}${l.nights > 1 ? 's' : ''} &times; ${inr(l.unitPrice)}</span>
          <span class="price-line-amount">${inr(l.amount)}</span>
        </div>`).join('') + (q.promo && q.discount > 0 ? `
        <div class="price-line price-line-discount">
          <span>Promo ${esc(q.promo.code)} (${q.promo.discount}%)</span>
          <span>-${inr(q.discount)}</span>
        </div>` : '');

      // Add Ariyankuppam breakfast charge if selected
      const isAriyankuppam = (currentHomestay.areaName || '').toLowerCase().includes('ariyan') || 
                             (currentHomestay.id || '').includes('eden') || 
                             (currentHomestay.name || '').toLowerCase().includes('eden') ||
                             (currentHomestay.location || '').toLowerCase().includes('ariyan');
      const breakfastInput = document.getElementById('includeBreakfast');
      if (isAriyankuppam && breakfastInput && breakfastInput.checked) {
        const nights = Rules.eachNight(toDateStr(calendarInstance.checkIn), toDateStr(calendarInstance.checkOut)).length;
        const totalGuests = bookingAdults + bookingChildren;
        const breakfastAmt = totalGuests * 200 * nights;
        q.total += breakfastAmt;
        breakdownListEl.innerHTML += `
          <div class="price-line" style="color: var(--color-accent); font-weight: 500;">
            <span>Morning Breakfast (${totalGuests} guest${totalGuests > 1 ? 's' : ''} &times; ${nights} night${nights > 1 ? 's' : ''} &times; ₹200)</span>
            <span class="price-line-amount">${inr(breakfastAmt)}</span>
          </div>`;
      }
    }
    const totalAmtEl = document.getElementById('priceTotalAmount');
    if (totalAmtEl) totalAmtEl.textContent = inr(q.total);
    if (priceContainer) priceContainer.style.display = 'block';

    return { promoApplied: Boolean(q.promo), invalidPromo: q.invalidPromo, total: q.total };
  };

  // Wire breakfast toggle change listener
  const breakfastCheckbox = document.getElementById('includeBreakfast');
  if (breakfastCheckbox) {
    breakfastCheckbox.addEventListener('change', () => {
      window.updatePriceDisplay();
    });
  }

  // Listen for promo code apply button
  const promoCodeInput = document.getElementById('promoCode');
  const applyPromoBtn = document.getElementById('applyPromoBtn');
  if (promoCodeInput && applyPromoBtn) {
    promoCodeInput.addEventListener('input', () => {
      promoCodeInput.value = promoCodeInput.value.toUpperCase();
    });
    applyPromoBtn.addEventListener('click', () => {
      if (!calendarInstance || !calendarInstance.checkIn || !calendarInstance.checkOut) {
        return alert('Please select your Check-In and Check-Out dates first.');
      }
      const result = window.updatePriceDisplay();
      if (result) {
        if (result.invalidPromo) {
          alert('Invalid promo code.');
        } else if (result.promoApplied) {
          // Optional: slight visual feedback on the button
          const originalText = applyPromoBtn.textContent;
          applyPromoBtn.textContent = 'Applied!';
          applyPromoBtn.style.backgroundColor = 'var(--success)';
          setTimeout(() => {
            applyPromoBtn.textContent = originalText;
            applyPromoBtn.style.backgroundColor = '';
          }, 2000);
        }
      }
    });
    promoCodeInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        applyPromoBtn.click();
      }
    });
  }
  
  // Guest Selector Triggers
  const btnAdultDec = document.getElementById('btnAdultDec');
  const btnAdultInc = document.getElementById('btnAdultInc');
  const btnChildDec = document.getElementById('btnChildDec');
  const btnChildInc = document.getElementById('btnChildInc');
  
  if (btnAdultDec) {
    btnAdultDec.addEventListener('click', () => {
      if (bookingAdults > 1) { bookingAdults--; updateGuestDisplay(); }
    });
    btnAdultInc.addEventListener('click', () => {
      if (bookingAdults + bookingChildren < maxGuests) { bookingAdults++; updateGuestDisplay(); }
    });
    btnChildDec.addEventListener('click', () => {
      if (bookingChildren > 0) { bookingChildren--; updateGuestDisplay(); }
    });
    btnChildInc.addEventListener('click', () => {
      if (bookingAdults + bookingChildren < maxGuests) { bookingChildren++; updateGuestDisplay(); }
    });
  }
  
  // Clear Date Buttons
  const clearBtns = document.querySelectorAll('.clear-date-btn');
  clearBtns.forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation(); // prevent opening the calendar
      
      // Clear inputs
      document.getElementById('checkInDate').value = '';
      document.getElementById('checkOutDate').value = '';
      
      const priceContainer = document.getElementById('priceSummaryContainer');
      if (priceContainer) priceContainer.style.display = 'none';
      
      // Hide buttons
      clearBtns.forEach(b => b.style.display = 'none');
      
      // Disable booking button
      whatsappBookBtn.disabled = true;
      whatsappBookBtn.classList.remove('active');
      whatsappBookBtn.onclick = null;
      
      // Clear calendar instance
      if (calendarInstance) {
        calendarInstance.checkIn = null;
        calendarInstance.checkOut = null;
        calendarInstance.hoverDate = null;
        calendarInstance._drawGrid();
        calendarInstance._notify();
      }
    });
  });

  // Universal Click Handler: Redirect to Calendar when clicking any "Book This Stay" button anywhere
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.gm-btn-book, .btn-book-stay, [data-action="book-stay"], #btnBookFromOverview, #btnBookFromGallery');
    if (btn) {
      e.preventDefault();
      const stayId = btn.dataset.id || (currentHomestay ? currentHomestay.id : null);
      window.redirectToCalendar(stayId);
    }
  });

});
