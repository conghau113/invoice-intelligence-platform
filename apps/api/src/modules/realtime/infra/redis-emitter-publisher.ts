import { Logger, type OnApplicationShutdown } from '@nestjs/common';
import { Emitter } from '@socket.io/redis-emitter';
import { DocumentUpdatedEventSchema } from 'contracts';
import type { Redis } from 'ioredis';
import type { RealtimeEvent, RealtimePublisher } from '../application/realtime-publisher.port';
import { REALTIME_NAMESPACE, tenantRoom, userRoom } from '../domain/rooms';

/**
 * Publishes through Redis in the Socket.IO adapter's own format (`@socket.io/redis-emitter`): every
 * API instance's Redis adapter receives the message and hands it to the sockets in that room that
 * are connected to it. Works the same from the worker process, which has no Socket.IO server.
 */
export class RedisEmitterPublisher implements RealtimePublisher, OnApplicationShutdown {
  private readonly logger = new Logger(RedisEmitterPublisher.name);
  private readonly emitter: Emitter;

  constructor(private readonly redis: Redis) {
    // The emitter drops the promise `publish` returns: with Redis down it would reject unhandled
    // and crash the process. This client catches it; the event is lost, the client catches up.
    const client = {
      publish: (channel: string, message: string | Buffer): void => {
        redis.publish(channel, message).catch(() => {
          // Ids only would be safe, but there is nothing useful to add: the reason holds a host.
          this.logger.warn('Realtime publish failed (REALTIME_UNAVAILABLE)');
        });
      },
    };
    this.emitter = new Emitter(client).of(REALTIME_NAMESPACE);
  }

  onApplicationShutdown(): void {
    // Nothing waits on a publish, so there is nothing to drain.
    this.redis.disconnect();
  }

  toTenant(tenantId: string, event: RealtimeEvent): void {
    this.send(tenantRoom(tenantId), event);
  }

  toUser(tenantId: string, userId: string, event: RealtimeEvent): void {
    this.send(userRoom(tenantId, userId), event);
  }

  private send(room: string, event: RealtimeEvent): void {
    // Strict schema: a field added by mistake (content, a name) is never sent to browsers.
    const parsed = DocumentUpdatedEventSchema.safeParse(event.payload);
    if (!parsed.success) {
      this.logger.error(`Realtime event refused by its schema (${event.name})`);
      return;
    }
    this.emitter.to(room).emit(event.name, parsed.data);
  }
}
