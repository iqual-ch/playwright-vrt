import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { parsePlaywrightResults } from '../../src/runner.js';

function writeResults(outputDir: string, report: any): void {
  fs.writeFileSync(path.join(outputDir, 'results.json'), JSON.stringify(report), 'utf-8');
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vrt-runner-test-'));
}

test('parsePlaywrightResults maps each Playwright status', () => {
  const outputDir = tmpDir();
  writeResults(outputDir, {
    suites: [{
      specs: [
        {
          title: 'VRT: https://x/a',
          tests: [{ projectName: 'desktop', status: 'expected', results: [{ status: 'passed' }] }],
        },
        {
          title: 'VRT: https://x/b',
          tests: [{ projectName: 'desktop', status: 'flaky', results: [{ status: 'failed' }, { status: 'passed' }] }],
        },
        {
          title: 'VRT: https://x/c',
          tests: [{ projectName: 'desktop', status: 'skipped', results: [] }],
        },
      ],
    }],
  });

  const outcomes = parsePlaywrightResults(outputDir);
  assert.equal(outcomes.find(o => o.url === 'https://x/a')?.status, 'passed');
  assert.equal(outcomes.find(o => o.url === 'https://x/b')?.status, 'flaky');
  assert.equal(outcomes.find(o => o.url === 'https://x/c')?.status, 'skipped');
});

test('parsePlaywrightResults: unexpected maps to failed with a stripped, first-line message from the last result', () => {
  const outputDir = tmpDir();
  const ESC = '';
  writeResults(outputDir, {
    suites: [{
      specs: [{
        title: 'VRT: https://x/d',
        tests: [{
          projectName: 'desktop',
          status: 'unexpected',
          results: [
            { status: 'failed', error: { message: 'ignored first attempt' } },
            { status: 'failed', error: { message: `${ESC}[31mExpect failed${ESC}[39m\nsecond line` } },
          ],
        }],
      }],
    }],
  });

  const outcomes = parsePlaywrightResults(outputDir);
  const outcome = outcomes.find(o => o.url === 'https://x/d');
  assert.equal(outcome?.status, 'failed');
  assert.equal(outcome?.message, 'Expect failed');
});

test('parsePlaywrightResults visits nested suites and strips the "VRT: " prefix', () => {
  const outputDir = tmpDir();
  writeResults(outputDir, {
    suites: [{
      specs: [],
      suites: [{
        specs: [{
          title: 'VRT: https://x/nested',
          tests: [{ projectName: 'desktop', status: 'expected', results: [{ status: 'passed' }] }],
        }],
      }],
    }],
  });

  const outcomes = parsePlaywrightResults(outputDir);
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].url, 'https://x/nested');
});

test('parsePlaywrightResults returns an empty array when results.json is missing', () => {
  const outputDir = tmpDir();
  const outcomes = parsePlaywrightResults(outputDir);
  assert.deepEqual(outcomes, []);
});

test('parsePlaywrightResults reports the differing pixel count or the size mismatch of a screenshot failure', () => {
  const outputDir = tmpDir();
  const screenshotError = [
    'Error: expect(page).toHaveScreenshot(expected) failed',
    '',
    '  4200 pixels (ratio 0.01 of all image pixels) are different.',
    '',
    'Call log:',
    '  - Expect "toHaveScreenshot" with timeout 30000ms',
  ].join('\n');
  const sizeError = [
    'Error: expect(page).toHaveScreenshot(expected) failed',
    '',
    '  Expected an image 1920px by 5000px, received 1920px by 5100px. 12 pixels (ratio 0.01 of all image pixels) are different.',
  ].join('\n');
  writeResults(outputDir, {
    suites: [{
      specs: [
        {
          title: 'VRT: https://x/pixels',
          tests: [{ projectName: 'desktop', status: 'unexpected', results: [{ status: 'failed', error: { message: screenshotError } }] }],
        },
        {
          title: 'VRT: https://x/size',
          tests: [{ projectName: 'desktop', status: 'unexpected', results: [{ status: 'failed', error: { message: sizeError } }] }],
        },
      ],
    }],
  });

  const outcomes = parsePlaywrightResults(outputDir);
  assert.equal(outcomes.find(o => o.url === 'https://x/pixels')?.message, '4200 pixels differ (ratio 0.01)');
  assert.equal(outcomes.find(o => o.url === 'https://x/size')?.message, 'Expected an image 1920px by 5000px, received 1920px by 5100px. 12 pixels differ (ratio 0.01)');
});
