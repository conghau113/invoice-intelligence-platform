import type { INestApplication, INestApplicationContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { REALTIME_PATH } from 'contracts';
import type { IncomingMessage } from 'node:http';
import { Redis } from 'ioredis';
import type { Server, ServerOptions } from 'socket.io';
import type { Env } from '../../../config/env.schema';

export interface RealtimeAdapterOptions {
  redisUrl: string;
  allowedOrigins: readonly string[];
}

/**
 * Socket.IO server of the API (T6.4). The Redis adapter is what lets several API instances serve
 * one stream: an event published by any process (worker or API) reaches every instance through
 * Redis pub/sub, and each instance hands it to its own sockets in that room.
 *
 * WebSocket transport only: HTTP long-polling spreads one session over several requests, which a
 * load balancer would have to pin to one instance (sticky sessions). Without it any instance can
 * take any connection. A browser where WebSocket is blocked falls back to the web's polling.
 */
export class RealtimeIoAdapter extends IoAdapter {
  private readonly connections: Redis[] = [];

  constructor(
    app: INestApplicationContext,
    private readonly options: RealtimeAdapterOptions,
  ) {
    super(app);
  }

  override createIOServer(port: number, options?: ServerOptions): Server {
    const allowed = new Set(this.options.allowedOrigins);
    const server = super.createIOServer(port, {
      ...options,
      path: REALTIME_PATH,
      transports: ['websocket'],
      serveClient: false,
      // Clients send nothing but the handshake; a large frame is never legitimate.
      maxHttpBufferSize: 4 * 1024,
      // Cross-site WebSocket hijacking guard. The token already protects the stream (it is not a
      // cookie), so this only keeps other sites' pages from opening sockets at all.
      allowRequest: (req: IncomingMessage, callback: (err: string | null, ok: boolean) => void) => {
        const origin = req.headers.origin;
        callback(null, origin !== undefined && allowed.has(origin));
      },
    }) as Server;
    // Two connections: a subscribed Redis connection can do nothing else. Offline queue on, no
    // per-command retry limit: while Redis is down the adapter waits, then ioredis resubscribes.
    const pub = new Redis(this.options.redisUrl, { maxRetriesPerRequest: null });
    const sub = pub.duplicate();
    for (const c of [pub, sub]) {
      c.on('error', () => undefined); // the message holds the host; reconnects are automatic
      this.connections.push(c);
    }
    server.adapter(createAdapter(pub, sub));
    // The root namespace "/" always exists in Socket.IO. Nothing is served there: refuse every
    // handshake, so a client cannot hold a connection without a token by asking for "/".
    server.of('/').use((_socket, next) => next(new Error('UNAUTHORIZED')));
    return server;
  }

  override async close(server: Server): Promise<void> {
    await super.close(server);
    await Promise.all(this.connections.map((c) => c.quit().catch(() => c.disconnect())));
  }
}

/** Installs the adapter on the app (main.ts, and the tests that run the real gateway). */
export function useRealtimeAdapter(app: INestApplication): void {
  const config = app.get(ConfigService<Env, true>);
  app.useWebSocketAdapter(
    new RealtimeIoAdapter(app, {
      redisUrl: config.get('REDIS_URL', { infer: true }),
      allowedOrigins: config.get('REALTIME_ALLOWED_ORIGINS', { infer: true }),
    }),
  );
}
