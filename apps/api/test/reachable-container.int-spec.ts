import net from 'node:net';
import { startReachable } from './support/reachable-container';

const INNER_PORT = 6379;

/** A free port with nothing listening on it: connecting is refused, like the fault on Docker Desktop. */
async function closedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as net.AddressInfo;
  await new Promise((r) => server.close(r));
  return port;
}

describe('startReachable', () => {
  const servers: net.Server[] = [];
  afterAll(() => Promise.all(servers.map((s) => new Promise((r) => s.close(r)))));

  async function openPort(): Promise<number> {
    const server = net.createServer((socket) => socket.destroy());
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    return (server.address() as net.AddressInfo).port;
  }

  const standIn = (port: number) => ({
    getHost: () => '127.0.0.1',
    getMappedPort: (inner: number) => {
      expect(inner).toBe(INNER_PORT);
      return port;
    },
    stop: jest.fn(() => Promise.resolve()),
  });
  const fast = { attempts: 3, waitMs: 100 };

  it('keeps a container whose published port answers', async () => {
    const good = standIn(await openPort());
    const start = jest.fn(() => Promise.resolve(good));
    await expect(startReachable(start, INNER_PORT, fast)).resolves.toBe(good);
    expect(start).toHaveBeenCalledTimes(1);
    expect(good.stop).not.toHaveBeenCalled();
  });

  it('stops a container whose published port refuses, and uses a new one', async () => {
    const dead = standIn(await closedPort());
    const good = standIn(await openPort());
    const start = jest.fn<Promise<typeof dead>, []>();
    start.mockResolvedValueOnce(dead).mockResolvedValueOnce(good);
    await expect(startReachable(start, INNER_PORT, fast)).resolves.toBe(good);
    expect(dead.stop).toHaveBeenCalledTimes(1);
    expect(good.stop).not.toHaveBeenCalled();
  });

  it('gives up with an error after the last attempt, leaving no container running', async () => {
    const dead = [standIn(await closedPort()), standIn(await closedPort())];
    const start = jest.fn<Promise<(typeof dead)[number]>, []>();
    start.mockResolvedValueOnce(dead[0]!).mockResolvedValueOnce(dead[1]!);
    await expect(startReachable(start, INNER_PORT, { attempts: 2, waitMs: 100 })).rejects.toThrow(
      /stayed closed on 2 new containers/,
    );
    for (const container of dead) expect(container.stop).toHaveBeenCalledTimes(1);
  });

  it('waits for a port that opens a moment after the container starts', async () => {
    const server = net.createServer((socket) => socket.destroy());
    servers.push(server);
    const port = await closedPort();
    const late = setTimeout(() => server.listen(port, '127.0.0.1'), 200);
    const container = standIn(port);
    const result = await startReachable(() => Promise.resolve(container), INNER_PORT, {
      attempts: 1,
      waitMs: 3_000,
    });
    clearTimeout(late);
    expect(result).toBe(container);
    expect(container.stop).not.toHaveBeenCalled();
  });
});
