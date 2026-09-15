#!/usr/bin/env node

import * as fs from 'fs';

export interface VRTConfig {
  referenceUrl: string;
  testUrl: string;
  sitemapPath?: string;
  maxUrls?: number;
  exclude?: string[];
  include?: string[];
  crawlOptions?: {
    maxDepth?: number;
    removeTrailingSlash?: boolean;
  };
  viewports?: Array<{
    name: string;
    width: number;
    height: number;
  }>;
  threshold?: {
    maxDiffPixels?: number;
    maxDiffPixelRatio?: number;
  };
  /** Sent to the reference and test hosts only, never to third parties. */
  extraHTTPHeaders?: Record<string, string>;
  /** Hosts to block ("host" or "*.domain"), merged with the defaults unless blockDefaultHosts is false. */
  blockHosts?: string[];
  blockDefaultHosts?: boolean;
  settle?: {
    /** Scroll through the page once before the capture. */
    scroll?: boolean;
    /** Wait (bounded) until every <img> has loaded or failed. */
    waitForImages?: boolean;
  };
}

export interface CLIOptions {
  reference?: string;
  test?: string;
  config: string;
  output?: string;
  maxUrls?: number;
  project?: string;
  verbose?: boolean;
  identifier?: string;
  updateBaseline?: boolean;
  headed?: boolean;
  skipInstall?: boolean;
}

/** Third-party hosts that keep the network busy or render differently on every load. */
export const DEFAULT_BLOCK_HOSTS: string[] = [
  // Bot challenges
  'challenges.cloudflare.com',
  // Analytics / tag managers / session recording
  '*.google-analytics.com',
  '*.analytics.google.com',
  '*.googletagmanager.com',
  '*.doubleclick.net',
  '*.googlesyndication.com',
  '*.googleadservices.com',
  '*.hotjar.com',
  '*.hotjar.io',
  '*.clarity.ms',
  '*.mouseflow.com',
  '*.dynamicyield.com',
  '*.dynamicyield.eu',
  'connect.facebook.net',
  '*.facebook.com',
  '*.linkedin.com',
  'snap.licdn.com',
  // Consent management
  '*.cookiebot.com',
  '*.usercentrics.eu',
  '*.cookieyes.com',
  '*.onetrust.com',
  '*.cookielaw.org',
  // Chat widgets
  '*.superchat.com',
  '*.superchat.de',
  '*.superchat.at',
  '*.userlike.com',
  '*.intercom.io',
  '*.crisp.chat',
];

export const DEFAULT_CONFIG: Partial<VRTConfig> = {
  sitemapPath: '/sitemap.xml',
  maxUrls: 25,
  exclude: [],
  include: ['*'],
  crawlOptions: {
    maxDepth: 1,
    removeTrailingSlash: true,
  },
  viewports: [
    { name: 'desktop', width: 1920, height: 1080 },
  ],
  threshold: {
    maxDiffPixels: 100,
    maxDiffPixelRatio: 0.01,
  },
  extraHTTPHeaders: {
    'X-Automated-By': 'iqual/playwright-vrt',
  },
  blockHosts: [],
  blockDefaultHosts: true,
  settle: {
    scroll: true,
    waitForImages: true,
  },
};

/**
 * Merge defaults with the user's config. Lists are resolved here so the test
 * runner receives the final values and the config hash covers them.
 */
export function mergeConfig(config: Partial<VRTConfig>): VRTConfig {
  const merged = {
    ...DEFAULT_CONFIG,
    ...config,
    crawlOptions: {
      ...DEFAULT_CONFIG.crawlOptions,
      ...config.crawlOptions,
    },
    viewports: config.viewports || DEFAULT_CONFIG.viewports,
    threshold: {
      ...DEFAULT_CONFIG.threshold,
      ...config.threshold,
    },
    extraHTTPHeaders: {
      ...DEFAULT_CONFIG.extraHTTPHeaders,
      ...config.extraHTTPHeaders,
    },
    settle: {
      ...DEFAULT_CONFIG.settle,
      ...config.settle,
    },
  } as VRTConfig;

  merged.blockHosts = uniq([
    ...(merged.blockDefaultHosts !== false ? DEFAULT_BLOCK_HOSTS : []),
    ...(config.blockHosts || []),
  ]);

  return merged;
}

function uniq(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

export async function loadConfig(configPath: string): Promise<VRTConfig> {
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const config = JSON.parse(raw);
    return mergeConfig(config);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      throw new Error(`Config file not found: ${configPath}`);
    }
    throw error;
  }
}

export function validateConfig(config: VRTConfig): void {
  // Validate required URLs
  if (!config.testUrl) {
    throw new Error('testUrl is required');
  }
  if (!config.referenceUrl) {
    throw new Error('referenceUrl is required');
  }

  // Validate URL format
  try {
    new URL(config.referenceUrl);
    new URL(config.testUrl);
  } catch {
    throw new Error('Invalid URL format in referenceUrl or testUrl');
  }

  // Validate viewports
  if (!config.viewports || config.viewports.length === 0) {
    throw new Error('At least one viewport must be defined');
  }

  for (const vp of config.viewports) {
    if (!vp.name || vp.width <= 0 || vp.height <= 0) {
      throw new Error(`Invalid viewport configuration: ${JSON.stringify(vp)}`);
    }
  }

  // Validate threshold
  if (config.threshold) {
    if (config.threshold.maxDiffPixelRatio &&
        (config.threshold.maxDiffPixelRatio < 0 || config.threshold.maxDiffPixelRatio > 1)) {
      throw new Error('maxDiffPixelRatio must be between 0 and 1');
    }
  }
}
