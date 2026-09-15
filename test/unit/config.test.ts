import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeConfig,
  validateConfig,
  DEFAULT_BLOCK_HOSTS,
  DEFAULT_MASK,
  DEFAULT_HIDE,
  type VRTConfig,
} from '../../src/config.js';

test('mergeConfig applies defaults', () => {
  const merged = mergeConfig({});
  assert.deepEqual(merged.threshold, { maxDiffPixels: 500 });
  assert.deepEqual(merged.extraHTTPHeaders, { 'X-Automated-By': 'iqual/playwright-vrt' });
  assert.deepEqual(merged.blockHosts, DEFAULT_BLOCK_HOSTS);
  assert.deepEqual(merged.mask, DEFAULT_MASK);
  assert.deepEqual(merged.hide, DEFAULT_HIDE);
});

test('mergeConfig: a user pixel-ratio budget replaces the default pixel budget', () => {
  const merged = mergeConfig({ threshold: { maxDiffPixelRatio: 0.02 } });
  assert.deepEqual(merged.threshold, { maxDiffPixelRatio: 0.02 });
  assert.equal(merged.threshold.maxDiffPixels, undefined);
});

test('mergeConfig: a user per-pixel tolerance keeps the default pixel budget', () => {
  const merged = mergeConfig({ threshold: { threshold: 0.3 } });
  assert.deepEqual(merged.threshold, { maxDiffPixels: 500, threshold: 0.3 });
});

test('mergeConfig: extraHTTPHeaders are merged with the default header', () => {
  const merged = mergeConfig({ extraHTTPHeaders: { Authorization: 'x' } });
  assert.deepEqual(merged.extraHTTPHeaders, {
    'X-Automated-By': 'iqual/playwright-vrt',
    Authorization: 'x',
  });
});

test('mergeConfig: blockDefaultHosts false uses only the user list', () => {
  const merged = mergeConfig({ blockDefaultHosts: false, blockHosts: ['a.example'] });
  assert.deepEqual(merged.blockHosts, ['a.example']);
});

test('mergeConfig: blockHosts duplicates between defaults and user list are removed', () => {
  const merged = mergeConfig({ blockHosts: [DEFAULT_BLOCK_HOSTS[0]] });
  const occurrences = merged.blockHosts.filter(h => h === DEFAULT_BLOCK_HOSTS[0]);
  assert.equal(occurrences.length, 1);
});

test('mergeConfig: maskDefaults false uses only the user list', () => {
  const merged = mergeConfig({ maskDefaults: false, mask: ['.custom'] });
  assert.deepEqual(merged.mask, ['.custom']);
});

test('mergeConfig: mask duplicates between defaults and user list are removed', () => {
  const merged = mergeConfig({ mask: [DEFAULT_MASK[0]] });
  const occurrences = merged.mask.filter(m => m === DEFAULT_MASK[0]);
  assert.equal(occurrences.length, 1);
});

test('mergeConfig: hideDefaults false uses only the user list', () => {
  const merged = mergeConfig({ hideDefaults: false, hide: ['.custom-hide'] });
  assert.deepEqual(merged.hide, ['.custom-hide']);
});

test('mergeConfig: hide duplicates between defaults and user list are removed', () => {
  const merged = mergeConfig({ hide: [DEFAULT_HIDE[0]] });
  const occurrences = merged.hide.filter(h => h === DEFAULT_HIDE[0]);
  assert.equal(occurrences.length, 1);
});

test('validateConfig throws for workers: 0', () => {
  const config = mergeConfig({ testUrl: 'https://a.example', referenceUrl: 'https://b.example', workers: 0 });
  assert.throws(() => validateConfig(config));
});

test('validateConfig throws for an out-of-range maxDiffPixelRatio', () => {
  const config = mergeConfig({
    testUrl: 'https://a.example',
    referenceUrl: 'https://b.example',
    threshold: { maxDiffPixelRatio: 2 },
  });
  assert.throws(() => validateConfig(config));
});

test('validateConfig throws for a missing testUrl', () => {
  const config = mergeConfig({ referenceUrl: 'https://b.example' }) as VRTConfig;
  assert.throws(() => validateConfig(config));
});
