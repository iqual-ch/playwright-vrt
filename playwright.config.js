// This config is shipped with playwright-vrt package
// User's config is loaded via environment variables

import { join } from 'path';

const vrtConfig = process.env.VRT_CONFIG
  ? JSON.parse(process.env.VRT_CONFIG)
  : { viewports: [{ name: 'desktop', width: 1920, height: 1080 }] };

// Use absolute paths based on user's working directory
const workingDir = process.cwd();

const ignoreHTTPSErrors = process.env.BASE_URL.endsWith("ddev.site") || process.env.BASE_URL.endsWith("localhost");

// 'baseline' writes every snapshot; 'test' never writes one, so a missing baseline fails.
const phase = process.env.VRT_PHASE || 'test';

export default {
  testDir: './tests',
  testMatch: '**/*.spec.js', // JavaScript test files
  fullyParallel: true,
  retries: process.env.CI ? 2 : 1,
  workers: vrtConfig.workers || 2,
  // goto (45 s) + settle + toHaveScreenshot (30 s) must fit
  timeout: 120000,

  updateSnapshots: phase === 'baseline' ? 'all' : 'none',

  // Store snapshots in playwright-snapshots/ for easy caching
  snapshotDir: join(workingDir, 'playwright-snapshots'),

  // Store temporary test artifacts in playwright-tmp/
  outputDir: join(workingDir, 'playwright-tmp'),

  reporter: [
    ['html', {
      outputFolder: process.env.OUTPUT_DIR || join(workingDir, 'playwright-report'),
      open: 'never',
      noSnippets: true,
    }],
    ['json', {
      outputFile: process.env.OUTPUT_DIR
        ? `${process.env.OUTPUT_DIR}/results.json`
        : join(workingDir, 'playwright-report', 'results.json')
    }],
    ['list'],
  ],

  use: {
    baseURL: process.env.BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'on',
    ignoreHTTPSErrors: ignoreHTTPSErrors,
    // Headers are scoped to the hosts under test in tests/vrt.spec.js, not set here.
    locale: vrtConfig.locale || 'de-CH',
    timezoneId: vrtConfig.timezoneId || 'Europe/Zurich',
    launchOptions: {
      slowMo: 100,
    },
    contextOptions: {
      reducedMotion: 'reduce',
    },
  },

  // Create a project for each viewport
  projects: vrtConfig.viewports.map((vp) => ({
    name: vp.name,
    use: {
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: 1,
    },
  })),
};
