import { test, expect } from '@playwright/test';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// ESM equivalent of __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load URLs from playwright-snapshots/ (shared with snapshots for easy caching)
const urlsPath = join(process.cwd(), 'playwright-snapshots', 'urls.json');

// CSS file is in the same directory as this test file
const stylePath = join(__dirname, 'vrt.css');

if (!existsSync(urlsPath)) {
  throw new Error(`URLs file not found at ${urlsPath}. Did you run URL collection?`);
}

const urls = JSON.parse(readFileSync(urlsPath, 'utf-8'));

// Load config for threshold settings
const vrtConfig = process.env.VRT_CONFIG
  ? JSON.parse(process.env.VRT_CONFIG)
  : {};

const threshold = vrtConfig.threshold || {
  maxDiffPixels: 100,
  maxDiffPixelRatio: 0.01,
};

const blockHosts = (vrtConfig.blockHosts || []).map(hostPatternToRegExp);

// Headers go to the hosts under test only; on third-party hosts they would fail the CORS preflight.
const scopedHeaders = vrtConfig.extraHTTPHeaders || {};
const ownHosts = new Set(
  [vrtConfig.referenceUrl, vrtConfig.testUrl, process.env.BASE_URL]
    .filter(Boolean)
    .map((u) => new URL(u).hostname),
);

const GOTO_TIMEOUT = 45_000;
const NETWORK_IDLE_TIMEOUT = 10_000;

test.beforeEach(async ({ page }) => {
  await page.route(() => true, async (route) => {
    const request = route.request();
    let hostname;
    try {
      hostname = new URL(request.url()).hostname;
    } catch {
      return route.continue();
    }
    if (blockHosts.some((re) => re.test(hostname))) {
      return route.abort('blockedbyclient');
    }
    if (ownHosts.has(hostname)) {
      return route.continue({ headers: { ...request.headers(), ...scopedHeaders } });
    }
    return route.continue();
  });
});

// Create a test for each URL
for (const url of urls) {
  test(`VRT: ${url}`, async ({ page }) => {
    const pageUrl = new URL(url);
    const fullPath = pageUrl.pathname + pageUrl.search;

    // Wait for `load`, then give the network a bounded chance to settle; `networkidle` alone can hang on polling widgets.
    await page.goto(fullPath, { waitUntil: 'load', timeout: GOTO_TIMEOUT });
    await page.waitForLoadState('networkidle', { timeout: NETWORK_IDLE_TIMEOUT }).catch(() => undefined);

    // Wait for fonts to load
    await page.evaluate(() => document.fonts.ready);

    // Wait for animations to settle
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));

    // Additional stability wait for lazy-loaded content
    await page.waitForTimeout(500);

    // Take full page screenshot and compare
    await expect(page).toHaveScreenshot({
      fullPage: true,
      maxDiffPixels: threshold.maxDiffPixels,
      maxDiffPixelRatio: threshold.maxDiffPixelRatio,
      animations: 'disabled',
      stylePath: stylePath,
      timeout: 30000
    });
  });
}

/** "*.example.com" matches example.com and any subdomain; plain hosts match exactly. */
function hostPatternToRegExp(pattern) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  if (escaped.startsWith('\\*\\.')) {
    const base = escaped.slice(4);
    return new RegExp(`^(?:.+\\.)?${base}$`, 'i');
  }
  return new RegExp(`^${escaped.replace(/\*/g, '.*')}$`, 'i');
}
