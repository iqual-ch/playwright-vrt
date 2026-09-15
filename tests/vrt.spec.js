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

const settle = { scroll: true, waitForImages: true, ...(vrtConfig.settle || {}) };
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
const IMAGES_TIMEOUT = 10_000;
const SCROLL_STEP_DELAY = 150;
const MAX_SCROLL_STEPS = 80;

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
  test(`VRT: ${url}`, async ({ page }, testInfo) => {
    const pageUrl = new URL(url);
    const fullPath = pageUrl.pathname + pageUrl.search;

    // Wait for `load`, then give the network a bounded chance to settle; `networkidle` alone can hang on polling widgets.
    await page.goto(fullPath, { waitUntil: 'load', timeout: GOTO_TIMEOUT });
    await page.waitForLoadState('networkidle', { timeout: NETWORK_IDLE_TIMEOUT }).catch(() => undefined);

    const viewport = testInfo.project.use.viewport || { width: 1920, height: 1080 };
    await settlePage(page, viewport.height);

    // Clip the full-page capture to the viewport width so an overflowing element cannot widen the image.
    const pageHeight = await page.evaluate(() => document.documentElement.scrollHeight).catch(() => viewport.height);
    const clip = { x: 0, y: 0, width: viewport.width, height: Math.max(viewport.height, pageHeight) };

    const screenshotOptions = {
      fullPage: true,
      animations: 'disabled',
      stylePath,
      timeout: 30_000,
      maxDiffPixels: threshold.maxDiffPixels,
      maxDiffPixelRatio: threshold.maxDiffPixelRatio,
    };

    try {
      await expect(page).toHaveScreenshot({ ...screenshotOptions, clip });
    } catch (error) {
      // The page shrank after measuring; capture without the clip instead.
      if (!/clip/i.test(String(error && error.message))) throw error;
      await expect(page).toHaveScreenshot(screenshotOptions);
    }
  });
}

// Scroll through the page so lazy images and scroll-triggered reveals fire, then wait for images and fonts.
async function settlePage(page, viewportHeight) {
  if (settle.scroll) {
    const totalHeight = await page.evaluate(() => document.documentElement.scrollHeight).catch(() => 0);
    const step = Math.max(200, Math.floor(viewportHeight * 0.8));
    for (let y = step, i = 0; y < totalHeight && i < MAX_SCROLL_STEPS; y += step, i++) {
      await page.evaluate((top) => window.scrollTo({ top, left: 0, behavior: 'instant' }), y).catch(() => undefined);
      await page.waitForTimeout(SCROLL_STEP_DELAY);
    }
    await page.evaluate(() => window.scrollTo({ top: 0, left: 0, behavior: 'instant' })).catch(() => undefined);
  }

  if (settle.waitForImages) {
    await Promise.race([
      page.evaluate(waitForImages).catch(() => undefined),
      page.waitForTimeout(IMAGES_TIMEOUT),
    ]);
  }

  // Wait for fonts to load
  await page.evaluate(() => document.fonts.ready).catch(() => undefined);

  // Let the layout settle after the scroll
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.waitForTimeout(500);
}

/** Runs in the browser: resolve once every <img> has loaded or failed. */
function waitForImages() {
  const pending = Array.from(document.images).filter((img) => !img.complete);
  return Promise.all(pending.map((img) => new Promise((resolve) => {
    img.addEventListener('load', resolve, { once: true });
    img.addEventListener('error', resolve, { once: true });
  })));
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
