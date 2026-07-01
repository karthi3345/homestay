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
  
  const slideshowBg = document.getElementById('slideshow-bg');
  const slideshowIndicators = document.getElementById('slideshowIndicators');
  
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
    
    // Calendar Setup
    if (calendarInstance) {
      calendarInstance.setBookedDates(homestay.bookedDates);
      calendarInstance.setMaxGuests(homestay.capacity);
    } else {
      calendarInstance = new HomestayCalendar('bookingCalendar', {
        bookedDates: homestay.bookedDates,
        maxGuests: homestay.capacity,
        onSelectionChange: handleDateSelection
      });
    }
    
    // Slideshow Background Setup
    initBackgroundSlideshow(homestay.images);
    
    // Reset selection
    whatsappBookBtn.disabled = true;
    whatsappBookBtn.classList.remove('active');
  }

  // Slideshow Logic
  function initBackgroundSlideshow(images) {
    if (slideshowInterval) clearInterval(slideshowInterval);
    slideshowBg.innerHTML = '';
    slideshowIndicators.innerHTML = '';
    
    if (!images || images.length === 0) return;
    
    // Load first 5 images for slideshow to prevent heavy Dom overhead
    const slides = images.slice(0, 6);
    
    slides.forEach((url, idx) => {
      const slide = document.createElement('div');
      slide.classList.add('slide-img');
      slide.style.backgroundImage = `url('${url}')`;
      if (idx === 0) slide.classList.add('active');
      slideshowBg.appendChild(slide);
      
      const indicator = document.createElement('button');
      indicator.classList.add('slide-dot');
      if (idx === 0) indicator.classList.add('active');
      indicator.ariaLabel = `Go to slide ${idx + 1}`;
      indicator.addEventListener('click', () => {
        setSlide(idx);
      });
      slideshowIndicators.appendChild(indicator);
    });
    
    currentSlideIndex = 0;
    
    slideshowInterval = setInterval(() => {
      nextSlide(slides.length);
    }, 6000); // 6 seconds slide duration
  }

  function setSlide(index) {
    const slides = slideshowBg.querySelectorAll('.slide-img');
    const dots = slideshowIndicators.querySelectorAll('.slide-dot');
    
    slides.forEach(s => s.classList.remove('active'));
    dots.forEach(d => d.classList.remove('active'));
    
    currentSlideIndex = index;
    slides[currentSlideIndex].classList.add('active');
    dots[currentSlideIndex].classList.add('active');
    
    // Reset automated interval to prevent quick skipping
    if (slideshowInterval) {
      clearInterval(slideshowInterval);
      slideshowInterval = setInterval(() => {
        nextSlide(slides.length);
      }, 6000);
    }
  }

  function nextSlide(total) {
    let nextIndex = (currentSlideIndex + 1) % total;
    setSlide(nextIndex);
  }

  // Handle Date Selection from calendar
  function handleDateSelection(selection) {
    const { checkIn, checkOut, guests } = selection;
    
    if (checkIn && checkOut) {
      whatsappBookBtn.disabled = false;
      whatsappBookBtn.classList.add('active');
      
      // Calculate display dates
      const options = { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' };
      const checkInStr = checkIn.toLocaleDateString('en-US', options);
      const checkOutStr = checkOut.toLocaleDateString('en-US', options);
      
      // Formulate WhatsApp message text
      const rawMsg = `Hi, I'd like to book your homestay: ${currentHomestay.name}.\n\nCheck-in: ${checkInStr}\nCheck-out: ${checkOutStr}\nGuests: ${guests}`;
      const encodedMsg = encodeURIComponent(rawMsg);
      const waNumber = currentHomestay.whatsapp.replace(/[^+\d]/g, '');
      
      whatsappBookBtn.onclick = () => {
        window.open(`https://wa.me/${waNumber}?text=${encodedMsg}`, '_blank');
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
