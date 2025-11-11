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

// Create a test for each URL
for (const url of urls) {
  test(`VRT: ${url}`, async ({ page }) => {
    // Navigate to the URL
    const pageUrl = new URL(url);
    const fullPath = pageUrl.pathname + pageUrl.search;
    await page.goto(fullPath, {
      waitUntil: 'networkidle',
      timeout: 30000
    });

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
      timeout: 10000
    });
  });
}
