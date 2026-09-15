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

export interface TestOutcome {
  url: string;
  project: string;
  status: 'passed' | 'failed' | 'flaky' | 'skipped';
  /** Error message of the last attempt. */
  message?: string;
  /** Set when the failure is a missing baseline; holds the baseline capture error. */
  noBaseline?: string;
}

export interface TestResults {
  passed: number;
  failed: number;
  flaky: number;
  skipped: number;
  total: number;
  exitCode: number;
  outcomes: TestOutcome[];
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
    for (const entry of plan.entries) {
      delete entry.baselineFailed;
    }
    writePlan(planPath, plan);

    await runPlaywright({
      configPath: playwrightConfigPath,
      baseURL: config.referenceUrl,
      vrtConfig: config,
      outputDir,
      phase: 'baseline',
      verbose: true,
      project,
      headed,
    });

    const baselineOutcomes = parsePlaywrightResults(outputDir);
    let failedBaselines = 0;
    for (const outcome of baselineOutcomes) {
      if (outcome.status !== 'failed') continue;
      const entry = plan.entries.find(e => e.url === outcome.url);
      if (!entry) continue;
      entry.baselineFailed = { ...entry.baselineFailed, [outcome.project]: outcome.message || 'baseline capture failed' };
      failedBaselines++;
    }
    writePlan(planPath, plan);

    if (failedBaselines > 0) {
      console.log(`\n⚠️  ${failedBaselines} baseline screenshot(s) could not be captured on ${config.referenceUrl}:`);
      for (const outcome of baselineOutcomes) {
        if (outcome.status === 'failed') {
          console.log(`   - ${outcome.url} [${outcome.project}]: ${outcome.message}`);
        }
      }
      console.log('   These URLs have no baseline and fail in the test phase.');

      const attempted = baselineOutcomes.filter(o => o.status !== 'skipped').length;
      if (attempted > 0 && failedBaselines === attempted) {
        throw new Error(`Baseline could not be created for any URL on ${config.referenceUrl}. Reference host unreachable or every page unstable.`);
      }
    } else {
      console.log('✓ Baseline created');
    }
  }

  console.log(`\n🧪 Testing ${config.testUrl}`);

  // Step 3: Run tests against test URL
  const exitCode = await runPlaywright({
    configPath: playwrightConfigPath,
    baseURL: config.testUrl,
    vrtConfig: config,
    outputDir,
    phase: 'test',
    verbose: true,
    project,
    headed,
  });

  const results = summarize(parsePlaywrightResults(outputDir), plan);
  results.exitCode = exitCode;

  writeSummary(outputDir, config, results, plan);

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
  phase: 'baseline' | 'test';
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
      VRT_PHASE: options.phase,
      OUTPUT_DIR: options.outputDir,
    };

    const proc = spawn('node', [cliPath, ...args], {
      env,
      stdio: options.verbose ? 'inherit' : 'pipe',
      shell: false,
      cwd: process.cwd(),
    });

    let stderr = '';

    if (!options.verbose) {
      proc.stdout?.on('data', () => undefined);
      proc.stderr?.on('data', (data) => {
        stderr += data.toString();
      });
    }

    proc.on('close', (code) => {
      resolve(code || 0);
    });

    proc.on('error', (error) => {
      reject(new Error(`Failed to run Playwright: ${error.message}${stderr ? `\n${stderr}` : ''}`));
    });
  });
}

/** Read Playwright's JSON report and return one outcome per (URL, project). */
export function parsePlaywrightResults(outputDir: string): TestOutcome[] {
  const resultsPath = path.join(outputDir, 'results.json');
  const outcomes: TestOutcome[] = [];

  let report: any;
  try {
    report = JSON.parse(fs.readFileSync(resultsPath, 'utf-8'));
  } catch {
    return outcomes;
  }

  const visit = (suite: any) => {
    for (const spec of suite.specs || []) {
      const url = String(spec.title || '').replace(/^VRT: /, '');
      for (const test of spec.tests || []) {
        const project = test.projectName || test.projectId || 'default';
        const attempts: any[] = test.results || [];
        const last = attempts[attempts.length - 1];
        let status: TestOutcome['status'];
        let message: string | undefined;

        switch (test.status) {
          case 'expected':
            status = 'passed';
            break;
          case 'flaky':
            status = 'flaky';
            break;
          case 'skipped':
            status = 'skipped';
            break;
          default:
            status = 'failed';
            message = describeFailure(last?.error?.message || last?.errors?.[0]?.message || 'failed');
        }

        outcomes.push({ url, project, status, message });
      }
    }
    for (const child of suite.suites || []) {
      visit(child);
    }
  };

  for (const suite of report.suites || []) {
    visit(suite);
  }

  return outcomes;
}

function summarize(outcomes: TestOutcome[], plan: Plan): TestResults {
  const results: TestResults = { passed: 0, failed: 0, flaky: 0, skipped: 0, total: outcomes.length, exitCode: 0, outcomes };
  const byUrl = new Map(plan.entries.map(e => [e.url, e]));
  for (const o of outcomes) {
    if (o.status === 'passed') results.passed++;
    else if (o.status === 'flaky') { results.passed++; results.flaky++; }
    else if (o.status === 'skipped') results.skipped++;
    else {
      results.failed++;
      const reason = byUrl.get(o.url)?.baselineFailed?.[o.project];
      if (reason) o.noBaseline = reason;
    }
  }
  return results;
}

function writeSummary(outputDir: string, config: VRTConfig, results: TestResults, plan: Plan): void {
  fs.mkdirSync(outputDir, { recursive: true });

  const failed = results.outcomes.filter(o => o.status === 'failed' && !o.noBaseline);
  const noBaseline = results.outcomes.filter(o => o.status === 'failed' && o.noBaseline);
  const flaky = results.outcomes.filter(o => o.status === 'flaky');
  const noted = plan.entries.filter(e => e.notes && e.notes.length > 0);

  const lines: string[] = [];
  lines.push('## Visual Regression Test summary');
  lines.push('');
  lines.push(`Reference: ${config.referenceUrl}  `);
  lines.push(`Test: ${config.testUrl}`);
  lines.push('');
  lines.push('| Passed | Failed | Total |');
  lines.push('|---:|---:|---:|');
  lines.push(`| ${results.passed}${results.flaky ? ` (${results.flaky} flaky)` : ''} | ${results.failed} | ${results.total} |`);
  if (failed.length > 0) {
    lines.push('', '### Visual differences', '');
    for (const o of failed) lines.push(`- ${o.url} [${o.project}]: ${o.message || ''}`);
  }
  if (noBaseline.length > 0) {
    lines.push('', '### No baseline from the reference host', '');
    for (const o of noBaseline) lines.push(`- ${o.url} [${o.project}]: ${o.noBaseline}`);
  }
  if (flaky.length > 0) {
    lines.push('', '### Flaky (passed on retry)', '');
    for (const o of flaky) lines.push(`- ${o.url} [${o.project}]`);
  }
  if (noted.length > 0) {
    lines.push('', '### Pre-flight notes', '');
    for (const e of noted) lines.push(`- ${e.url}: ${e.notes!.join('; ')}`);
  }
  lines.push('');

  fs.writeFileSync(path.join(outputDir, 'summary.md'), lines.join('\n'), 'utf-8');
  fs.writeFileSync(path.join(outputDir, 'summary.json'), JSON.stringify({
    generatedAt: new Date().toISOString(),
    referenceUrl: config.referenceUrl,
    testUrl: config.testUrl,
    passed: results.passed,
    failed: results.failed,
    flaky: results.flaky,
    total: results.total,
    outcomes: results.outcomes,
    preflightNotes: noted.map(e => ({ url: e.url, notes: e.notes })),
  }, null, 2), 'utf-8');
}

export function printResults(results: TestResults, config: VRTConfig): void {
  console.log('\n📊 Test Results:');
  console.log(`   Total:  ${results.total}`);
  console.log(`   Passed: ${results.passed}${results.flaky ? ` (${results.flaky} flaky)` : ''}`);
  console.log(`   Failed: ${results.failed}`);

  const noBaseline = results.outcomes.filter(o => o.noBaseline);
  if (noBaseline.length > 0) {
    console.log('\n⚠️  Failed without a baseline (reference capture failed):');
    for (const o of noBaseline) {
      console.log(`   - ${o.url} [${o.project}]: ${o.noBaseline}`);
    }
  }

  if (results.failed > 0) {
    console.log(`\n❌ ${results.failed} test(s) failed`);
  } else if (results.total > 0) {
    console.log('\n✅ All visual tests passed');
  }
}

function stripAnsi(text: string): string {
  return text.replace(/\[[0-9;]*m/g, '');
}

/** Screenshot failures are summarised by their size mismatch and pixel count; anything else by its first line. */
function describeFailure(message: string): string {
  const text = stripAnsi(message);
  const size = text.match(/Expected an image \d+px by \d+px, received \d+px by \d+px\./);
  const pixels = text.match(/(\d+) pixels \(ratio ([\d.]+) of all image pixels\) are different/);
  if (size || pixels) {
    return [size?.[0], pixels ? `${pixels[1]} pixels differ (ratio ${pixels[2]})` : undefined].filter(Boolean).join(' ');
  }
  return firstLine(text).replace(/^Error: /, '');
}

function firstLine(text: string): string {
  return text.split('\n').map(l => l.trim()).filter(Boolean)[0] || text;
}
