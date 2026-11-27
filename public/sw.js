// Volgo Home Stay - Admin Web Push Service Worker
self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let data = {};
  if (event.data) {
    try {
      data = event.data.json();
    } catch (e) {
      data = { title: 'Volgo Home Stay', body: event.data.text() };
    }
  }

  const title = data.title || '🎉 New Booking Request!';
  const options = {
    body: data.body || 'A new guest booking request was received.',
    icon: data.icon || '/assets/logo/volg-logo-main.webp',
    badge: data.badge || '/assets/logo/volg-logo-main.webp',
    vibrate: [200, 100, 200, 100, 200],
    tag: data.tag || 'volgo-booking-' + (data.id || Date.now()),
    renotify: true,
    requireInteraction: true,
    data: {
      url: data.url || '/admin',
      id: data.id
    },
    actions: [
      { action: 'open', title: 'Open Admin' },
      { action: 'dismiss', title: 'Dismiss' }
    ]
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  if (event.action === 'dismiss') return;

  const targetUrl = (event.notification.data && event.notification.data.url) || '/admin';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes('/admin') && 'focus' in client) {
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    })
  );
});
