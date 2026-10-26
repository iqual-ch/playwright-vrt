// Tiny fixture site for the E2E tests: static HTML from test/e2e/fixtures, a generated
// /sitemap.xml, a request log, and per-path overrides (redirect, destroyed socket,
// alternative body).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

/**
 * @param {object} options
 * @param {Record<string, string>} options.pages     path -> fixture file name
 * @param {string[]} options.sitemap                 paths listed in /sitemap.xml (for this server's own origin)
 * @param {Record<string, string>} [options.redirects] path -> Location of a 302
 * @param {string[]} [options.destroy]               paths whose socket is destroyed without a response
 * @param {string[]} [options.challenge]             paths answered with a 403 Cloudflare challenge page
 * @param {Record<string, string>} [options.overrides] path -> fixture file served instead of pages[path]
 * @param {Record<string, number>} [options.delays]  path -> milliseconds before the response
 * @param {string} [options.fixtureDir]
 */
export async function startSite(options) {
  const {
    pages,
    sitemap,
    redirects = {},
    destroy = [],
    challenge = [],
    overrides = {},
    vars = {},
    delays = {},
    fixtureDir = FIXTURE_DIR,
  } = options;

  /** @type {{ method: string, path: string, headers: Record<string, string | string[] | undefined> }[]} */
  const requests = [];
  let origin = '';

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    const pathname = url.pathname;
    requests.push({ method: req.method || 'GET', path: pathname + url.search, headers: { ...req.headers } });
    if (delays[pathname]) await new Promise((resolve) => setTimeout(resolve, delays[pathname]));

    if (destroy.includes(pathname)) {
      req.socket.destroy();
      return;
    }

    if (challenge.includes(pathname)) {
      res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8', 'cf-mitigated': 'challenge', 'Cache-Control': 'no-store' });
      res.end('<!doctype html><html><body><h1>Just a moment...</h1></body></html>');
      return;
    }

    if (redirects[pathname]) {
      res.writeHead(302, { Location: redirects[pathname], 'Cache-Control': 'no-store' });
      res.end();
      return;
    }

    if (pathname === '/sitemap.xml') {
      const body = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
        ...sitemap.map((p) => `  <url><loc>${origin}${p}</loc></url>`),
        '</urlset>',
        '',
      ].join('\n');
      res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(body);
      return;
    }

    // Cacheable, like a CDN image.
    if (pathname.endsWith('.png')) {
      const image = path.join(fixtureDir, path.basename(pathname));
      if (fs.existsSync(image)) {
        const body = fs.readFileSync(image);
        res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': body.length, 'Cache-Control': 'max-age=3600' });
        res.end(body);
        return;
      }
    }

    const file = overrides[pathname] || pages[pathname];
    if (!file) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }

    // "{{name}}" in a page is replaced with vars[name].
    const html = Object.entries(vars).reduce((text, [name, value]) => text.replaceAll(`{{${name}}}`, value), fs.readFileSync(path.join(fixtureDir, file), 'utf-8'));
    const body = Buffer.from(html, 'utf-8');
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
    });
    res.end(body);
  });

  // No host: dual-stack listener, so "localhost" resolves to a served address over IPv4 and IPv6.
  await new Promise((resolve) => server.listen(0, resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  origin = `http://localhost:${port}`;

  return {
    port,
    origin,
    requests,
    server,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
