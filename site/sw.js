// The guest page's service worker: shows a notification when the owner answers (a web push the owner's PC sends through Firebase Cloud
// Messaging, data only: {title, body, link}) and opens or focuses the page when it is tapped. No Firebase code, nothing cached.
const text = (v, max) => (typeof v === "string" ? v.slice(0, max) : "");
/** Only this page's own address is ever opened. */
const pageLink = (v) => (typeof v === "string" && v.startsWith(self.registration.scope) ? v : self.registration.scope);

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (e) => {
  let p = {};
  try {
    p = e.data ? e.data.json() : {};
  } catch {}
  const d = (p && p.data) || {};
  const n = (p && p.notification) || {};
  const title = text(d.title || n.title, 80) || "New reply";
  const body = text(d.body || n.body, 200) || "You have a new reply.";
  const link = pageLink(d.link || (p && p.fcmOptions && p.fcmOptions.link));
  e.waitUntil(self.registration.showNotification(title, { body, tag: "guest-reply", renotify: true, icon: "icon.svg", data: { link } }));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const link = pageLink(e.notification.data && e.notification.data.link);
  e.waitUntil(
    (async () => {
      const open = (await self.clients.matchAll({ type: "window", includeUncontrolled: true })).find((c) => c.url.startsWith(self.registration.scope));
      return open ? open.focus() : self.clients.openWindow(link);
    })(),
  );
});
