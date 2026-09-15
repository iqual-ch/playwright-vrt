import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPlan, pathOf, type HostProbe } from '../../src/preflight.js';
import { mergeConfig } from '../../src/config.js';
import type { Plan } from '../../src/preflight.js';

const config = mergeConfig({
  referenceUrl: 'https://ref.example',
  testUrl: 'https://test.example',
}) as any;

function probe(overrides: Partial<HostProbe>): HostProbe {
  return { status: 200, finalUrl: '', ms: 1, ...overrides };
}

test('on-host reference redirect updates the path and adds no note', () => {
  const url = 'https://ref.example/';
  const reference = new Map([[pathOf(url), probe({ finalUrl: 'https://ref.example/de' })]]);
  const test_ = new Map([[pathOf(url), probe({ finalUrl: 'https://test.example/' })]]);
  const plan = buildPlan([url], config, reference, test_);
  assert.equal(plan.entries[0].path, '/de');
  assert.equal(plan.entries[0].notes, undefined);
});

test('off-host reference redirect adds a note and leaves the path unchanged', () => {
  const url = 'https://ref.example/';
  const reference = new Map([[pathOf(url), probe({ finalUrl: 'https://other.example/de' })]]);
  const test_ = new Map([[pathOf(url), probe({ finalUrl: 'https://test.example/' })]]);
  const plan = buildPlan([url], config, reference, test_);
  assert.equal(plan.entries[0].path, '/');
  assert.ok(plan.entries[0].notes?.some(n => n.includes('redirects off-host')));
});

test('reference unreachable adds a note', () => {
  const url = 'https://ref.example/a';
  const reference = new Map([[pathOf(url), probe({ status: 0, error: 'timeout' })]]);
  const plan = buildPlan([url], config, reference, undefined);
  assert.ok(plan.entries[0].notes?.some(n => n.includes('reference unreachable')));
});

test('test HTTP 404 while reference is 200 adds a test HTTP note', () => {
  const url = 'https://ref.example/a';
  const reference = new Map([[pathOf(url), probe({ status: 200, finalUrl: 'https://ref.example/a' })]]);
  const test_ = new Map([[pathOf(url), probe({ status: 404, finalUrl: 'https://test.example/a' })]]);
  const plan = buildPlan([url], config, reference, test_);
  assert.ok(plan.entries[0].notes?.some(n => n.includes('test HTTP 404')));
});

test('reference 200 vs test redirected-to-200 on-host adds no mismatch note', () => {
  const url = 'https://ref.example/a';
  const reference = new Map([[pathOf(url), probe({ status: 200, finalUrl: 'https://ref.example/a' })]]);
  // HostProbe.status is the final status after following redirects, so a 301->200 chain shows 200 here.
  const test_ = new Map([[pathOf(url), probe({ status: 200, finalUrl: 'https://test.example/a' })]]);
  const plan = buildPlan([url], config, reference, test_);
  assert.equal(plan.entries[0].notes, undefined);
});

test('reference 200 and test 500 adds only the test HTTP note, not a mismatch note', () => {
  const url = 'https://ref.example/a';
  const reference = new Map([[pathOf(url), probe({ status: 200, finalUrl: 'https://ref.example/a' })]]);
  const test_ = new Map([[pathOf(url), probe({ status: 500, finalUrl: 'https://test.example/a' })]]);
  const plan = buildPlan([url], config, reference, test_);
  assert.deepEqual(plan.entries[0].notes, ['test HTTP 500']);
});

test('with no probes given, previous plan entries fill reference, test and baselineFailed', () => {
  const url = 'https://ref.example/a';
  const previous: Plan = {
    generatedAt: new Date().toISOString(),
    referenceUrl: config.referenceUrl,
    testUrl: config.testUrl,
    entries: [{
      url,
      path: '/a',
      reference: probe({ status: 200, finalUrl: 'https://ref.example/a' }),
      test: probe({ status: 200, finalUrl: 'https://test.example/a' }),
      baselineFailed: { desktop: 'boom' },
    }],
  };
  const plan = buildPlan([url], config, undefined, undefined, previous);
  assert.equal(plan.entries[0].reference?.status, 200);
  assert.equal(plan.entries[0].test?.status, 200);
  assert.deepEqual(plan.entries[0].baselineFailed, { desktop: 'boom' });
});

test('a Cloudflare challenge on the reference adds a note and marks the entry as blocked', () => {
  const url = 'https://ref.example/a';
  const reference = new Map([[pathOf(url), probe({ status: 403, finalUrl: 'https://ref.example/a', challenge: 'cloudflare' })]]);
  const test_ = new Map([[pathOf(url), probe({ status: 200, finalUrl: 'https://test.example/a' })]]);
  const plan = buildPlan([url], config, reference, test_);
  assert.equal(plan.entries[0].referenceBlocked, 'reference blocked by a Cloudflare challenge (HTTP 403)');
  assert.deepEqual(plan.entries[0].notes, ['reference blocked by a Cloudflare challenge (HTTP 403)']);
});

test('a Cloudflare challenge on the test host only adds a note', () => {
  const url = 'https://ref.example/a';
  const reference = new Map([[pathOf(url), probe({ status: 200, finalUrl: 'https://ref.example/a' })]]);
  const test_ = new Map([[pathOf(url), probe({ status: 403, finalUrl: 'https://test.example/a', challenge: 'cloudflare' })]]);
  const plan = buildPlan([url], config, reference, test_);
  assert.equal(plan.entries[0].referenceBlocked, undefined);
  assert.deepEqual(plan.entries[0].notes, ['test blocked by a Cloudflare challenge (HTTP 403)']);
});
