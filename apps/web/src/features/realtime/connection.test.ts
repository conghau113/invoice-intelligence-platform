import type { DocumentUpdatedEvent } from 'contracts';
import { describe, expect, it } from 'vitest';
import { RealtimeConnection, type AuthCallback, type SocketLike } from './connection';
import type { TokenResult } from './token-client';

const EVENT: DocumentUpdatedEvent = {
  id: '00000000-0000-4000-8000-00000000d0c1',
  status: 'needs_review',
  version: 1,
};

/** A socket.io-client stand-in: the test fires its events by hand. */
class FakeSocket implements SocketLike {
  active = true;
  connects = 0;
  disconnected = false;
  private readonly handlers = new Map<string, ((arg?: unknown) => void)[]>();

  constructor(
    readonly url: string,
    readonly auth: AuthCallback,
  ) {}

  on(event: string, fn: (arg: never) => void): this {
    // Untyped store: the test fires each event with the argument socket.io would pass.
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), fn as (arg?: unknown) => void]);
    return this;
  }

  fire(event: string, arg?: unknown): void {
    for (const fn of this.handlers.get(event) ?? []) fn(arg);
  }
  connect(): this {
    this.connects += 1;
    return this;
  }
  disconnect(): this {
    this.disconnected = true;
    return this;
  }
  /** What the handshake would send now. */
  handshake(): Promise<{ token?: string }> {
    return new Promise((resolve) => this.auth(resolve));
  }
}

function setup(tokens: TokenResult[]) {
  const sockets: FakeSocket[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  let fetches = 0;
  const clock = { now: 1_000_000 };
  const conn = new RealtimeConnection({
    fetchToken: () => {
      fetches += 1;
      return Promise.resolve(tokens.shift() ?? { kind: 'error' });
    },
    createSocket: (url, auth) => {
      const s = new FakeSocket(url, auth);
      sockets.push(s);
      return s;
    },
    setTimer: (fn, ms) => timers.push({ fn, ms }),
    clearTimer: () => undefined,
    random: () => 1,
    now: () => clock.now,
  });
  const events: DocumentUpdatedEvent[] = [];
  let resyncs = 0;
  conn.onEvent((e) => events.push(e));
  conn.onResync(() => (resyncs += 1));
  const flush = () => new Promise((r) => setTimeout(r, 0));
  const socket = () => {
    const s = sockets.at(-1);
    if (s === undefined) throw new Error('no socket');
    return s;
  };
  return {
    conn,
    sockets,
    timers,
    events,
    flush,
    socket,
    resyncs: () => resyncs,
    fetches: () => fetches,
    clock,
  };
}

const ok = (token = 't1'): TokenResult => ({ kind: 'ok', token, url: 'http://api.test' });

describe('RealtimeConnection', () => {
  it('connects with the first token, then passes on valid events only', async () => {
    const t = setup([ok('t1')]);
    await t.conn.start();
    expect(t.socket().url).toBe('http://api.test');
    expect(await t.socket().handshake()).toEqual({ token: 't1' });
    expect(t.conn.getStatus()).toBe('connecting');

    t.socket().fire('connect');
    t.socket().fire('document.updated', EVENT);
    t.socket().fire('document.updated', { ...EVENT, sellerName: 'SAMPLE' }); // unknown field
    t.socket().fire('document.updated', 'garbage');

    expect(t.conn.getStatus()).toBe('connected');
    expect(t.events).toEqual([EVENT]);
    expect(t.resyncs()).toBe(0); // the first connect is not a reconnect
  });

  it('fetches a fresh token for every later handshake', async () => {
    const t = setup([ok('t1'), ok('t2')]);
    await t.conn.start();
    await t.socket().handshake();
    expect(await t.socket().handshake()).toEqual({ token: 't2' });
  });

  it('after a drop: polls (disconnected) and, once back, resyncs because events were missed', async () => {
    const t = setup([ok()]);
    await t.conn.start();
    t.socket().fire('connect');
    t.clock.now += 60_000;
    t.socket().fire('disconnect', 'transport close');
    expect(t.conn.getStatus()).toBe('disconnected');
    expect(t.socket().connects).toBe(0); // socket.io retries a dropped connection by itself

    t.socket().fire('connect');
    expect(t.conn.getStatus()).toBe('connected');
    expect(t.resyncs()).toBe(1);
  });

  it('reconnects at once when the server closes the socket at its maximum age', async () => {
    const t = setup([ok()]);
    await t.conn.start();
    t.socket().fire('connect');
    t.clock.now += 15 * 60_000;
    t.socket().fire('disconnect', 'io server disconnect');
    expect(t.socket().connects).toBe(1);
  });

  it('after a refused handshake, checks for a token later and retries with it', async () => {
    const t = setup([ok('t1'), ok('t2')]);
    await t.conn.start();
    t.socket().active = false; // socket.io gives up on a middleware refusal
    t.socket().fire('connect_error', new Error('UNAUTHORIZED'));
    expect(t.conn.getStatus()).toBe('disconnected');
    expect(t.timers).toHaveLength(1);
    expect(t.timers[0]?.ms).toBe(2_000);

    t.timers[0]?.fn();
    await t.flush();
    expect(t.socket().connects).toBe(1);
    expect(await t.socket().handshake()).toEqual({ token: 't2' });
  });

  it('backs off: 2 s, 4 s, 8 s ... up to a minute', async () => {
    const t = setup([ok(), ...Array.from({ length: 8 }, () => ok())]);
    await t.conn.start();
    for (let i = 0; i < 8; i += 1) {
      t.socket().active = false;
      t.socket().fire('connect_error', new Error('UNAUTHORIZED'));
      t.timers.at(-1)?.fn();
      await t.flush();
    }
    expect(t.timers.map((x) => x.ms)).toEqual([
      2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 60_000,
    ]);
  });

  it.each([{ kind: 'off' }, { kind: 'signed-out' }] as const)(
    'turns off and closes the socket when the token answer is %o',
    async (answer) => {
      const t = setup([ok(), answer]);
      await t.conn.start();
      t.socket().active = false;
      t.socket().fire('connect_error', new Error('UNAUTHORIZED'));
      t.timers[0]?.fn();
      await t.flush();
      expect(t.conn.getStatus()).toBe('off');
      expect(t.socket().disconnected).toBe(true);
      expect(t.socket().connects).toBe(0);
    },
  );

  it('signed out is final; off is checked again five minutes later and may come back', async () => {
    const out = setup([{ kind: 'signed-out' }]);
    await out.conn.start();
    expect(out.timers).toEqual([]);

    const off = setup([{ kind: 'off' }, ok('back')]);
    await off.conn.start();
    expect(off.conn.getStatus()).toBe('off');
    expect(off.timers.map((x) => x.ms)).toEqual([300_000]);
    off.timers[0]?.fn();
    await off.flush();
    expect(off.sockets).toHaveLength(1);
    expect(await off.socket().handshake()).toEqual({ token: 'back' });
  });

  it('an off re-check scheduled before stop does nothing after it', async () => {
    const t = setup([{ kind: 'off' }, ok()]);
    await t.conn.start();
    t.conn.stop();
    t.timers[0]?.fn();
    await t.flush();
    expect(t.sockets).toHaveLength(0);
  });

  it('a socket the server closes right after opening backs off instead of reconnecting at once', async () => {
    const t = setup([ok(), ok('t2')]);
    await t.conn.start();
    t.socket().fire('connect');
    t.clock.now += 100;
    t.socket().fire('disconnect', 'io server disconnect');
    expect(t.socket().connects).toBe(0);
    expect(t.timers.map((x) => x.ms)).toEqual([2_000]);
    t.timers[0]?.fn();
    await t.flush();
    expect(t.socket().connects).toBe(1);
    expect(await t.socket().handshake()).toEqual({ token: 't2' });
  });

  it('an old socket is never revived by its pending retry after stop and a new start', async () => {
    let release!: (r: TokenResult) => void;
    const t = setup([ok('t1')]);
    await t.conn.start();
    const old = t.socket();
    old.active = false;
    old.fire('connect_error', new Error('UNAUTHORIZED'));
    // The retry's token request is still on its way when the provider remounts.
    const pending = new Promise<TokenResult>((r) => (release = r));
    const retry = t.timers[0];
    (t.conn as unknown as { deps: { fetchToken: () => Promise<TokenResult> } }).deps.fetchToken =
      () => pending;
    retry?.fn();
    t.conn.stop();
    const restarted = t.conn.start();
    release({ kind: 'ok', token: 'late', url: 'http://api.test' });
    await restarted;
    await t.flush();

    expect(old.connects).toBe(0);
    expect(t.sockets.filter((s) => s !== old)).toHaveLength(1);
  });

  it('never opens a socket when realtime is off from the start', async () => {
    const t = setup([{ kind: 'off' }]);
    await t.conn.start();
    expect(t.sockets).toHaveLength(0);
    expect(t.conn.getStatus()).toBe('off');
  });

  it('retries the first token request after an error', async () => {
    const t = setup([{ kind: 'error' }, ok()]);
    await t.conn.start();
    expect(t.conn.getStatus()).toBe('disconnected');
    t.timers[0]?.fn();
    await t.flush();
    expect(t.sockets).toHaveLength(1);
  });

  it('stop closes the socket and nothing runs afterwards', async () => {
    const t = setup([ok(), ok()]);
    await t.conn.start();
    t.socket().active = false;
    t.socket().fire('connect_error', new Error('UNAUTHORIZED'));
    t.conn.stop();
    t.timers[0]?.fn();
    await t.flush();
    expect(t.socket().disconnected).toBe(true);
    expect(t.socket().connects).toBe(0);
    expect(t.fetches()).toBe(1);
  });
});

describe('RealtimeConnection started twice (React development mode)', () => {
  it('drops the first start when stop came before its token, and the second start connects', async () => {
    let release!: (r: TokenResult) => void;
    const answers: Promise<TokenResult>[] = [
      new Promise((r) => (release = r)),
      Promise.resolve({ kind: 'ok', token: 't2', url: 'http://api.test' }),
    ];
    const made: string[] = [];
    const conn = new RealtimeConnection({
      fetchToken: () => answers.shift() ?? Promise.resolve({ kind: 'error' }),
      createSocket: (url, auth) => {
        made.push(url);
        return new FakeSocket(url, auth);
      },
      setTimer: () => undefined,
      clearTimer: () => undefined,
      random: () => 1,
      now: () => 0,
    });
    const first = conn.start();
    conn.stop();
    await conn.start();
    release({ kind: 'ok', token: 't1', url: 'http://late.test' });
    await first;
    expect(made).toEqual(['http://api.test']);
  });
});
