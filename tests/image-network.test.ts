import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadImageSource } from '../src/image.js';

/**
 * `src/image.ts` has no SSRF guard of its own. It calls `downloadBlob`, which does:
 * `validateDownloadUrl` on every redirect hop (protocol, localhost/.local, literal
 * private IPv4/IPv6, and every IPv4-embedded IPv6 form re-checked as IPv4), plus a
 * `connect.lookup` that validates every resolved A/AAAA record at connect time, which
 * is what closes DNS rebinding.
 *
 * That protection is transitive and invisible at the call site, and swapping those two
 * lines for a plain `fetch` would drop it silently. These tests exist so that swap fails.
 */

const TINY_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

let server: Server;
let origin: string;
let hits: number;

beforeAll(async () => {
  hits = 0;
  server = createServer((_req, res) => {
    hits += 1;
    res.writeHead(200, { 'content-type': 'image/png' });
    res.end(TINY_PNG);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
});

function withPort(path: string): string {
  return `${origin}${path}`;
}

describe('image loading refuses destinations that reveal the machine', () => {
  it.each([
    ['cloud metadata link-local', 'http://169.254.169.254/latest/meta-data/'],
    ['private class A', 'http://10.0.0.5/x.png'],
    ['private class B', 'http://172.20.1.1/x.png'],
    ['private class C', 'http://192.168.1.1/x.png'],
    ['carrier NAT', 'http://100.64.0.1/x.png'],
    ['benchmark range', 'http://198.18.0.1/x.png'],
    ['this-network', 'http://0.0.0.0/x.png'],
    ['localhost by name', 'http://localhost:8080/x.png'],
    ['mDNS name', 'http://printer.local/x.png'],
    ['localhost suffix', 'http://app.localhost/x.png'],
    ['IPv6 unique local', 'http://[fd00::1]/x.png'],
    ['IPv6 link-local', 'http://[fe80::1]/x.png'],
    ['IPv6 multicast', 'http://[ff02::1]/x.png'],
    ['IPv4-mapped loopback', 'http://[::ffff:127.0.0.1]/x.png'],
    ['IPv4-mapped metadata', 'http://[::ffff:169.254.169.254]/x.png'],
    ['IPv4-compatible loopback', 'http://[::127.0.0.1]/x.png'],
    ['NAT64 loopback', 'http://[64:ff9b::7f00:1]/x.png'],
    ['NAT64 local-use', 'http://[64:ff9b:1::7f00:1]/x.png'],
    ['malformed IPv6 fails closed', 'http://[:::1]/x.png'],
    ['file scheme', 'file:///C:/Windows/win.ini'],
    ['ftp scheme', 'ftp://example.com/x'],
    ['gopher scheme', 'gopher://example.com/x'],
  ])('refuses %s', async (_label, url) => {
    await expect(loadImageSource(url, 'url', AbortSignal.timeout(5_000))).rejects.toThrow();
  });

  it('refuses loopback and never reaches the internal server it was pointed at', async () => {
    const before = hits;
    await expect(loadImageSource(withPort('/internal-secret.png'), 'url', AbortSignal.timeout(5_000))).rejects.toThrow();
    await expect(
      loadImageSource(withPort('/internal-secret.png').replace('127.0.0.1', '[::1]'), 'url', AbortSignal.timeout(5_000)),
    ).rejects.toThrow();
    expect(hits).toBe(before);
  });

  it('refuses credentials embedded in the URL before any request', async () => {
    await expect(loadImageSource('http://user:pw@example.com/x.png', 'url', AbortSignal.timeout(5_000))).rejects.toThrow('credentials');
  });

  it('still accepts a normal public https image', async () => {
    // Only the guard is under test here; the request itself is allowed to fail on the
    // network, so this asserts the failure is not a "not allowed" refusal.
    try {
      await loadImageSource('https://example.com/x.png', 'url', AbortSignal.timeout(8_000));
    } catch (error) {
      expect(String((error as Error).message)).not.toMatch(/not allowed|scheme must be/i);
    }
  });
});
