import { createServer, type Server } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Minimal static server for the test fixture app.
 *
 * Deliberately built on `node:http` rather than pulled in as a dependency. Tests are the only
 * thing that needs it, and every extra dependency is one more thing that can break a render.
 *
 * It binds to port 0 and reports the assigned port, so parallel test files never collide.
 */

const here = fileURLToPath(new URL('.', import.meta.url));

/** Source of truth for the fixture site. Never written to; only read. */
export const FIXTURE_ROOT = join(here, '..', 'fixture-app', 'site');

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

export interface FixtureServer {
  /** Absolute URL for a site-relative path, e.g. `server.url('/')`. */
  url(path?: string): string;
  /** The port the OS assigned. */
  port: number;
  close(): Promise<void>;
}

/**
 * Serve the fixture app on an ephemeral port.
 *
 * @param options.delayMs Artificial latency before responding. Used to test that the framework
 *   waits on application state rather than on a fixed sleep.
 */
export async function createFixtureServer(
  options: { delayMs?: number } = {},
): Promise<FixtureServer> {
  const server: Server = createServer((request, response) => {
    const send = async (): Promise<void> => {
      const requested = new URL(request.url ?? '/', 'http://localhost').pathname;
      // Normalise before joining so `../` in a URL cannot escape the fixture root.
      const relative = normalize(requested).replace(/^(\.\.[/\\])+/, '');
      let filePath = join(FIXTURE_ROOT, relative);

      if (!filePath.startsWith(FIXTURE_ROOT)) {
        response.writeHead(403).end('Forbidden');
        return;
      }

      // A static site needs directory index resolution, and `readFile` on a directory throws
      // EISDIR, so the path is resolved with stat before reading.
      const stats = await stat(filePath).catch(() => null);
      if (stats?.isDirectory()) {
        filePath = join(filePath, 'index.html');
      }

      try {
        const body = await readFile(filePath);

        response.writeHead(200, {
          'content-type': CONTENT_TYPES[extname(filePath)] ?? 'application/octet-stream',
          // Deterministic caching: a stale cached page would make two runs differ.
          'cache-control': 'no-store',
        });
        response.end(body);
      } catch {
        response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found');
      }
    };

    if (options.delayMs) {
      setTimeout(() => void send(), options.delayMs);
    } else {
      void send();
    }
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Fixture server did not bind to a TCP port.');
  }

  return {
    port: address.port,
    url: (path = '/') => `http://127.0.0.1:${address.port}${path}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
