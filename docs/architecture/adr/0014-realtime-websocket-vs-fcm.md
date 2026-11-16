# ADR 0014: Realtime updates: WebSocket (Socket.IO) in-app; push notifications optional

- Status: Accepted
- Date: 2026-10-11
- Updated: 2026-11-16 (T6.5: experience from T6.4 and T6.5 recorded; decision unchanged)

## Context
Users wait for extraction results. In a previous interview the trade-off between Firebase Cloud Messaging and WebSockets came up; this ADR records the reasoning.

## Options considered
1. Polling
2. Server-Sent Events
3. WebSocket (Socket.IO)
4. FCM web push

## Decision criteria
- Delivery while the tab is open vs closed
- Bidirectional need
- Infrastructure dependency
- Scaling across instances

## Decision
Socket.IO with JWT handshake and Redis adapter for in-app progress while the app is open; persisted in-app notifications for when the user was offline; FCM web push is optional (out of core scope). SSE is used for Q&A streaming (one-way).

## Consequences
- + WebSocket: low latency, server-controlled, works across instances with the Redis adapter
- + FCM would reach users with the tab closed but adds Google dependency and service worker complexity
- − Socket connections need auth refresh handling

## Revisit when
If users need alerts with the app closed (mobile), add FCM.

## Experience (T6.4, T6.5)
What building it taught, measured on the dev machine. The decision stands.

**Online delivery (Socket.IO, T6.4).**
- Latency: `queued → processing → needs_review` of an XML file reaches the browser about 50 ms apart, a few tens of ms after each COMMIT; polling showed the same change up to 5 s (list) or 2 s (detail) late, and asked even when nothing changed.
- Several instances: two API processes (3001, 3002) behind one Redis adapter both received every event, at most 2 ms apart; the worker, which has no Socket.IO server, publishes through `@socket.io/redis-emitter`. WebSocket transport only, so no sticky sessions are needed.
- Auth refresh, the cost this ADR expected, was the largest part of the work: the browser never holds the Keycloak token (ADR 0006), so the API issues a 60 s handshake token (`aud=realtime`) through the BFF, the server closes every socket after 15 minutes, and the client reconnects with a fresh token, backing off when a handshake is refused. A signed-out user loses the stream within that time.
- Events are hints, not data: the client reads again through REST (RLS applies), after every reconnect, and keeps a slow safety poll, because an event can be lost (a dropped socket, Redis down for a moment). Polling stays as the fallback when the socket cannot connect (realtime off on the public demo, a proxy blocking WebSocket).

**Offline delivery (stored notifications, T6.5).**
- A socket only reaches an open tab. The end of an extraction (`extraction_succeeded`, `extraction_failed`) is therefore stored in a `notifications` table for the uploader, in the same transaction as the status change: a committed change always has its notification, a rolled-back one never does, and no crash between two writes can lose it. Writing it after COMMIT (an event listener or a job) was rejected for exactly that gap. The price, accepted on purpose: if the insert fails, the status change rolls back with it and the job is retried. The insert can only fail where the status update itself could (same database, same transaction; codes outside the shared list are stored as null), so it adds no new way to get stuck.
- The same row is then pushed as `notification.created` to the user's room after COMMIT. Online, the bell updates within the socket latency above; offline, the user finds it in the list on the next visit, with an unread count. The push carries ids and a kind only; the web writes the sentence in the user's language.
- Only the uploader is told, and only about the end of an extraction: 50 uploads must not become 50 × every member notifications. Bursts of events are coalesced into a few reads.

**FCM web push** stays optional and out of core scope. Stored notifications cover "I closed the tab and came back"; FCM would only add "tell me while no tab is open", at the price of a Google dependency, a service worker, a permission prompt, push subscriptions to store and expire per device, and a second delivery path to keep consistent with the stored list. If added, the notification row stays the source of truth and FCM is one more push after COMMIT, like the socket.
