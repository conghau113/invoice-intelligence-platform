import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import net from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';

/** The part of a started container this file needs; tests can pass a stand-in. */
interface StartedContainer {
  getHost(): string;
  getMappedPort(port: number): number;
  stop(): Promise<unknown>;
}

const portOpen = (host: string, port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = net.connect({ host, port, timeout: 1_000 });
    const finish = (open: boolean) => {
      socket.destroy();
      resolve(open);
    };
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });

/**
 * Starts a container and checks its published port from this side. On Docker Desktop (WSL2) about 1
 * start in 200 (measured, T3.9) leaves the service running inside while the published port refuses
 * every connection for at least 60 s, so waiting does not help but a new container does. A normal
 * port opens within 100 ms. Only the infrastructure is tried again here, never a test.
 */
export async function startReachable<T extends StartedContainer>(
  start: () => Promise<T>,
  port: number,
  { attempts = 3, waitMs = 5_000 } = {},
): Promise<T> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const container = await start();
    const until = Date.now() + waitMs;
    do {
      if (await portOpen(container.getHost(), container.getMappedPort(port))) return container;
      await sleep(50);
    } while (Date.now() < until);
    console.warn(`Published port ${port} stayed closed on attempt ${attempt}: new container`);
    await container.stop();
  }
  throw new Error(`Published port ${port} stayed closed on ${attempts} new containers`);
}

export const startRedis = (): Promise<StartedTestContainer> =>
  startReachable(
    () =>
      new GenericContainer('redis:8')
        .withExposedPorts(6379)
        .withWaitStrategy(Wait.forLogMessage('Ready to accept connections'))
        .start(),
    6379,
  );
