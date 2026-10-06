/*
 * Service worker for notifications on this device (PRODUCT.md P4-T08). It does two things:
 * shows an alert that arrives by web push, and acts when the notification or its "Acknowledge"
 * button is tapped. It caches nothing: the app always loads from the network.
 *
 * A push message is JSON: { title, body, url, tag, incidentNumber, kind, acknowledgeUrl }.
 * `acknowledgeUrl` is a signed, single-use link (https://app/a/<token>); the worker posts the token
 * to /api/actions/<token>, which needs no session, so it works with the app closed.
 */
self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

/* The message as an object; an unreadable one still shows a plain notification. */
function payloadOf(event) {
  try {
    return event.data ? event.data.json() : {};
  } catch {
    return {};
  }
}

self.addEventListener("push", (event) => {
  const data = payloadOf(event);
  const open = data.kind === "triggered" || data.kind === "reminder" || data.kind === "flapping";
  event.waitUntil(
    self.registration.showNotification(data.title || "Watchpost alert", {
      body: data.body || "",
      tag: data.tag || "watchpost",
      /* A later state of the same incident replaces the notification and buzzes again. */
      renotify: true,
      /* An open incident stays on screen until someone looks at it. */
      requireInteraction: open,
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      data: { url: data.url || "/", acknowledgeUrl: data.acknowledgeUrl || null },
      actions: data.acknowledgeUrl
        ? [
            { action: "acknowledge", title: "Acknowledge" },
            { action: "open", title: "Open" },
          ]
        : [{ action: "open", title: "Open" }],
    }),
  );
});

async function openIncident(url) {
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const client of windows) {
    if ("focus" in client && "navigate" in client) {
      await client.navigate(url);
      return client.focus();
    }
  }
  return self.clients.openWindow(url);
}

async function acknowledge(data) {
  const token = new URL(data.acknowledgeUrl).pathname.split("/").filter(Boolean).pop();
  try {
    const res = await fetch(`/api/actions/${token}`, { method: "POST" });
    if (res.ok) {
      const outcome = await res.json();
      const number = outcome && outcome.incident ? `#${outcome.incident.number} ` : "";
      await self.registration.showNotification(`${number}acknowledged`, {
        body: "Further escalation steps are stopped.",
        tag: "watchpost-ack",
        icon: "/icons/icon-192.png",
        data: { url: data.url, acknowledgeUrl: null },
      });
      return;
    }
  } catch {
    /* Offline or refused: fall through and open the incident, where it can be done by hand. */
  }
  await openIncident(data.url);
}

self.addEventListener("notificationclick", (event) => {
  const data = event.notification.data || { url: "/" };
  event.notification.close();
  event.waitUntil(
    event.action === "acknowledge" && data.acknowledgeUrl
      ? acknowledge(data)
      : openIncident(data.url),
  );
});
