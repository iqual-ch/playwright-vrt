/**
 * Pick at most maxUrls URLs from the filtered sitemap list.
 *
 * - ordered: the first maxUrls entries in sitemap order.
 * - reverse: the last maxUrls entries (newest content on most sitemaps).
 * - sectionRotation: homepage and language roots first, then one URL per
 *   section per round (largest sections first), so a single large section
 *   can't take the whole budget.
 *
 * Every strategy is deterministic and returns the URLs in sitemap order.
 */

export const SELECTION_STRATEGIES = ['sectionRotation', 'ordered', 'reverse'] as const;
export type SelectionStrategy = typeof SELECTION_STRATEGIES[number];

/** Language prefixes stripped even when the sitemap has no hreflang links. */
export const DEFAULT_LANGUAGES = ['de', 'fr', 'it', 'en', 'rm'];

/** Section name of the homepage and language roots. */
export const ROOT_SECTION = '/';
/** Section name of the paths pinned in the config. */
export const PINNED_SECTION = '(pinned)';
/** Section name of the shared group of single top-level pages. */
export const SINGLE_PAGES_SECTION = '(single pages)';

export interface SectionStat {
  section: string;
  total: number;
  picked: number;
}

export interface Selection {
  strategy: SelectionStrategy;
  urls: string[];
  sections: SectionStat[];
}

interface Entry {
  url: string;
  index: number;
  section: string;
  depth: number;
}

export function selectURLs(
  urls: string[],
  maxUrls: number,
  strategy: SelectionStrategy = 'sectionRotation',
  languages: Iterable<string> = DEFAULT_LANGUAGES,
): Selection {
  const entries = groupBySection(urls, languages);
  let picked: Set<number>;

  if (maxUrls <= 0) {
    picked = new Set();
  } else if (urls.length <= maxUrls) {
    picked = new Set(entries.map(e => e.index));
  } else if (strategy === 'ordered') {
    picked = new Set(entries.slice(0, maxUrls).map(e => e.index));
  } else if (strategy === 'reverse') {
    picked = new Set(entries.slice(-maxUrls).map(e => e.index));
  } else {
    picked = rotate(entries, maxUrls);
  }

  return {
    strategy,
    urls: entries.filter(e => picked.has(e.index)).map(e => e.url),
    sections: sectionStats(entries, picked),
  };
}

/**
 * Pinned URLs are always tested and come first; they count against maxUrls,
 * and a pinned URL that is also in the sitemap list counts once.
 */
export function selectWithPinned(
  urls: string[],
  pinned: string[],
  maxUrls: number,
  strategy: SelectionStrategy = 'sectionRotation',
  languages: Iterable<string> = DEFAULT_LANGUAGES,
): Selection {
  const pins = Array.from(new Set(pinned));
  if (pins.length === 0) return selectURLs(urls, maxUrls, strategy, languages);

  const pinnedKeys = new Set(pins.map(urlKey));
  const rest = urls.filter(url => !pinnedKeys.has(urlKey(url)));
  const selection = selectURLs(rest, maxUrls - pins.length, strategy, languages);
  return {
    strategy,
    urls: [...pins, ...selection.urls],
    sections: [{ section: PINNED_SECTION, total: pins.length, picked: pins.length }, ...selection.sections],
  };
}

/** Absolute URLs of the configured paths on the reference host. */
export function resolvePaths(paths: string[], baseUrl: string): string[] {
  return paths.map(p => new URL(p, baseUrl).toString());
}

/** Comparison key: host, path without trailing slash, query. */
function urlKey(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname.replace(/\/+$/, '') || '/'}${u.search}`;
  } catch {
    return url;
  }
}

/**
 * Assign every URL to a section: the first path segment after an optional
 * language prefix. Sections with a single URL at depth 1 share one group.
 */
export function groupBySection(urls: string[], languages: Iterable<string> = DEFAULT_LANGUAGES): Entry[] {
  const langs = new Set(Array.from(languages, l => l.toLowerCase()));
  const entries: Entry[] = urls.map((url, index) => {
    let segments = segmentsOf(url);
    if (segments.length > 0 && langs.has(segments[0].toLowerCase())) {
      segments = segments.slice(1);
    }
    return {
      url,
      index,
      section: segments.length === 0 ? ROOT_SECTION : `/${segments[0]}`,
      depth: segments.length,
    };
  });

  const bySection = new Map<string, Entry[]>();
  for (const e of entries) {
    if (!bySection.has(e.section)) bySection.set(e.section, []);
    bySection.get(e.section)!.push(e);
  }
  for (const [section, members] of bySection) {
    if (section !== ROOT_SECTION && members.length === 1 && members[0].depth === 1) {
      members[0].section = SINGLE_PAGES_SECTION;
    }
  }

  return entries;
}

/**
 * Roots first, then round-robin over the sections, largest first. Inside a section: lowest depth first, then sitemap order, so
 * the first pick of each section is its index page.
 */
function rotate(entries: Entry[], maxUrls: number): Set<number> {
  const picked = new Set<number>();

  for (const e of entries) {
    if (picked.size >= maxUrls) return picked;
    if (e.section === ROOT_SECTION) picked.add(e.index);
  }

  const queues = new Map<string, Entry[]>();
  for (const e of entries) {
    if (e.section === ROOT_SECTION) continue;
    if (!queues.has(e.section)) queues.set(e.section, []);
    queues.get(e.section)!.push(e);
  }
  for (const queue of queues.values()) {
    queue.sort((a, b) => a.depth - b.depth || a.index - b.index);
  }

  // Largest sections first (ties: first appearance), so the sections that
  // matter most are covered when there are more sections than slots.
  const lists = Array.from(queues.values()).sort((a, b) => b.length - a.length);
  for (let round = 0; picked.size < maxUrls; round++) {
    let any = false;
    for (const queue of lists) {
      if (round >= queue.length) continue;
      any = true;
      picked.add(queue[round].index);
      if (picked.size >= maxUrls) break;
    }
    if (!any) break;
  }

  return picked;
}

function sectionStats(entries: Entry[], picked: Set<number>): SectionStat[] {
  const stats = new Map<string, SectionStat>();
  for (const e of entries) {
    if (!stats.has(e.section)) stats.set(e.section, { section: e.section, total: 0, picked: 0 });
    const s = stats.get(e.section)!;
    s.total++;
    if (picked.has(e.index)) s.picked++;
  }
  return Array.from(stats.values());
}

function segmentsOf(url: string): string[] {
  try {
    return new URL(url).pathname.split('/').filter(Boolean);
  } catch {
    return url.split(/[?#]/)[0].split('/').filter(Boolean);
  }
}

/**
 * hreflang values of a sitemap document, as lowercase codes plus their
 * primary subtag ("de-CH" → "de-ch", "de"). "x-default" is ignored.
 */
export function hreflangCodes(xml: string): string[] {
  const codes = new Set<string>();
  for (const match of xml.matchAll(/hreflang\s*=\s*["']([^"']+)["']/gi)) {
    const value = match[1].trim().toLowerCase();
    if (!value || value === 'x-default') continue;
    codes.add(value);
    codes.add(value.split(/[-_]/)[0]);
  }
  return Array.from(codes);
}

export function isSelectionStrategy(value: unknown): value is SelectionStrategy {
  return typeof value === 'string' && (SELECTION_STRATEGIES as readonly string[]).includes(value);
}
