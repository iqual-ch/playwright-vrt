#!/usr/bin/env bun

import * as path from 'path';
import * as fs from 'fs';
import { loadConfig, validateConfig, type CLIOptions } from './config.js';
import { collectURLs } from './collect.js';
import { runVisualTests, printResults, hasExistingSnapshots } from './runner.js';
import { createHash } from 'crypto';

/**
 * Compute SHA-256 hash of a file
 */
function computeFileHash(filePath: string): string {
  const content = fs.readFileSync(filePath, 'utf-8');
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Compute SHA-256 hash of a config object
 */
function computeConfigHash(config: any): string {
  // Create a stable JSON representation (sorted keys)
  const configStr = JSON.stringify(config, Object.keys(config).sort());
  return createHash('sha256').update(configStr).digest('hex');
}

/**
 * Check if cache is valid by comparing stored hashes
 */
function isCacheValid(snapshotDir: string, config: any): boolean {
  const hashFile = path.join(snapshotDir, '.cache-hash.json');

  if (!fs.existsSync(hashFile)) {
    return false;
  }

  try {
    const stored = JSON.parse(fs.readFileSync(hashFile, 'utf-8'));
    const packageDir = path.join(__dirname, '..');
    const testFilePath = path.join(packageDir, 'tests', 'vrt.spec.ts');

    const currentHashes = {
      config: computeConfigHash(config),
      testFile: fs.existsSync(testFilePath) ? computeFileHash(testFilePath) : '',
    };

    // Log cache timestamp
    console.log(`   Cache timestamp: ${stored.timestamp}`);

    return stored.config === currentHashes.config &&
           stored.testFile === currentHashes.testFile;
  } catch {
    return false;
  }
}

/**
 * Save current config and test file hashes to cache
 */
function saveCacheHashes(snapshotDir: string, config: any): void {
  const packageDir = path.join(__dirname, '..');
  const testFilePath = path.join(packageDir, 'tests', 'vrt.spec.ts');

  const hashes = {
    config: computeConfigHash(config),
    testFile: fs.existsSync(testFilePath) ? computeFileHash(testFilePath) : '',
    timestamp: new Date().toISOString(),
  };

  const hashFile = path.join(snapshotDir, '.cache-hash.json');
  fs.writeFileSync(hashFile, JSON.stringify(hashes, null, 2), 'utf-8');
}

async function main() {
  const args = parseArgs();

  // Either --config or --test is required
  if (!args.config && !args.test) {
    console.error('Error: Either --config or --test is required');
    printUsage();
    process.exit(2);
  }

  try {
    // Load and validate configuration
    let config;
    let configPath: string | undefined;

    if (args.config) {
      // Load from config file
      configPath = path.resolve(args.config);
      config = await loadConfig(configPath);
    } else {
      // Use defaults
      const { DEFAULT_CONFIG } = await import('./config');
      config = { ...DEFAULT_CONFIG } as any;
    }

    // Override with CLI args
    if (args.test) config.testUrl = args.test;
    if (args.reference) config.referenceUrl = args.reference;

    let hasExplicitReference = true;

    // If no reference URL set, default to test URL
    if (!config.referenceUrl && config.testUrl) {
      config.referenceUrl = config.testUrl;
      hasExplicitReference = false;
    }

    if (args.maxUrls) config.maxUrls = args.maxUrls;

    validateConfig(config);

    console.log('🚀 Starting Visual Regression Testing');
    console.log(`   Reference: ${config.referenceUrl}`);
    console.log(`   Test: ${config.testUrl}`);

    // Create snapshot directory for URLs and snapshots
    const snapshotDir = path.resolve('playwright-snapshots');
    const outputDir = path.resolve(args.output || 'playwright-report');

    if (!fs.existsSync(snapshotDir)) {
      fs.mkdirSync(snapshotDir, { recursive: true });
    }

    if (args.verbose) {
      console.log(`📁 Snapshots: ${snapshotDir}`);
      console.log(`📁 Output: ${outputDir}`);
    }

    // Check if URLs already exist (unless --update-baseline)
    const urlsPath = path.join(snapshotDir, 'urls.json');
    let urls: string[] = [];

    // Check cache validity based on config object and test file hashes
    const cacheValid = isCacheValid(snapshotDir, config);
    const shouldRegenerate = args.updateBaseline || !cacheValid;

    if (!hasExplicitReference && !cacheValid && !args.updateBaseline) {
      console.error('\n❌ Error: No baseline snapshots found and no reference URL provided.');
      console.error('   Either:');
      console.error('   1. Provide --reference <url> to create baseline from a reference system');
      console.error('   2. Use --update-baseline to create baseline from test URL');
      console.error('   3. Add referenceUrl to your config file\n');
      process.exit(2);
    }

    if (fs.existsSync(urlsPath) && !shouldRegenerate) {
      // Load existing URLs
      console.log('\n📋 Using cached URLs from previous run');
      urls = JSON.parse(fs.readFileSync(urlsPath, 'utf-8'));
      console.log(`✓ Loaded ${urls.length} URLs from cache`);

      if (args.verbose) {
        console.log('   (Use --update-baseline to regenerate URLs)');
      }
    } else {
      // Collect URLs from sitemap/crawler
      if (args.updateBaseline) {
        console.log('\n🔄 Updating baseline (regenerating URLs)...');
      } else if (!cacheValid && fs.existsSync(urlsPath)) {
        console.log('\n🔄 Config or test file changed, regenerating URLs...');
      } else {
        console.log('\n🔍 Collecting URLs (first run)...');
      }

      console.log(`   Source: ${config.referenceUrl}${config.sitemapPath || '/sitemap.xml'}`);
      const urlResult = await collectURLs(config);

      console.log(`✓ Found ${urlResult.total} URLs, filtered to ${urlResult.filtered}, using top ${urlResult.urls.length}`);
      console.log(`  Source: ${urlResult.source}`);

      urls = urlResult.urls;

      // Save URLs to snapshot directory (co-located with snapshots for easy caching)
      fs.writeFileSync(urlsPath, JSON.stringify(urls, null, 2), 'utf-8');

      // Save cache hashes based on final config object
      saveCacheHashes(snapshotDir, config);
    }

    if (urls.length === 0) {
      throw new Error('No URLs found to test');
    }

    if (args.verbose) {
      console.log('\n📝 URLs to test:');
      urls.forEach((url, i) => console.log(`  ${i + 1}. ${url}`));
    }

    // Run visual regression tests using shipped Playwright config and tests
    const results = await runVisualTests({
      config,
      outputDir,
      verbose: args.verbose,
      project: args.project,
      updateBaseline: shouldRegenerate,
      hasExplicitReference,
      headed: args.headed,
    });

    // Print results
    printResults(results, config);

    // Report location
    const reportPath = path.join(outputDir, 'index.html');
    console.log(`\n📊 Report: ${reportPath}`);

    if (args.verbose) {
      console.log(`📁 Snapshots: ${snapshotDir}`);
    }

    // Exit with appropriate code
    process.exit(results.failed > 0 ? 1 : 0);
  } catch (error) {
    console.error('\n❌ Error:', error instanceof Error ? error.message : error);
    if (args.verbose && error instanceof Error) {
      console.error(error.stack);
    }
    process.exit(2);
  }
}

function parseArgs(): CLIOptions {
  const args: CLIOptions = {
    config: '',
  };

  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    const next = process.argv[i + 1];

    switch (arg) {
      case '--reference':
        args.reference = next;
        i++;
        break;
      case '--test':
        args.test = next;
        i++;
        break;
      case '--config':
        args.config = next;
        i++;
        break;
      case '--output':
        args.output = next;
        i++;
        break;
      case '--max-urls':
        args.maxUrls = parseInt(next, 10);
        i++;
        break;
      case '--project':
        args.project = next;
        i++;
        break;
      case '--verbose':
        args.verbose = true;
        break;
      case '--headed':
        args.headed = true;
        break;
      case '--update-baseline':
        args.updateBaseline = true;
        break;
      case '--clean':
        // Clean snapshots and reports
        console.log('🗑️  Cleaning...');
        ['playwright-snapshots', 'playwright-report', 'playwright-tmp'].forEach(dir => {
          const fullPath = path.resolve(dir);
          if (fs.existsSync(fullPath)) {
            fs.rmSync(fullPath, { recursive: true, force: true });
            console.log(`   Removed: ${dir}/`);
          }
        });
        console.log('✓ Clean complete');
        process.exit(0);
        break;
      case '--help':
      case '-h':
        printUsage();
        process.exit(0);
        break;
    }
  }

  return args;
}

function printUsage(): void {
  console.log(`
Usage: playwright-vrt run [options]

Required (one of):
  --test <url>           Test URL
  --config <path>        Path to config file with testUrl/referenceUrl

Optional:
  --reference <url>      Reference URL (defaults to --test URL or config)
  --output <dir>         Output directory (default: ./playwright-report)
  --max-urls <number>    Override config maxUrls
  --project <name>       Playwright project to run (default: all)
  --verbose              Detailed logging
  --headed               Run browser in headed mode (visible)
  --update-baseline      Force regenerate URLs and baseline snapshots
  --clean                Clean playwright-snapshots/ and playwright-report/
  --help, -h             Show this help message

Examples:
  # Minimal - compare staging against itself (first run creates baseline)
  bunx playwright-vrt run --test https://staging.example.com

  # Compare staging against production
  bunx playwright-vrt run \\
    --reference https://production.com \\
    --test https://staging.com

  # With config file only (contains testUrl and referenceUrl)
  bunx playwright-vrt run --config ./playwright-vrt.config.json

  # With config file + URL override
  bunx playwright-vrt run \\
    --test https://preview-123.staging.com \\
    --config ./playwright-vrt.config.json

Directories:
  playwright-snapshots/  Baseline snapshots and URLs (cache this!)
  playwright-report/     HTML test report
  playwright-tmp/        Temporary test artifacts (cleared on each run)

  Clean with: playwright-vrt run --clean
  Or manually: rm -rf playwright-snapshots playwright-report playwright-tmp
`);
}

// Run the CLI
main();
