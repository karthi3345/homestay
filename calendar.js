/**
 * HomestayCalendar
 * Clean, simple date picker matching Airbnb/Booking.com UX:
 * - Click 1: sets check-in
 * - Click 2: sets check-out (if no booked dates in range)
 * - If booked dates are in between, reset to new check-in
 * - Clicking again after both dates are selected resets everything
 */
class HomestayCalendar {
  constructor(containerId, options = {}) {
    this.container = document.getElementById(containerId);
    if (!this.container) return;

    this.bookedDates   = new Set(options.bookedDates || []);
    this.onSelectionChange = options.onSelectionChange || (() => {});

    // Show current month
    const now = new Date();
    this.viewYear   = now.getFullYear();
    this.viewMonth  = now.getMonth();
    // Lock: cannot navigate before this month
    this.minYear    = now.getFullYear();
    this.minMonth   = now.getMonth();

    this.checkIn   = null; // Date object
    this.checkOut  = null; // Date object
    this.hoverDate = null; // Date object (for range preview)
    this.adults    = 2;
    this.children  = 0;
    this.maxGuests = options.maxGuests || 6;

    this._build();
  }

  /* ─────────────────────────────── public API ─── */

  setBookedDates(dates) {
    this.bookedDates = new Set(dates);
    this._drawGrid();
  }

  setMaxGuests(max) {
    this.maxGuests = max;
    if (this.adults + this.children > max) {
      this.children = Math.max(0, max - this.adults);
      if (this.adults + this.children > max) {
        this.adults = max;
      }
    }
    this._drawGuests();
  }

  /* ─────────────────────────────── build DOM ─── */

  _build() {
    this.container.innerHTML = `
      <div class="calendar-wrapper">
        <div class="calendar-header">
          <button type="button" class="btn-cal-prev" aria-label="Previous month">
            <svg viewBox="0 0 24 24" width="18" height="18"><path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z" fill="currentColor"/></svg>
          </button>
          <span class="calendar-month-year"></span>
          <button type="button" class="btn-cal-next" aria-label="Next month">
            <svg viewBox="0 0 24 24" width="18" height="18"><path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z" fill="currentColor"/></svg>
          </button>
        </div>

        <div class="calendar-weekdays">
          <span>Su</span><span>Mo</span><span>Tu</span><span>We</span><span>Th</span><span>Fr</span><span>Sa</span>
        </div>

        <div class="calendar-grid"></div>

        <div class="selection-summary">
          <div class="date-summary-box">
            <div class="summary-label">Check-in</div>
            <div class="summary-value checkin-val">Select date</div>
          </div>
          <div class="date-summary-box">
            <div class="summary-label">Check-out</div>
            <div class="summary-value checkout-val">Select date</div>
          </div>
        </div>

        <div class="guest-selector-container"></div>
      </div>
    `;

    this._drawGrid();
    this._drawGuests();
    this._attachEvents();
  }

  /* ─────────────────────────────── render grid ─── */

  _drawGrid() {
    const label = this.container.querySelector('.calendar-month-year');
    const grid  = this.container.querySelector('.calendar-grid');

    const MONTHS = ['January','February','March','April','May','June',
                    'July','August','September','October','November','December'];

    label.textContent = `${MONTHS[this.viewMonth]} ${this.viewYear}`;
    grid.innerHTML = '';

    // Disable prev button when on current month
    if (this._btnPrev) {
      const atMin = this.viewYear === this.minYear && this.viewMonth === this.minMonth;
      this._btnPrev.disabled = atMin;
      this._btnPrev.style.opacity = atMin ? '0.25' : '1';
      this._btnPrev.style.cursor  = atMin ? 'not-allowed' : 'pointer';
    }

    const today   = this._midnight(new Date());
    const firstWd = new Date(this.viewYear, this.viewMonth, 1).getDay();
    const daysIn  = new Date(this.viewYear, this.viewMonth + 1, 0).getDate();
    const prevEnd = new Date(this.viewYear, this.viewMonth, 0).getDate();

    const ciMs = this.checkIn  ? this.checkIn.getTime()  : null;
    const coMs = this.checkOut ? this.checkOut.getTime() : null;
    const hvMs = this.hoverDate ? this.hoverDate.getTime() : null;

    // Determine the first booked date strictly after check-in (for range cap)
    let capMs = null;
    if (ciMs && !coMs) {
      for (const s of this.bookedDates) {
        const t = this._strToMs(s);
        if (t > ciMs && (capMs === null || t < capMs)) capMs = t;
      }
    }

    // Filler cells from previous month
    for (let i = firstWd; i > 0; i--) {
      const el = document.createElement('div');
      el.className = 'calendar-day empty-day';
      el.textContent = prevEnd - i + 1;
      grid.appendChild(el);
    }

    // Actual day cells
    for (let d = 1; d <= daysIn; d++) {
      const date   = this._midnight(new Date(this.viewYear, this.viewMonth, d));
      const ms     = date.getTime();
      const dateStr = this._fmt(date);
      const isPast   = ms < today.getTime();
      const isBooked = this.bookedDates.has(dateStr);

      const el = document.createElement('div');
      el.className = 'calendar-day';
      el.textContent = d;
      el.dataset.date = dateStr;
      el.dataset.ms   = ms;

      if (isPast || isBooked) {
        // Hard disabled: past or booked
        el.classList.add('unavailable');
      } else if (capMs !== null && ms >= capMs) {
        // Soft disabled: beyond a booked cap after check-in
        // Still clickable (resets check-in), but styled as unavailable
        el.classList.add('cap-blocked');
      } else {
        el.classList.add('available');

        // Apply selection highlights
        if (ciMs && ms === ciMs)  el.classList.add('selected-start');
        if (coMs && ms === coMs)  el.classList.add('selected-end');
        if (ciMs && coMs && ms > ciMs && ms < coMs) el.classList.add('in-range');
        if (ciMs && !coMs) {
          if (hvMs && ms > ciMs && ms < hvMs) el.classList.add('hover-range');
          if (hvMs && ms === hvMs) el.classList.add('hover-range', 'hover-end');
        }
      }

      grid.appendChild(el);
    }

    this._drawSummary();
  }

  /* ─────────────────────────────── render guests ─── */

  _drawGuests() {
    const el = this.container.querySelector('.guest-selector-container');
    const total = this.adults + this.children;
    el.innerHTML = `
      <div class="guest-selector">
        <span class="guest-label">Adults</span>
        <div class="guest-controls">
          <button type="button" class="btn-adult-dec"${this.adults <= 1 ? ' disabled' : ''}>−</button>
          <span class="guest-count">${this.adults}</span>
          <button type="button" class="btn-adult-inc"${total >= this.maxGuests ? ' disabled' : ''}>+</button>
        </div>
      </div>
      <div class="guest-selector">
        <span class="guest-label">Children</span>
        <div class="guest-controls">
          <button type="button" class="btn-child-dec"${this.children <= 0 ? ' disabled' : ''}>−</button>
          <span class="guest-count">${this.children}</span>
          <button type="button" class="btn-child-inc"${total >= this.maxGuests ? ' disabled' : ''}>+</button>
        </div>
      </div>
    `;
  }

  _drawSummary() {
    const ci = this.container.querySelector('.checkin-val');
    const co = this.container.querySelector('.checkout-val');
    if (ci) ci.textContent = this.checkIn  ? this._display(this.checkIn)  : 'Select date';
    if (co) co.textContent = this.checkOut ? this._display(this.checkOut) : 'Select date';
  }

  /* ─────────────────────────────── events ─── */

  _attachEvents() {
    // Month navigation
    this._btnPrev = this.container.querySelector('.btn-cal-prev');
    this._btnNext = this.container.querySelector('.btn-cal-next');

    this._btnPrev.addEventListener('click', () => {
      // Don't go before the current real-world month
      if (this.viewYear === this.minYear && this.viewMonth === this.minMonth) return;
      if (this.viewMonth === 0) { this.viewMonth = 11; this.viewYear--; }
      else this.viewMonth--;
      this._drawGrid();
    });

    this._btnNext.addEventListener('click', () => {
      if (this.viewMonth === 11) { this.viewMonth = 0; this.viewYear++; }
      else this.viewMonth++;
      this._drawGrid();
    });

    const grid = this.container.querySelector('.calendar-grid');

    // Click: date selection
    grid.addEventListener('click', (e) => {
      const cell = e.target.closest('.calendar-day');
      if (!cell || cell.classList.contains('empty-day') || cell.classList.contains('unavailable')) return;

      const ms   = Number(cell.dataset.ms);
      const date = new Date(ms);

      if (!this.checkIn || (this.checkIn && this.checkOut)) {
        // State A → No selection or both selected: start fresh
        this.checkIn  = date;
        this.checkOut = null;
      } else {
        // State B → Check-in set, picking check-out
        if (ms <= this.checkIn.getTime()) {
          // Clicked same or earlier date: move check-in
          this.checkIn  = date;
          this.checkOut = null;
        } else if (this._hasBookedBetween(this.checkIn, date)) {
          // Booked gap in range: reset check-in to clicked date
          this.checkIn  = date;
          this.checkOut = null;
        } else {
          // Valid check-out
          this.checkOut = date;
        }
      }

      this.hoverDate = null;
      this._drawGrid();
      this._notify();
    });

    // Hover: range preview
    grid.addEventListener('mousemove', (e) => {
      if (!this.checkIn || this.checkOut) return;
      const cell = e.target.closest('.calendar-day.available');
      if (!cell) { this._clearHover(); return; }
      const ms = Number(cell.dataset.ms);
      if (ms <= this.checkIn.getTime()) { this._clearHover(); return; }
      if (ms === (this.hoverDate ? this.hoverDate.getTime() : null)) return; // no change
      this.hoverDate = new Date(ms);
      this._drawGrid();
    });

    grid.addEventListener('mouseleave', () => this._clearHover());

    // Guest controls (event delegation on container)
    this.container.addEventListener('click', (e) => {
      const total = this.adults + this.children;

      if (e.target.classList.contains('btn-adult-inc') && total < this.maxGuests) {
        this.adults++;
        this._drawGuests();
        this._notify();
      } else if (e.target.classList.contains('btn-adult-dec') && this.adults > 1) {
        this.adults--;
        this._drawGuests();
        this._notify();
      } else if (e.target.classList.contains('btn-child-inc') && total < this.maxGuests) {
        this.children++;
        this._drawGuests();
        this._notify();
      } else if (e.target.classList.contains('btn-child-dec') && this.children > 0) {
        this.children--;
        this._drawGuests();
        this._notify();
      }
    });
  }

  _clearHover() {
    if (this.hoverDate) {
      this.hoverDate = null;
      this._drawGrid();
    }
  }

  /* ─────────────────────────────── helpers ─── */

  _midnight(date) {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    return d;
  }

  _fmt(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  _strToMs(str) {
    const [y, m, d] = str.split('-').map(Number);
    const date = new Date(y, m - 1, d);
    date.setHours(0, 0, 0, 0);
    return date.getTime();
  }

  _display(date) {
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  _hasBookedBetween(start, end) {
    // Checks for any booked date strictly between start (exclusive) and end (exclusive)
    const startMs = start.getTime();
    const endMs   = end.getTime();
    for (const s of this.bookedDates) {
      const t = this._strToMs(s);
      if (t > startMs && t < endMs) return true;
    }
    return false;
  }

  _notify() {
    this.onSelectionChange({
      checkIn:  this.checkIn,
      checkOut: this.checkOut,
      adults:   this.adults,
      children: this.children
    });
  }
}

window.HomestayCalendar = HomestayCalendar;
