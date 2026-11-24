import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  groupBySection,
  hreflangCodes,
  selectURLs,
  selectWithPinned,
  resolvePaths,
  PINNED_SECTION,
  ROOT_SECTION,
  SINGLE_PAGES_SECTION,
} from '../../src/select.js';
import { mergeConfig, validateConfig } from '../../src/config.js';
import { selectionLines } from '../../src/runner.js';

const host = 'https://www.example.com';
const u = (p: string) => `${host}${p}`;

/** One large section first in the sitemap, then several small ones. */
function bigFirstSitemap(): string[] {
  const urls = [u('/de')];
  urls.push(u('/de/products'));
  for (let i = 1; i <= 40; i++) urls.push(u(`/de/products/item-${i}`));
  for (const section of ['news', 'jobs', 'about', 'services', 'events']) {
    urls.push(u(`/de/${section}`));
    for (let i = 1; i <= 5; i++) urls.push(u(`/de/${section}/page-${i}`));
  }
  urls.push(u('/de/contact'), u('/de/imprint'), u('/de/privacy'));
  return urls;
}

test('groupBySection strips language prefixes and groups by first segment', () => {
  const entries = groupBySection([
    u('/'), u('/fr'), u('/de/news'), u('/de/news/a'), u('/fr/news/b'), u('/de/news/a/b'),
  ]);
  assert.deepEqual(entries.map(e => [e.section, e.depth]), [
    [ROOT_SECTION, 0], [ROOT_SECTION, 0], ['/news', 1], ['/news', 2], ['/news', 2], ['/news', 3],
  ]);
});

test('groupBySection: a two-letter segment is only a language when listed', () => {
  const entries = groupBySection([u('/ch/shop'), u('/ch/shop/x'), u('/es/a/b')], ['de', 'es']);
  assert.deepEqual(entries.map(e => e.section), ['/ch', '/ch', '/a']);
});

test('groupBySection: single top-level pages share one group', () => {
  const entries = groupBySection([u('/contact'), u('/imprint'), u('/news'), u('/news/a'), u('/faq/x')]);
  assert.deepEqual(entries.map(e => e.section), [
    SINGLE_PAGES_SECTION, SINGLE_PAGES_SECTION, '/news', '/news', '/faq',
  ]);
});

test('sectionRotation covers every section when one section comes first', () => {
  const selection = selectURLs(bigFirstSitemap(), 25);
  const bySection = new Map(selection.sections.map(s => [s.section, s]));
  assert.equal(selection.urls.length, 25);
  for (const section of ['/news', '/jobs', '/about', '/services', '/events', '/products', SINGLE_PAGES_SECTION]) {
    assert.ok(bySection.get(section)!.picked >= 1, `${section} not picked`);
  }
  assert.equal(bySection.get(ROOT_SECTION)!.picked, 1);
  assert.ok(bySection.get('/products')!.picked <= 4);
  assert.ok(selection.urls.includes(u('/de/news')), 'index page picked first');
});

test('ordered keeps the first maxUrls entries', () => {
  const urls = bigFirstSitemap();
  assert.deepEqual(selectURLs(urls, 25, 'ordered').urls, urls.slice(0, 25));
});

test('reverse keeps the last maxUrls entries in sitemap order', () => {
  const urls = bigFirstSitemap();
  assert.deepEqual(selectURLs(urls, 10, 'reverse').urls, urls.slice(-10));
});

test('selection is returned in sitemap order', () => {
  const urls = bigFirstSitemap();
  const picked = selectURLs(urls, 25).urls;
  const positions = picked.map(p => urls.indexOf(p));
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
});

test('a sitemap with at most maxUrls URLs keeps the same URL set', () => {
  const urls = bigFirstSitemap().slice(0, 20);
  for (const strategy of ['sectionRotation', 'ordered', 'reverse'] as const) {
    assert.deepEqual(selectURLs(urls, 25, strategy).urls, urls);
  }
});

test('selection is identical across runs', () => {
  assert.deepEqual(selectURLs(bigFirstSitemap(), 25), selectURLs(bigFirstSitemap(), 25));
});

test('adding one news item changes at most one selected URL', () => {
  const urls = bigFirstSitemap();
  const before = new Set(selectURLs(urls, 25).urls);
  const withNews = [...urls];
  withNews.splice(withNews.indexOf(u('/de/news/page-5')) + 1, 0, u('/de/news/page-6'));
  const after = new Set(selectURLs(withNews, 25).urls);
  const removed = [...before].filter(x => !after.has(x));
  assert.ok(removed.length <= 1, `removed: ${removed.join(', ')}`);
});

test('flat site without language prefix rotates through the single pages', () => {
  const urls = [u('/')];
  for (let i = 1; i <= 30; i++) urls.push(u(`/page-${i}`));
  const selection = selectURLs(urls, 10);
  assert.deepEqual(selection.urls, urls.slice(0, 10));
  assert.deepEqual(selection.sections, [
    { section: ROOT_SECTION, total: 1, picked: 1 },
    { section: SINGLE_PAGES_SECTION, total: 30, picked: 9 },
  ]);
});

test('multilingual roots come first', () => {
  const urls = [u('/de/a/1'), u('/de/a/2'), u('/de/a/3'), u('/de'), u('/fr'), u('/it')];
  assert.deepEqual(selectURLs(urls, 4).urls, [u('/de/a/1'), u('/de'), u('/fr'), u('/it')]);
});

test('hreflangCodes reads codes and primary subtags, ignoring x-default', () => {
  const xml = `<url><loc>${u('/de-ch/a')}</loc>
    <xhtml:link rel="alternate" hreflang="de-CH" href="${u('/de-ch/a')}"/>
    <xhtml:link rel="alternate" hreflang='es' href="${u('/es/a')}"/>
    <xhtml:link rel="alternate" hreflang="x-default" href="${u('/a')}"/></url>`;
  assert.deepEqual(hreflangCodes(xml).sort(), ['de', 'de-ch', 'es']);
});

test('config: sectionRotation is the default and unknown values are rejected', () => {
  const base = { referenceUrl: u('/'), testUrl: 'https://test.example.com' };
  assert.equal(mergeConfig(base).selection, 'sectionRotation');
  assert.doesNotThrow(() => validateConfig(mergeConfig({ ...base, selection: 'ordered' })));
  assert.throws(() => validateConfig(mergeConfig({ ...base, selection: 'random' as any })), /selection must be one of/);
});

test('summary lists the sections and picks', () => {
  const lines = selectionLines({
    strategy: 'sectionRotation',
    total: 50,
    filtered: 40,
    sections: [{ section: '/', total: 1, picked: 1 }, { section: '/news', total: 39, picked: 4 }],
  });
  assert.ok(lines.includes('sectionRotation: 5 of 40 URLs (50 in the source) from 2 sections.'));
  assert.ok(lines.includes('| `/news` | 4 | 39 |'));
});

test('pinned paths come first and count against maxUrls', () => {
  const pinned = resolvePaths(['/de/cart', '/de/checkout'], host);
  const selection = selectWithPinned(bigFirstSitemap(), pinned, 25);
  assert.equal(selection.urls.length, 25);
  assert.deepEqual(selection.urls.slice(0, 2), [u('/de/cart'), u('/de/checkout')]);
  assert.deepEqual(selection.sections[0], { section: PINNED_SECTION, total: 2, picked: 2 });
  assert.deepEqual(selection.urls.slice(2), selectURLs(bigFirstSitemap(), 23).urls);
});

test('a pinned path that is also in the sitemap counts once', () => {
  const urls = bigFirstSitemap();
  const selection = selectWithPinned(urls, resolvePaths(['/de/news/page-3/'], host), 25);
  assert.equal(selection.urls.length, 25);
  assert.equal(selection.urls.filter(x => x.includes('/de/news/page-3')).length, 1);
  assert.equal(selection.sections.find(s => s.section === '/news')!.total, 5);
});

test('pinned paths beyond maxUrls are all tested, without sitemap URLs', () => {
  const pinned = resolvePaths(['/a', '/b', '/c'], host);
  for (const strategy of ['sectionRotation', 'ordered', 'reverse'] as const) {
    assert.deepEqual(selectWithPinned(bigFirstSitemap(), pinned, 2, strategy).urls, pinned);
  }
});

test('config: paths must start with a slash', () => {
  const base = { referenceUrl: u('/'), testUrl: 'https://test.example.com' };
  assert.doesNotThrow(() => validateConfig(mergeConfig({ ...base, paths: ['/de/cart'] })));
  assert.throws(() => validateConfig(mergeConfig({ ...base, paths: ['de/cart'] })), /paths must be/);
  assert.equal('paths' in mergeConfig(base), false, 'no default, so the config hash is unchanged');
});
