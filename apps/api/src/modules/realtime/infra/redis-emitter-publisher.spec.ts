import { decode } from 'notepack.io';
import type { Redis } from 'ioredis';
import { RedisEmitterPublisher } from './redis-emitter-publisher';

const TENANT = '00000000-0000-4000-8000-0000000000a1';
const USER = '00000000-0000-4000-8000-00000000a11c';
const payload = { id: '00000000-0000-4000-8000-00000000d0c1', status: 'approved', version: 2 };

function fakeRedis(publish: (channel: string, message: Buffer) => Promise<number>) {
  const calls: { channel: string; message: Buffer }[] = [];
  const redis = {
    publish: (channel: string, message: Buffer) => {
      calls.push({ channel, message });
      return publish(channel, message);
    },
    disconnect: jest.fn(),
  };
  return { redis: redis as unknown as Redis, calls };
}

describe('RedisEmitterPublisher', () => {
  it("publishes on the adapter's channel of the tenant room, in the /realtime namespace", () => {
    const { redis, calls } = fakeRedis(() => Promise.resolve(1));
    const publisher = new RedisEmitterPublisher(redis);

    publisher.toTenant(TENANT, { name: 'document.updated', payload });
    publisher.toUser(TENANT, USER, { name: 'document.updated', payload });

    expect(calls.map((c) => c.channel)).toEqual([
      `socket.io#/realtime#tenant:${TENANT}#`,
      `socket.io#/realtime#tenant:${TENANT}:user:${USER}#`,
    ]);
    const first = calls[0];
    if (first === undefined) throw new Error('nothing published');
    const [, packet, opts] = decode(first.message) as [
      string,
      { data: unknown[]; nsp: string },
      { rooms: string[] },
    ];
    expect(packet.nsp).toBe('/realtime');
    expect(packet.data).toEqual(['document.updated', payload]);
    expect(opts.rooms).toEqual([`tenant:${TENANT}`]);
  });

  it('never sends a payload with a field the schema does not know', () => {
    const { redis, calls } = fakeRedis(() => Promise.resolve(1));
    const publisher = new RedisEmitterPublisher(redis);

    publisher.toTenant(TENANT, {
      name: 'document.updated',
      payload: { ...payload, sellerName: 'SAMPLE CO' } as typeof payload,
    });

    expect(calls).toEqual([]);
  });

  it('sends a notification to the user room with its own schema', () => {
    const { redis, calls } = fakeRedis(() => Promise.resolve(1));
    const publisher = new RedisEmitterPublisher(redis);
    const created = {
      id: '00000000-0000-4000-8000-00000000e001',
      kind: 'extraction_succeeded' as const,
      documentId: payload.id,
    };

    publisher.toUser(TENANT, USER, { name: 'notification.created', payload: created });

    expect(calls.map((c) => c.channel)).toEqual([
      `socket.io#/realtime#tenant:${TENANT}:user:${USER}#`,
    ]);
    const sent = calls[0];
    if (sent === undefined) throw new Error('nothing published');
    const [, packet] = decode(sent.message) as [string, { data: unknown[] }];
    expect(packet.data).toEqual(['notification.created', created]);
  });

  it.each([
    ['a field the notification schema does not know', { fileName: 'SAMPLE.pdf' }],
    // A document payload under the notification name: each event is checked by its own schema.
    ['the payload of another event', { status: 'approved', version: 2 }],
  ])('never sends a notification with %s', (_name, extra) => {
    const { redis, calls } = fakeRedis(() => Promise.resolve(1));
    const publisher = new RedisEmitterPublisher(redis);

    publisher.toUser(TENANT, USER, {
      name: 'notification.created',
      payload: {
        id: '00000000-0000-4000-8000-00000000e001',
        kind: 'extraction_failed',
        documentId: payload.id,
        ...extra,
      } as never,
    });

    expect(calls).toEqual([]);
  });

  it('does not throw or leave a rejected promise behind when Redis is down', async () => {
    const { redis } = fakeRedis(() =>
      Promise.reject(new Error('Connection is closed. redis-host:6379')),
    );
    const publisher = new RedisEmitterPublisher(redis);
    const unhandled = jest.fn();
    process.on('unhandledRejection', unhandled);
    try {
      expect(() => publisher.toTenant(TENANT, { name: 'document.updated', payload })).not.toThrow();
      await new Promise((r) => setImmediate(r));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});
