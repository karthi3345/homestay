class HomestayCalendar {
  constructor(containerId, options = {}) {
    this.container = document.getElementById(containerId);
    this.bookedDates = new Set(options.bookedDates || []);
    this.onSelectionChange = options.onSelectionChange || (() => {});
    
    this.currentDate = new Date(); // Month displayed
    this.selectedCheckIn = null;
    this.selectedCheckOut = null;
    this.hoverDate = null;
    this.guests = 2;
    this.maxGuests = options.maxGuests || 6;
    
    this.init();
  }
  
  init() {
    this.render();
    this.attachEvents();
  }
  
  setBookedDates(dates) {
    this.bookedDates = new Set(dates);
    this.renderCalendarGrid();
  }
  
  setMaxGuests(max) {
    this.maxGuests = max;
    this.guests = Math.min(this.guests, max);
    this.renderGuestSelector();
  }
  
  render() {
    this.container.innerHTML = `
      <div class="calendar-wrapper">
        <div class="calendar-header">
          <button type="button" class="btn-cal-prev" aria-label="Previous month">
            <svg viewBox="0 0 24 24" width="20" height="20"><path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z" fill="currentColor"/></svg>
          </button>
          <span class="calendar-month-year"></span>
          <button type="button" class="btn-cal-next" aria-label="Next month">
            <svg viewBox="0 0 24 24" width="20" height="20"><path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z" fill="currentColor"/></svg>
          </button>
        </div>
        
        <div class="calendar-weekdays">
          <span>Su</span><span>Mo</span><span>Tu</span><span>We</span><span>Th</span><span>Fr</span><span>Sa</span>
        </div>
        
        <div class="calendar-grid"></div>
        
        <div class="selection-summary">
          <div class="date-summary-box">
            <div class="summary-label">Check-in</div>
            <div class="summary-value checkin-val">-</div>
          </div>
          <div class="date-summary-box">
            <div class="summary-label">Check-out</div>
            <div class="summary-value checkout-val">-</div>
          </div>
        </div>
        
        <div class="guest-selector-container"></div>
      </div>
    `;
    
    this.renderCalendarGrid();
    this.renderGuestSelector();
  }
  
  renderCalendarGrid() {
    const monthYearSpan = this.container.querySelector('.calendar-month-year');
    const grid = this.container.querySelector('.calendar-grid');
    
    const year = this.currentDate.getFullYear();
    const month = this.currentDate.getMonth();
    
    // Month name
    const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    monthYearSpan.textContent = `${monthNames[month]} ${year}`;
    
    grid.innerHTML = '';
    
    const firstDayIndex = new Date(year, month, 1).getDay();
    const lastDay = new Date(year, month + 1, 0).getDate();
    
    // Previous month filler dates
    const prevLastDay = new Date(year, month, 0).getDate();
    for (let x = firstDayIndex; x > 0; x--) {
      const dayDiv = document.createElement('div');
      dayDiv.classList.add('calendar-day', 'empty-day');
      dayDiv.textContent = prevLastDay - x + 1;
      grid.appendChild(dayDiv);
    }
    
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const timeToday = today.getTime();
    const timeIn = this.selectedCheckIn ? this.selectedCheckIn.getTime() : null;
    const timeOut = this.selectedCheckOut ? this.selectedCheckOut.getTime() : null;
    const timeHover = this.hoverDate ? this.hoverDate.getTime() : null;
    
    // Month days
    for (let day = 1; day <= lastDay; day++) {
      const dayDiv = document.createElement('div');
      dayDiv.classList.add('calendar-day');
      dayDiv.textContent = day;
      
      const thisDate = new Date(year, month, day);
      thisDate.setHours(0, 0, 0, 0);
      const dateStr = this.formatDateStr(thisDate);
      
      dayDiv.dataset.date = dateStr;
      
      const timeThis = thisDate.getTime();
      const isPast = timeThis < timeToday;
      const isBooked = this.bookedDates.has(dateStr);
      
      if (isPast || isBooked) {
        dayDiv.classList.add('unavailable');
      } else {
        dayDiv.classList.add('available');
        
        // Highlights
        if (timeIn && timeThis === timeIn) {
          dayDiv.classList.add('selected-start');
        } else if (timeOut && timeThis === timeOut) {
          dayDiv.classList.add('selected-end');
        } else if (timeIn && timeOut && timeThis > timeIn && timeThis < timeOut) {
          dayDiv.classList.add('in-range');
        } else if (timeIn && !timeOut && timeHover && timeThis > timeIn && timeThis <= timeHover) {
          dayDiv.classList.add('hover-range');
          if (timeThis === timeHover) {
            dayDiv.classList.add('hover-end');
          }
        }
      }
      
      grid.appendChild(dayDiv);
    }
    
    this.updateSummaryText();
  }
  
  renderGuestSelector() {
    const container = this.container.querySelector('.guest-selector-container');
    container.innerHTML = `
      <div class="guest-selector">
        <span class="guest-label">Guests</span>
        <div class="guest-controls">
          <button type="button" class="btn-guest-dec" ${this.guests <= 1 ? 'disabled' : ''}>−</button>
          <span class="guest-count">${this.guests}</span>
          <button type="button" class="btn-guest-inc" ${this.guests >= this.maxGuests ? 'disabled' : ''}>+</button>
        </div>
      </div>
    `;
  }
  
  attachEvents() {
    const btnPrev = this.container.querySelector('.btn-cal-prev');
    const btnNext = this.container.querySelector('.btn-cal-next');
    
    btnPrev.addEventListener('click', () => {
      this.currentDate.setMonth(this.currentDate.getMonth() - 1);
      this.renderCalendarGrid();
    });
    
    btnNext.addEventListener('click', () => {
      this.currentDate.setMonth(this.currentDate.getMonth() + 1);
      this.renderCalendarGrid();
    });
    
    const grid = this.container.querySelector('.calendar-grid');
    
    grid.addEventListener('click', (e) => {
      const dayEl = e.target.closest('.calendar-day.available');
      if (!dayEl) return;
      
      const dateParts = dayEl.dataset.date.split('-');
      const clickedDate = new Date(dateParts[0], dateParts[1] - 1, dateParts[2]);
      clickedDate.setHours(0, 0, 0, 0);
      
      const timeClicked = clickedDate.getTime();
      const timeIn = this.selectedCheckIn ? this.selectedCheckIn.getTime() : null;
      
      if (!this.selectedCheckIn || (this.selectedCheckIn && this.selectedCheckOut)) {
        // Step 1: select check-in
        this.selectedCheckIn = clickedDate;
        this.selectedCheckOut = null;
      } else if (timeClicked <= timeIn) {
        // Reset check-in if clicked date is before check-in
        this.selectedCheckIn = clickedDate;
      } else {
        // Step 2: select check-out. Check if any booked dates are in-between
        if (this.hasBookedDateInBetween(this.selectedCheckIn, clickedDate)) {
          // Reset check-in to clicked date if there's a booked gap
          this.selectedCheckIn = clickedDate;
        } else {
          this.selectedCheckOut = clickedDate;
        }
      }
      
      this.renderCalendarGrid();
      this.notifyChange();
    });
    
    grid.addEventListener('mouseover', (e) => {
      const dayEl = e.target.closest('.calendar-day.available');
      if (!dayEl || !this.selectedCheckIn || this.selectedCheckOut) {
        this.hoverDate = null;
        return;
      }
      
      const dateParts = dayEl.dataset.date.split('-');
      const hoverDate = new Date(dateParts[0], dateParts[1] - 1, dateParts[2]);
      hoverDate.setHours(0, 0, 0, 0);
      
      const timeHover = hoverDate.getTime();
      const timeIn = this.selectedCheckIn.getTime();
      
      if (timeHover > timeIn && !this.hasBookedDateInBetween(this.selectedCheckIn, hoverDate)) {
        this.hoverDate = hoverDate;
      } else {
        this.hoverDate = null;
      }
      
      this.renderCalendarGrid();
    });
    
    grid.addEventListener('mouseleave', () => {
      if (this.hoverDate) {
        this.hoverDate = null;
        this.renderCalendarGrid();
      }
    });
    
    // Guest selector clicks
    this.container.addEventListener('click', (e) => {
      if (e.target.classList.contains('btn-guest-inc')) {
        if (this.guests < this.maxGuests) {
          this.guests++;
          this.renderGuestSelector();
          this.notifyChange();
        }
      } else if (e.target.classList.contains('btn-guest-dec')) {
        if (this.guests > 1) {
          this.guests--;
          this.renderGuestSelector();
          this.notifyChange();
        }
      }
    });
  }
  
  hasBookedDateInBetween(start, end) {
    let current = new Date(start.getTime());
    current.setDate(current.getDate() + 1);
    current.setHours(0, 0, 0, 0);
    const endTime = end.getTime();
    
    while (current.getTime() < endTime) {
      if (this.bookedDates.has(this.formatDateStr(current))) {
        return true;
      }
      current.setDate(current.getDate() + 1);
    }
    return false;
  }
  
  formatDateStr(date) {
    if (!date) return '';
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  
  formatDisplayDate(date) {
    if (!date) return '-';
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }
  
  updateSummaryText() {
    const ciVal = this.container.querySelector('.checkin-val');
    const coVal = this.container.querySelector('.checkout-val');
    
    if (ciVal && coVal) {
      ciVal.textContent = this.formatDisplayDate(this.selectedCheckIn);
      coVal.textContent = this.formatDisplayDate(this.selectedCheckOut);
    }
  }
  
  notifyChange() {
    this.onSelectionChange({
      checkIn: this.selectedCheckIn,
      checkOut: this.selectedCheckOut,
      guests: this.guests
    });
  }
}

window.HomestayCalendar = HomestayCalendar;
