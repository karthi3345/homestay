# VolGO Stays: updated website

## What's in this folder

- **website-code/**: the full website code with all changes. Copy it over your
  project folder, run `npm install`, then push to GitHub. Netlify builds and
  deploys it.
- **preview-live-map/**: a preview that runs straight from your computer.
  Double-click `index.html` for the guest site with the real MapTiler map, or
  `admin.html` for the admin panel. They use sample data saved in your browser
  ("Reset data" button, bottom-left). To get a link you can open on a phone,
  drag this folder onto https://app.netlify.com/drop
- **volgo-stays-changes.patch**: the same changes as git commits. Apply them
  with `git am volgo-stays-changes.patch` if you'd rather keep your own history.

## Run the real site on your computer

    npm install
    node server.js     # server + admin panel at http://localhost:3000/admin
    npm run dev        # website at http://localhost:5173
    npm test           # checks prices, Fri/Sat rule, whole villa vs rooms

## Where the main changes are

- lib/booking-rules.js: prices, whole villa vs rooms, Fri/Sat rule (shared by
  the site and the server)
- netlify/functions/api.js: admin endpoints for stays, photos and settings,
  plus the storage fix
- admin/admin-extra.js and admin/admin-extra.css: stay editor, price periods,
  website settings
- app.js, index.html and styles.css: peach theme, Pondicherry map, villa
  booking, tab icons
- calendar.js: check-out on a booked morning, nights shown as "whole villa only"
- data/homestays.json: villa (hidden until it has photos), nearby beaches,
  house rules
- data/site-settings.json: contact number, festive themes

## Before going live

1. Set the villa's final prices (Admin, Pricing Settings).
2. Add the villa's photos and exact location, then tick "Show this stay on the
   website".
3. Check the contact number in Website Settings.
4. In your MapTiler account, limit the key to your own sites under
   "Allowed HTTP origins".
