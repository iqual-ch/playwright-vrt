#!/usr/bin/env bun

import Sitemapper from 'sitemapper';
import micromatch from 'micromatch';
import { chromium } from 'playwright';
import type { VRTConfig } from './config.js';

export interface URLCollectionResult {
  urls: string[];
  source: 'sitemap' | 'crawl';
  total: number;
  filtered: number;
}

export async function collectURLs(config: VRTConfig): Promise<URLCollectionResult> {
  let urls: string[] = [];
  let source: 'sitemap' | 'crawl' = 'sitemap';

  // Try sitemap first
  try {
    urls = await collectFromSitemap(config.referenceUrl, config.sitemapPath || '/sitemap.xml');
  } catch (error) {
    console.warn('⚠️ Sitemap fetch failed, falling back to crawler');
    // Fallback to crawling
    urls = await crawlWebsite(config.referenceUrl, config.crawlOptions);
    source = 'crawl';
  }

  const totalUrls = urls.length;

  // Filter URLs
  urls = filterURLs(urls, config.referenceUrl, config.include || ['*'], config.exclude || []);

  // Remove duplicate URLs but keep order
  urls = Array.from(new Set(urls));

  // Limit to maxUrls
  const maxUrls = config.maxUrls || 25;
  const filteredCount = urls.length;
  urls = urls.slice(0, maxUrls);

  return {
    urls,
    source,
    total: totalUrls,
    filtered: filteredCount,
  };
}

async function collectFromSitemap(baseUrl: string, sitemapPath: string): Promise<string[]> {
  const sitemapUrl = new URL(sitemapPath, baseUrl).toString();

  const sitemap = new Sitemapper({
    url: sitemapUrl,
    timeout: 15000,
  });

  const { sites } = await sitemap.fetch();

  if (!sites || sites.length === 0) {
    throw new Error('No URLs found in sitemap');
  }

  return sites;
}

async function crawlWebsite(
  baseUrl: string,
  options?: VRTConfig['crawlOptions']
): Promise<string[]> {
  const urls = new Set<string>();

  console.log('   Using crawler (homepage links only)...');

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  const baseUrlObj = new URL(baseUrl);

  try {
    // Visit the homepage
    await page.goto(baseUrl, {
      waitUntil: 'networkidle',
      timeout: 30000
    });

    // Add the homepage itself, by adding the current page URL
    urls.add(page.url());

    // Extract all links from the page
    const links = await page.evaluate(() => {
      // @ts-ignore - runs in browser context
      const anchors = Array.from(document.querySelectorAll('a[href]'));
      // @ts-ignore - runs in browser context
      return anchors.map(a => (a as HTMLAnchorElement).href);
    });

    // Filter links to same domain and add to set
    for (const link of links) {
      try {
        const linkUrl = new URL(link);

        // Only include links from the same domain
        if (linkUrl.hostname === baseUrlObj.hostname) {
          // Normalize URL (remove hash)
          linkUrl.hash = '';
          const normalizedUrl = linkUrl.toString();

          if (options?.removeTrailingSlash) {
            // Remove trailing slash for consistency (except for root)
            const cleanUrl = normalizedUrl.endsWith('/') && normalizedUrl !== baseUrl + '/'
              ? normalizedUrl.slice(0, -1)
              : normalizedUrl;
            urls.add(cleanUrl);
          } else {
            urls.add(normalizedUrl);
          }
        }
      } catch {
        // Skip invalid URLs
      }
    }

    console.log(`   Found ${urls.size} URLs from homepage`);

  } catch (error) {
    console.error('   Crawler error:', error instanceof Error ? error.message : error);
    // At minimum, return the base URL
    urls.add(baseUrl);
  } finally {
    await browser.close();
  }

  return Array.from(urls);
}

function filterURLs(urls: string[], baseUrl: string, include: string[], exclude: string[]): string[] {
  return urls.filter((url) => {
    // Convert URL to path for pattern matching
    const urlObj = new URL(url);
    const path = urlObj.pathname + urlObj.search;

    // Filter URLs that don't match the reference URL domain
    const baseObj = new URL(baseUrl);
    if (urlObj.hostname !== baseObj.hostname) {
      return false;
    }

    // Also match against full URL for more flexibility
    const fullUrl = url;

    // Check if excluded
    if (exclude.length > 0) {
      if (micromatch.isMatch(path, exclude, {bash: true})) {
        return false;
      }
    }

    // Check if included
    if (include.length > 0) {
      return micromatch.isMatch(path, include, {bash: true});
    }

    return true;
  });
}

export function saveURLs(urls: string[], filepath: string): void {
  const content = JSON.stringify(urls, null, 2);
  Bun.write(filepath, content);
}
