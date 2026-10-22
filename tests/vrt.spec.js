import { test, expect } from '@playwright/test';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { hostPatternToRegExp, hostPatternToUrlPatterns } from './host-pattern.js';

// ESM equivalent of __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Run state lives in playwright-snapshots/ next to the baseline
const snapshotDir = join(process.cwd(), 'playwright-snapshots');
const planPath = join(snapshotDir, 'plan.json');
const urlsPath = join(snapshotDir, 'urls.json');

// CSS file is in the same directory as this test file
const stylePath = join(__dirname, 'vrt.css');

// Config passed in by the CLI, already merged with defaults
const vrtConfig = process.env.VRT_CONFIG
  ? JSON.parse(process.env.VRT_CONFIG)
  : {};

// 'baseline' (reference host) or 'test' (test host)
const phase = process.env.VRT_PHASE || 'test';


// The plan is written by the CLI: one entry per URL with the path to navigate to.
function loadPlan() {
  if (existsSync(planPath)) {
    return JSON.parse(readFileSync(planPath, 'utf-8')).entries;
  }
  if (!existsSync(urlsPath)) {
    throw new Error(`URLs file not found at ${urlsPath}. Did you run URL collection?`);
  }
  return JSON.parse(readFileSync(urlsPath, 'utf-8')).map((url) => {
    const u = new URL(url);
    return { url, path: u.pathname + u.search };
  });
}

const entries = loadPlan();

const threshold = vrtConfig.threshold || { maxDiffPixels: 500 };
const settle = { scroll: true, waitForImages: true, ...(vrtConfig.settle || {}) };
const maskSelectors = vrtConfig.mask || [];
const hideSelectors = vrtConfig.hide || [];
const blockHostPatterns = vrtConfig.blockHosts || [];
const blockHosts = blockHostPatterns.map(hostPatternToRegExp);

// Headers go to the hosts under test only; on third-party hosts they would fail the CORS preflight.
const scopedHeaders = Object.entries(vrtConfig.extraHTTPHeaders || {});
const scopedHeaderNames = new Set(scopedHeaders.map(([name]) => name.toLowerCase()));
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
const WARMUP_CAPTURE_TIMEOUT = 10_000;

// Add the headers and abort blocked hosts via CDP; page.route() would disable the HTTP cache.
test.beforeEach(async ({ page }) => {
  const patterns = [...ownHosts, ...blockHostPatterns].flatMap(hostPatternToUrlPatterns);
  if (patterns.length === 0) return;
  const cdp = await page.context().newCDPSession(page);
  cdp.on('Fetch.requestPaused', ({ requestId, request }) => {
    // A request that cannot be continued fails instead of staying paused.
    const fail = (errorReason) => cdp.send('Fetch.failRequest', { requestId, errorReason }).catch(() => undefined);
    let hostname;
    try {
      hostname = new URL(request.url).hostname;
    } catch {
      hostname = undefined;
    }
    if (hostname !== undefined && blockHosts.some((re) => re.test(hostname))) {
      return fail('BlockedByClient');
    }
    if (!ownHosts.has(hostname) || scopedHeaders.length === 0) {
      return cdp.send('Fetch.continueRequest', { requestId }).catch(() => fail('Failed'));
    }
    const headers = Object.entries(request.headers)
      .filter(([name]) => !scopedHeaderNames.has(name.toLowerCase()))
      .concat(scopedHeaders)
      .map(([name, value]) => ({ name, value: String(value) }));
    return cdp.send('Fetch.continueRequest', { requestId, headers }).catch(() => fail('Failed'));
  });
  await cdp.send('Fetch.enable', { patterns: patterns.map((urlPattern) => ({ urlPattern, requestStage: 'Request' })) });
});

// Create a test for each URL
for (const entry of entries) {
  test(`VRT: ${entry.url}`, async ({ page }, testInfo) => {
    // A reference behind a bot challenge gets no baseline; the reason ends up in the summary.
    if (phase === 'baseline' && entry.referenceBlocked) {
      throw new Error(entry.referenceBlocked);
    }

    // Wait for `load`, then give the network a bounded chance to settle; `networkidle` alone can hang on polling widgets.
    await page.goto(entry.path, { waitUntil: 'load', timeout: GOTO_TIMEOUT });
    await page.waitForLoadState('networkidle', { timeout: NETWORK_IDLE_TIMEOUT }).catch(() => undefined);

    if (hideSelectors.length > 0) {
      await page.addStyleTag({ content: `${hideSelectors.join(', ')} { display: none !important; }` });
    }

    const viewport = testInfo.project.use.viewport || { width: 1920, height: 1080 };
    await settlePage(page, viewport.height);
    await prepareCapture(page);

    // Clip the full-page capture to the viewport width so an overflowing element cannot widen the image.
    const pageHeight = await page.evaluate(() => document.documentElement.scrollHeight).catch(() => viewport.height);
    const clip = { x: 0, y: 0, width: viewport.width, height: Math.max(viewport.height, pageHeight) };

    const screenshotOptions = {
      fullPage: true,
      animations: 'disabled',
      stylePath,
      timeout: 30_000,
      mask: maskSelectors.map((selector) => page.locator(selector)),
      maskColor: '#FF00FF',
    };
    if (threshold.maxDiffPixels !== undefined) screenshotOptions.maxDiffPixels = threshold.maxDiffPixels;
    if (threshold.maxDiffPixelRatio !== undefined) screenshotOptions.maxDiffPixelRatio = threshold.maxDiffPixelRatio;
    if (threshold.threshold !== undefined) screenshotOptions.threshold = threshold.threshold;

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

  await waitForMedia(page);
}

// Wait for images (when enabled) and fonts, then let the layout settle.
async function waitForMedia(page) {
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

// A full-page capture resizes the viewport (resize handlers, lazy images); a throwaway one settles that first.
async function prepareCapture(page) {
  await page.screenshot({ fullPage: true, animations: 'disabled', stylePath, timeout: WARMUP_CAPTURE_TIMEOUT }).catch(() => undefined);
  await waitForMedia(page);
}

/** Runs in the browser: resolve once every <img> has loaded or failed. */
function waitForImages() {
  const pending = Array.from(document.images).filter((img) => !img.complete);
  return Promise.all(pending.map((img) => new Promise((resolve) => {
    img.addEventListener('load', resolve, { once: true });
    img.addEventListener('error', resolve, { once: true });
  })));
}
