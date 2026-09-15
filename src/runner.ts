#!/usr/bin/env node

import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';
import type { VRTConfig } from './config.js';
import { resolvePlaywrightCli } from './browser.js';
import { buildPlan, pathOf, probeHost, type HostProbe, type Plan } from './preflight.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Reference host: parallel. */
const REFERENCE_PROBE = { timeout: 60_000, concurrency: 4 };
/** Test host: sequential, so a cold site renders every page once before the timed run. */
const TEST_PROBE = { timeout: 60_000, concurrency: 1 };

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
 * Pre-flight both hosts, create the baseline from the reference host (unless
 * cached), then screenshot the test host and compare.
 */
export async function runVisualTests(options: RunnerOptions): Promise<TestResults> {
  const { config, outputDir, verbose, project, updateBaseline, headed } = options;

  // Find the playwright-vrt package directory
  const packageDir = path.join(__dirname, '..');
  const playwrightConfigPath = path.join(packageDir, 'playwright.config.js');
  const snapshotDir = path.join(process.cwd(), 'playwright-snapshots');
  const planPath = path.join(snapshotDir, 'plan.json');
  const urls: string[] = JSON.parse(fs.readFileSync(path.join(snapshotDir, 'urls.json'), 'utf-8'));

  // Check if baseline snapshots already exist (look for any .png files in snapshots)
  const hasBaseline = !updateBaseline && hasExistingSnapshots(snapshotDir);
  const previousPlan = hasBaseline ? readPlan(planPath) : undefined;

  // Step 1: Pre-flight
  let plan: Plan;
  if (config.preflight !== false) {
    plan = await preflight(urls, config, hasBaseline, previousPlan, verbose);
  } else {
    plan = buildPlan(urls, config, undefined, undefined, previousPlan);
  }
  writePlan(planPath, plan);

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

    // Step 2: Create baseline screenshots
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

  // Step 3: Run tests against test URL
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

/**
 * One plain request per URL on both hosts. The reference host is only probed
 * when the baseline is (re)created or a URL is new; otherwise the cached probe is reused.
 */
async function preflight(
  urls: string[],
  config: VRTConfig,
  hasBaseline: boolean,
  previousPlan: Plan | undefined,
  verbose?: boolean,
): Promise<Plan> {
  const paths = urls.map(pathOf);
  const headers = config.extraHTTPHeaders || {};

  console.log('\n🔎 Pre-flight: one request per URL on both hosts (warm-up, redirects)');

  let referenceProbes: Map<string, HostProbe> | undefined;
  const knownReference = new Set((previousPlan?.entries || []).filter(e => e.reference).map(e => e.url));
  const referencePaths = hasBaseline && previousPlan
    ? urls.filter(u => !knownReference.has(u)).map(pathOf)
    : paths;
  if (referencePaths.length > 0) {
    console.log(`   Reference ${config.referenceUrl} (${referencePaths.length} URLs)`);
    referenceProbes = await probeHost(config.referenceUrl, referencePaths, { ...REFERENCE_PROBE, headers, verbose });
  } else {
    console.log(`   Reference ${config.referenceUrl}: reusing probes from cached plan`);
  }

  console.log(`   Test ${config.testUrl} (${paths.length} URLs, sequential, also warms up the site)`);
  const testProbes = await probeHost(config.testUrl, paths, { ...TEST_PROBE, headers, verbose });

  const plan = buildPlan(urls, config, referenceProbes, testProbes, previousPlan);

  const redirected = plan.entries.filter(e => e.path !== pathOf(e.url));
  if (redirected.length > 0) {
    console.log(`\n↪️  ${redirected.length} URL(s) redirect on the reference host; comparing the final path on both sides:`);
    for (const e of redirected) {
      console.log(`   - ${pathOf(e.url)} → ${e.path}`);
    }
  }
  const noted = plan.entries.filter(e => e.notes && e.notes.length > 0);
  if (noted.length > 0) {
    console.log(`\n⚠️  Pre-flight notes for ${noted.length} URL(s) (still tested; use "exclude" in the config if these are expected):`);
    for (const e of noted) {
      console.log(`   - ${e.url}: ${e.notes!.join('; ')}`);
    }
  } else {
    console.log(`✓ All ${plan.entries.length} URLs answer with the same status on both hosts`);
  }

  return plan;
}

function readPlan(planPath: string): Plan | undefined {
  try {
    return JSON.parse(fs.readFileSync(planPath, 'utf-8')) as Plan;
  } catch {
    return undefined;
  }
}

function writePlan(planPath: string, plan: Plan): void {
  fs.mkdirSync(path.dirname(planPath), { recursive: true });
  fs.writeFileSync(planPath, JSON.stringify(plan, null, 2), 'utf-8');
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
    const cliPath = resolvePlaywrightCli();
    const args = [
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

    const proc = spawn('node', [cliPath, ...args], {
      env,
      stdio: options.verbose ? 'inherit' : 'pipe',
      shell: false,
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
    const raw = fs.readFileSync(resultsPath, 'utf-8');
    const results = JSON.parse(raw);

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
