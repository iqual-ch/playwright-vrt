#!/usr/bin/env node

import { request } from 'playwright';
import type { VRTConfig } from './config.js';

/** Result of one plain HTTP request against one host. */
export interface HostProbe {
  /** HTTP status of the final response, 0 on network error / timeout. */
  status: number;
  /** URL after following redirects. */
  finalUrl: string;
  /** Error message when the request failed. */
  error?: string;
  /** Wall time in ms. */
  ms: number;
}

export interface PlanEntry {
  /** URL as collected from the reference sitemap/crawler (test title). */
  url: string;
  /** Path + query that is navigated to on both hosts. */
  path: string;
  reference?: HostProbe;
  test?: HostProbe;
  /** Informational pre-flight findings; the URL is still tested. */
  notes?: string[];
}

export interface Plan {
  generatedAt: string;
  referenceUrl: string;
  testUrl: string;
  entries: PlanEntry[];
}

export interface ProbeOptions {
  headers?: Record<string, string>;
  timeout: number;
  concurrency: number;
  verbose?: boolean;
}

export function isLocalHost(url: string): boolean {
  const { hostname } = new URL(url);
  return hostname.endsWith('ddev.site') || hostname === 'localhost' || hostname.endsWith('.localhost');
}

export function pathOf(url: string): string {
  const u = new URL(url);
  return u.pathname + u.search;
}

/** One GET per path against a host, following redirects; records status and final URL. */
export async function probeHost(baseUrl: string, paths: string[], options: ProbeOptions): Promise<Map<string, HostProbe>> {
  const results = new Map<string, HostProbe>();
  if (paths.length === 0) {
    return results;
  }

  const ctx = await request.newContext({
    baseURL: baseUrl,
    ignoreHTTPSErrors: isLocalHost(baseUrl),
    extraHTTPHeaders: options.headers,
    timeout: options.timeout,
  });

  const queue = [...paths];
  const worker = async () => {
    while (queue.length > 0) {
      const path = queue.shift()!;
      const started = Date.now();
      try {
        const response = await ctx.get(path, { maxRedirects: 10, timeout: options.timeout });
        // Consume the body so the request completes on the server side.
        await response.body().catch(() => undefined);
        results.set(path, {
          status: response.status(),
          finalUrl: response.url(),
          ms: Date.now() - started,
        });
      } catch (error) {
        results.set(path, {
          status: 0,
          finalUrl: new URL(path, baseUrl).toString(),
          error: error instanceof Error ? firstLine(error.message) : String(error),
          ms: Date.now() - started,
        });
      }
      if (options.verbose) {
        const r = results.get(path)!;
        console.log(`   ${r.status || 'ERR'} ${path} (${r.ms} ms)${r.error ? ' ' + r.error : ''}`);
      }
    }
  };

  try {
    await Promise.all(Array.from({ length: Math.max(1, options.concurrency) }, worker));
  } finally {
    await ctx.dispose();
  }

  return results;
}

/**
 * Combine the probes of both hosts into the plan the Playwright spec reads.
 * Nothing is excluded: redirects are resolved and anomalies noted for the summary.
 */
export function buildPlan(
  urls: string[],
  config: VRTConfig,
  referenceProbes: Map<string, HostProbe> | undefined,
  testProbes: Map<string, HostProbe> | undefined,
  previous?: Plan,
): Plan {
  const referenceHost = new URL(config.referenceUrl).hostname;
  const testHost = new URL(config.testUrl).hostname;
  const previousByUrl = new Map((previous?.entries || []).map(e => [e.url, e]));

  const entries: PlanEntry[] = urls.map((url) => {
    const requestedPath = pathOf(url);
    const prev = previousByUrl.get(url);
    const reference = referenceProbes?.get(requestedPath) ?? prev?.reference;
    const test = testProbes?.get(requestedPath) ?? prev?.test;

    const entry: PlanEntry = {
      url,
      path: requestedPath,
      reference,
      test,
    };
    const notes: string[] = [];

    // Follow an on-host redirect of the reference (e.g. "/" -> "/de") so both sides compare the same path.
    if (reference) {
      if (reference.status === 0) {
        notes.push(`reference unreachable: ${reference.error || 'no response'}`);
      } else {
        const finalRef = new URL(reference.finalUrl);
        if (finalRef.hostname !== referenceHost) {
          notes.push(`reference redirects off-host to ${finalRef.origin}`);
        } else {
          if (reference.status >= 400) {
            notes.push(`reference HTTP ${reference.status}`);
          }
          const finalPath = finalRef.pathname + finalRef.search;
          if (finalPath !== requestedPath) {
            entry.path = finalPath;
          }
        }
      }
    }

    // Test side: report only.
    if (test) {
      if (test.status === 0) {
        notes.push(`test unreachable: ${test.error || 'no response'}`);
      } else {
        const finalTest = new URL(test.finalUrl);
        if (finalTest.hostname !== testHost) {
          notes.push(`test redirects off-host to ${finalTest.origin}`);
        } else if (test.status >= 400) {
          notes.push(`test HTTP ${test.status}`);
        } else if (reference && reference.status >= 200 && reference.status !== test.status) {
          notes.push(`status mismatch: reference ${reference.status}, test ${test.status}`);
        }
      }
    }

    if (notes.length > 0) {
      entry.notes = notes;
    }
    return entry;
  });

  return {
    generatedAt: new Date().toISOString(),
    referenceUrl: config.referenceUrl,
    testUrl: config.testUrl,
    entries,
  };
}

function firstLine(text: string): string {
  return text.split('\n')[0].trim();
}
