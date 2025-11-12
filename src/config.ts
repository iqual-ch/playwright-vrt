#!/usr/bin/env bun

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
}

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
};

export async function loadConfig(configPath: string): Promise<VRTConfig> {
  try {
    const file = Bun.file(configPath);
    const config = await file.json();

    // Merge with defaults
    return {
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
    };
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
