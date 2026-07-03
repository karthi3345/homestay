document.addEventListener('DOMContentLoaded', () => {
  let homestays = [];
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
  const heroTitle = document.getElementById('heroTitle');
  const heroTagline = document.getElementById('heroTagline');
  const heroCta = document.getElementById('heroCta');
  
  // Tab elements
  const tabs = document.querySelectorAll('.nav-tab');
  const tabPanes = document.querySelectorAll('.tab-pane');
  
  // Overview specs
  const specGuests = document.getElementById('specGuests');
  const specBedrooms = document.getElementById('specBedrooms');
  const specBathrooms = document.getElementById('specBathrooms');
  const propertyDesc = document.getElementById('propertyDesc');
  const amenitiesGrid = document.getElementById('amenitiesGrid');
  
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

    card.addEventListener('pointermove', (e) => {
      const rect = card.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      const edge = getEdgeProximity(card, x, y);
      const angle = getCursorAngle(card, x, y);

      card.style.setProperty('--edge-proximity', `${(edge * 100).toFixed(3)}`);
      card.style.setProperty('--cursor-angle', `${angle.toFixed(3)}deg`);
    });
    
    // Trigger initial state
    card.style.setProperty('--edge-proximity', '0');
    card.style.setProperty('--cursor-angle', '45deg');
  }
  
  initBorderGlow();

  // Fetch homestay configuration
  fetch('data/homestays.json')
    .then(res => res.json())
    .then(data => {
      homestays = data;
      // Default load the first homestay
      loadHomestay(homestays[0]);
      
      // Initialize property selector dropdown
      setupPropertySelector();
    })
    .catch(err => console.error("Error loading homestay data:", err));

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
    });
  });

  // CTA Button Click (Scrolls or shifts to calendar)
  heroCta.addEventListener('click', () => {
    const calTab = document.querySelector('[data-tab="calendar"]');
    if (calTab) calTab.click();
  });

  // Setup property dropdown options
  function setupPropertySelector() {
    // If only one property, hide the dropdown arrow and don't bind events
    if (homestays.length <= 1) {
      const arrow = activePropertyBtn.querySelector('.dropdown-arrow');
      if (arrow) arrow.style.display = 'none';
      activePropertyBtn.style.cursor = 'default';
      return;
    }
    
    // Otherwise populate list
    propertyDropdown.innerHTML = '';
    homestays.forEach(h => {
      const item = document.createElement('div');
      item.classList.add('dropdown-item');
      item.textContent = h.name;
      item.addEventListener('click', () => {
        loadHomestay(h);
        propertyDropdown.classList.remove('active');
      });
      propertyDropdown.appendChild(item);
    });
    
    activePropertyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      propertyDropdown.classList.toggle('active');
    });
    
    document.addEventListener('click', () => {
      propertyDropdown.classList.remove('active');
    });
  }

  // Load selected homestay details
  function loadHomestay(homestay) {
    currentHomestay = homestay;
    
    // Update headers and titles
    document.querySelector('.active-property-name').textContent = homestay.name;
    heroTitle.textContent = homestay.name;
    heroTagline.textContent = homestay.tagline;
    document.title = `${homestay.name} | Premium Homestay`;
    
    // Overview tab details
    specGuests.textContent = `Up to ${homestay.capacity} Guests`;
    specBedrooms.textContent = `${homestay.bedrooms} Bedrooms`;
    specBathrooms.textContent = `${homestay.bathrooms} Baths`;
    propertyDesc.textContent = homestay.description;
    
    // Amenities
    amenitiesGrid.innerHTML = '';
    homestay.amenities.forEach(amenity => {
      const box = document.createElement('div');
      box.classList.add('amenity-card');
      box.innerHTML = `
        <span class="material-symbols-outlined amenity-icon">${amenity.icon}</span>
        <span class="amenity-name">${amenity.name}</span>
      `;
      amenitiesGrid.appendChild(box);
    });
    
    // Gallery
    galleryGrid.innerHTML = '';
    homestay.images.forEach((imgUrl, idx) => {
      const wrapper = document.createElement('div');
      wrapper.classList.add('gallery-item');
      wrapper.innerHTML = `
        <img src="${imgUrl}" alt="${homestay.name} view ${idx + 1}" loading="lazy">
        <div class="gallery-hover-overlay">
          <span class="material-symbols-outlined">zoom_in</span>
        </div>
      `;
      wrapper.addEventListener('click', () => openLightbox(idx));
      galleryGrid.appendChild(wrapper);
    });
    
    // Contacts
    contactPhone.textContent = homestay.phone;
    contactPhone.href = `tel:${homestay.phone.replace(/[^+\d]/g, '')}`;
    
    contactWhatsapp.href = `https://wa.me/${homestay.whatsapp.replace(/[^+\d]/g, '')}`;
    
    contactEmail.textContent = homestay.email;
    contactEmail.href = `mailto:${homestay.email}`;
    
    contactLocation.textContent = homestay.location;
    contactMap.src = homestay.mapEmbedUrl;
    
    // Calendar Setup (Live Fetch)
    const initCalendar = (dates) => {
      if (calendarInstance) {
        calendarInstance.setBookedDates(dates);
        calendarInstance.setMaxGuests(homestay.capacity);
      } else {
        calendarInstance = new HomestayCalendar('bookingCalendar', {
          bookedDates: dates,
          maxGuests: homestay.capacity,
          onSelectionChange: handleDateSelection
        });
      }
    };
    
    // Optimistically load from homestays.json, then fetch live
    initCalendar(homestay.bookedDates);
    
    fetch('/api/periods/' + homestay.id)
      .then(res => {
        if (!res.ok) throw new Error('Failed to fetch live availability');
        return res.json();
      })
      .then(livePeriods => {
        // convert [{from, to}] into an array of date strings for calendar.js
        const booked = new Set();
        livePeriods.forEach(p => {
          let curr = new Date(p.from);
          const end = new Date(p.to);
          while (curr < end) {
            booked.add(curr.toISOString().split('T')[0]);
            curr.setDate(curr.getDate() + 1);
          }
        });
        initCalendar(Array.from(booked));
      })
      .catch(err => {
        console.error(err);
        const calEl = document.getElementById('bookingCalendar');
        if (calEl) {
          calEl.innerHTML = '<div style="padding: 40px; text-align: center; color: var(--danger);">Unable to retrieve live availability. Please try again shortly.</div>';
          calendarInstance = null;
        }
      });
    
    // Initialize Full Canvas Background
    if (!document.getElementById('app-background').style.backgroundImage) {
      initFullCanvasBackground();
    }
    
    // Reset selection
    whatsappBookBtn.disabled = true;
    whatsappBookBtn.classList.remove('active');
  }

  // Full Canvas Random Background Setup
  function initFullCanvasBackground() {
    const bgContainer = document.getElementById('app-background');
    if (!bgContainer) return;
    const totalImages = 5;
    const randomIdx = Math.floor(Math.random() * totalImages) + 1;
    bgContainer.style.backgroundImage = `url('assets/bg-optimized/bg-${randomIdx}.png')`;
  }

  // Handle Date Selection from calendar
  function handleDateSelection(selection) {
    const { checkIn, checkOut, adults, children } = selection;
    
    if (checkIn && checkOut) {
      whatsappBookBtn.disabled = false;
      whatsappBookBtn.classList.add('active');
      
      // Calculate display dates
      const options = { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' };
      const checkInStr = checkIn.toLocaleDateString('en-US', options);
      const checkOutStr = checkOut.toLocaleDateString('en-US', options);
      
      const waNumber = currentHomestay.whatsapp.replace(/[^+\d]/g, '');
      
      whatsappBookBtn.onclick = async () => {
        const guestNameEl = document.getElementById('guestName');
        const guestPhoneEl = document.getElementById('guestPhone');
        const noteEl = document.getElementById('bookingNote');
        
        const guestName = guestNameEl ? guestNameEl.value.trim() : '';
        const guestPhone = guestPhoneEl ? guestPhoneEl.value.trim() : '';
        const noteText = noteEl ? noteEl.value.trim() : '';

        if (!guestName || !guestPhone) {
          alert('Please provide your Full Name and WhatsApp Number.');
          return;
        }

        const phoneRegex = /^\+?[0-9]{10,15}$/;
        if (!phoneRegex.test(guestPhone)) {
          alert('Please enter a valid phone number (10-15 digits), optionally starting with +.');
          return;
        }
        
        whatsappBookBtn.disabled = true;
        const originalText = whatsappBookBtn.querySelector('span').textContent;
        whatsappBookBtn.querySelector('span').textContent = 'Sending...';

        const requestPayload = {
          homestayId: currentHomestay.id,
          homestayName: currentHomestay.name,
          checkIn: checkInStr,
          checkOut: checkOutStr,
          adults,
          children,
          guestName,
          guestPhone,
          note: noteText,
          checkInMs: checkIn.getTime(),
          checkOutMs: checkOut.getTime()
        };

        try {
          const res = await fetch('/api/request-booking', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestPayload)
          });
          
          if (res.ok) {
            whatsappBookBtn.querySelector('span').textContent = 'Request Sent!';
            alert('Thank you. Your booking request has been sent. We\'ll contact you on WhatsApp shortly to confirm availability.');
            setTimeout(() => {
              whatsappBookBtn.querySelector('span').textContent = originalText;
              whatsappBookBtn.disabled = false;
              // Reset form
              if(guestNameEl) guestNameEl.value = '';
              if(guestPhoneEl) guestPhoneEl.value = '';
              if(noteEl) noteEl.value = '';
              calendarInstance.checkIn = null;
              calendarInstance.checkOut = null;
              calendarInstance._drawGrid();
              calendarInstance._notify();
            }, 1000);
          } else {
            const errData = await res.json();
            alert(errData.error || 'Failed to send request. Please try again.');
            whatsappBookBtn.disabled = false;
            whatsappBookBtn.querySelector('span').textContent = originalText;
          }
        } catch (err) {
          console.error(err);
          alert('Error sending request.');
          whatsappBookBtn.disabled = false;
          whatsappBookBtn.querySelector('span').textContent = originalText;
        }
      };
    } else {
      whatsappBookBtn.disabled = true;
      whatsappBookBtn.classList.remove('active');
      whatsappBookBtn.onclick = null;
    }
  }

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
});
