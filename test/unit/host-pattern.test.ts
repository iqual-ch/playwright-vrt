import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hostPatternToRegExp, hostPatternToResolverRules } from '../../tests/host-pattern.js';

test('a wildcard pattern matches the bare domain and any subdomain', () => {
  const re = hostPatternToRegExp('*.example.com');
  assert.ok(re.test('example.com'));
  assert.ok(re.test('a.example.com'));
  assert.ok(re.test('a.b.example.com'));
  assert.ok(!re.test('notexample.com'));
});

test('a plain host pattern matches only exactly, case-insensitively', () => {
  const re = hostPatternToRegExp('challenges.cloudflare.com');
  assert.ok(re.test('challenges.cloudflare.com'));
  assert.ok(re.test('CHALLENGES.CLOUDFLARE.COM'));
  assert.ok(!re.test('sub.challenges.cloudflare.com'));
  assert.ok(!re.test('challengesXcloudflare.com'));
});

test('dots in the pattern are escaped, not treated as wildcards', () => {
  const re = hostPatternToRegExp('a.b.example.com');
  assert.ok(re.test('a.b.example.com'));
  assert.ok(!re.test('aXb.example.com'));
});

test('a wildcard pattern becomes resolver rules for the subdomains and the bare domain', () => {
  assert.deepEqual(hostPatternToResolverRules('*.example.com'), ['MAP *.example.com ~NOTFOUND', 'MAP example.com ~NOTFOUND']);
});

test('a plain host pattern becomes a single resolver rule', () => {
  assert.deepEqual(hostPatternToResolverRules('challenges.cloudflare.com'), ['MAP challenges.cloudflare.com ~NOTFOUND']);
});
