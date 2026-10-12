# ADR 0014: Realtime updates: WebSocket (Socket.IO) in-app; push notifications optional

- Status: Accepted
- Date: 2026-10-11

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
