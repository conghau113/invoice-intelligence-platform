import { Inject, Optional } from '@nestjs/common';
import {
  WebSocketGateway,
  type OnGatewayConnection,
  type OnGatewayDisconnect,
  type OnGatewayInit,
} from '@nestjs/websockets';
import { randomInt } from 'node:crypto';
import type { Namespace, Socket } from 'socket.io';
import type { RealtimeIdentity, RealtimeTokenService } from '../application/realtime-token.service';
import { REALTIME_NAMESPACE, tenantRoom, userRoom } from '../domain/rooms';

export const REALTIME_TOKENS = Symbol('REALTIME_TOKENS');
export const REALTIME_MAX_CONNECTION_MS = Symbol('REALTIME_MAX_CONNECTION_MS');

/** The one message a refused handshake gets: the reason (expired, bad signature...) is not exposed. */
export const UNAUTHORIZED = 'UNAUTHORIZED';

interface SocketData {
  identity?: RealtimeIdentity;
  expiry?: NodeJS.Timeout;
}

/**
 * Socket.IO gateway (T6.4, ADR 0014). Server to client only: it declares no message handler, so a
 * client can do nothing but listen. The handshake must carry a realtime token (`auth.token`) issued
 * by `POST /realtime/token`; the socket then joins its tenant's room and its own user room in that
 * tenant, and nothing else. Events come from Redis (RedisEmitterPublisher), never from a client.
 *
 * A socket lives at most `REALTIME_MAX_CONNECTION_MS` (minus up to 10%, so sockets opened together
 * do not all reconnect together). The client then reconnects with a fresh token, which the web only
 * issues to a signed-in member of the tenant: that is how a sign-out or a removed role reaches an
 * open socket (ADR 0014, "socket connections need auth refresh handling").
 */
@WebSocketGateway({ namespace: REALTIME_NAMESPACE })
export class RealtimeGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  constructor(
    // Absent when REALTIME_TOKEN_SECRET is not set: realtime is off and every handshake is refused.
    @Optional() @Inject(REALTIME_TOKENS) private readonly tokens: RealtimeTokenService | null,
    @Inject(REALTIME_MAX_CONNECTION_MS) private readonly maxConnectionMs: number,
  ) {}

  afterInit(nsp: Namespace): void {
    nsp.use((socket, next) => {
      const token: unknown = (socket.handshake.auth as Record<string, unknown> | undefined)?.token;
      if (this.tokens === null || typeof token !== 'string' || token.length > 2048) {
        next(new Error(UNAUTHORIZED));
        return;
      }
      this.tokens.verify(token).then(
        (identity) => {
          (socket.data as SocketData).identity = identity;
          next();
        },
        () => next(new Error(UNAUTHORIZED)),
      );
    });
  }

  async handleConnection(socket: Socket): Promise<void> {
    const data = socket.data as SocketData;
    const identity = data.identity;
    if (identity === undefined) {
      socket.disconnect(true); // cannot happen past the middleware; fail closed anyway
      return;
    }
    await socket.join([
      tenantRoom(identity.tenantId),
      userRoom(identity.tenantId, identity.userId),
    ]);
    const lifetime = this.maxConnectionMs - randomInt(0, Math.floor(this.maxConnectionMs / 10) + 1);
    data.expiry = setTimeout(() => socket.disconnect(true), lifetime);
    data.expiry.unref();
  }

  handleDisconnect(socket: Socket): void {
    clearTimeout((socket.data as SocketData).expiry);
  }
}
