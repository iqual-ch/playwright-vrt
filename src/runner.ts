#!/usr/bin/env bun

import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import type { VRTConfig } from './config.js';

export interface TestResults {
  passed: number;
  failed: number;
  total: number;
  exitCode: number;
}

export interface RunnerOptions {
  config: VRTConfig;
  outputDir: string;
  verbose?: boolean;
  project?: string;
  updateBaseline?: boolean;
  hasExplicitReference?: boolean;
  headed?: boolean;
}

/**
 * Check if baseline snapshots already exist and are valid
 */
export function hasExistingSnapshots(snapshotDir: string): boolean {
  if (!fs.existsSync(snapshotDir)) {
    return false;
  }

  // Recursively check for any .png files
  function hasSnapshotFiles(dir: string): boolean {
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (hasSnapshotFiles(fullPath)) {
          return true;
        }
      } else if (entry.name.endsWith('.png')) {
        return true;
      }
    }

    return false;
  }

  return hasSnapshotFiles(snapshotDir);
}

/**
 * Run Playwright tests using the shipped config and test files
 * Much simpler than the old approach - just exec playwright
 */
export async function runVisualTests(options: RunnerOptions): Promise<TestResults> {
  const { config, outputDir, verbose, project, updateBaseline, hasExplicitReference, headed } = options;

  // Find the playwright-vrt package directory
  const packageDir = path.join(__dirname, '..');
  const playwrightConfigPath = path.join(packageDir, 'playwright.config.js');
  const snapshotDir = path.join(process.cwd(), 'playwright-snapshots');

  // Check if baseline snapshots already exist (look for any .png files in snapshots)
  const hasBaseline = !updateBaseline && hasExistingSnapshots(snapshotDir);

  if (hasBaseline) {
    console.log('\n📸 Using existing baseline snapshots');
    if (verbose) {
      console.log('   (Use --update-baseline to regenerate from reference URL)');
    }
  } else {
    if (updateBaseline) {
      console.log('\n🔄 Updating baseline snapshots...');
    } else {
      console.log('\n📸 Creating baseline snapshots (first run)...');
    }
    console.log(`   Source: ${config.referenceUrl}`);

    // Step 1: Create baseline screenshots
    await runPlaywright({
      configPath: playwrightConfigPath,
      baseURL: config.referenceUrl,
      vrtConfig: config,
      outputDir,
      updateSnapshots: true,
      verbose: true,
      project,
      headed,
    });

    console.log('✓ Baseline created');
  }

  console.log(`\n🧪 Testing ${config.testUrl}`);

  // Step 2: Run tests against test URL
  const exitCode = await runPlaywright({
    configPath: playwrightConfigPath,
    baseURL: config.testUrl,
    vrtConfig: config,
    outputDir,
    updateSnapshots: false,
    verbose: true,
    project,
    headed,
  });

  // Parse results
  const results = await parseResults(outputDir);
  results.exitCode = exitCode;

  return results;
}

interface PlaywrightRunOptions {
  configPath: string;
  baseURL: string;
  vrtConfig: VRTConfig;
  outputDir: string;
  updateSnapshots: boolean;
  verbose?: boolean;
  project?: string;
  headed?: boolean;
}

async function runPlaywright(options: PlaywrightRunOptions): Promise<number> {
  return new Promise((resolve, reject) => {
    const args = [
      'playwright',
      'test',
      '--config', options.configPath
    ];

    if (options.updateSnapshots) {
      args.push('--update-snapshots');
    }

    if (options.project) {
      args.push('--project', options.project);
    }

    if (options.headed) {
      args.push('--headed');
    }

    const env = {
      ...process.env,
      BASE_URL: options.baseURL,
      VRT_CONFIG: JSON.stringify(options.vrtConfig),
      OUTPUT_DIR: options.outputDir,
    };

    const proc = spawn('bunx', args, {
      env,
      stdio: options.verbose ? 'inherit' : 'pipe',
      shell: true,
      cwd: process.cwd(),
    });    let stdout = '';
    let stderr = '';

    if (!options.verbose) {
      proc.stdout?.on('data', (data) => {
        stdout += data.toString();
      });
      proc.stderr?.on('data', (data) => {
        stderr += data.toString();
      });
    }

    proc.on('close', (code) => {
      const exitCode = code || 0;

      // For baseline creation (update-snapshots), always succeed
      if (options.updateSnapshots) {
        resolve(0);
      } else {
        // For actual tests, return the exit code
        resolve(exitCode);
      }
    });

    proc.on('error', (error) => {
      reject(new Error(`Failed to run Playwright: ${error.message}`));
    });
  });
}

async function parseResults(outputDir: string): Promise<TestResults> {
  const resultsPath = path.join(outputDir, 'results.json');

  try {
    const file = Bun.file(resultsPath);
    const results = await file.json();

    let passed = 0;
    let failed = 0;
    let total = 0;

    // Parse Playwright JSON results
    if (results.suites) {
      for (const suite of results.suites) {
        if (suite.specs) {
          for (const spec of suite.specs) {
            total++;
            if (spec.ok) {
              passed++;
            } else {
              failed++;
            }
          }
        }
      }
    }

    return { passed, failed, total, exitCode: 0 };
  } catch {
    return { passed: 0, failed: 0, total: 0, exitCode: 1 };
  }
}

export function printResults(results: TestResults, config: VRTConfig): void {
  console.log('\n📊 Test Results:');
  console.log(`   Total: ${results.total}`);
  console.log(`   Passed: ${results.passed}`);
  console.log(`   Failed: ${results.failed}`);

  if (results.failed > 0) {
    console.log(`\n❌ ${results.failed} visual difference(s) detected`);
  } else if (results.total > 0) {
    console.log('\n✅ All visual tests passed');
  }
}
