// End-to-end tests: two local fixture sites, the BUILT CLI (dist/src/cli.js) run against
// them in a fresh temp directory per scenario, assertions on exit code and output files.
// Build first: `npm run build`, then `node --test test/e2e/*.test.js`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startSite } from './server.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = path.join(REPO_ROOT, 'dist', 'src', 'cli.js');

const HEADER = 'x-automated-by';
const HEADER_VALUE = 'iqual/playwright-vrt';

// Each scenario runs Playwright twice (baseline + test) with retries; leave room for CI=true (retries: 2).
const TEST_TIMEOUT = 240_000;
const CLI_TIMEOUT = 210_000;

// Three pages; "/" redirects to "/de/" so the plan has to resolve the final path.
const PAGES = { '/de/': 'home.html', '/de/about': 'about.html', '/de/contact': 'contact.html' };
const SITEMAP = ['/', '/de/about', '/de/contact'];
const REDIRECTS = { '/': '/de/' };

test.before(() => {
  assert.ok(fs.existsSync(CLI), `Built CLI not found at ${CLI}. Run "npm run build" first.`);
});

test('A: identical sites (reference redirects / to /de/) pass; the cached second run never contacts the reference', { timeout: TEST_TIMEOUT }, async (t) => {
  const reference = await startSite({ pages: PAGES, sitemap: SITEMAP, redirects: REDIRECTS });
  const site = await startSite({ pages: PAGES, sitemap: SITEMAP, redirects: REDIRECTS });
  t.after(() => Promise.all([reference.close(), site.close()]));
  const cwd = makeWorkspace(reference.origin, site.origin);
  const ws = keepOnFailure(t, cwd);

  // First run: collect, pre-flight, baseline, test.
  const first = await runCli(cwd);
  assert.equal(first.code, 0, describeRun('first run', first, cwd));

  const summary = readJson(path.join(cwd, 'playwright-report', 'summary.json'));
  assert.equal(summary.passed, 3, `summary.json.passed\n${describeRun('first run', first, cwd)}`);
  assert.equal(summary.failed, 0, `summary.json.failed\n${describeRun('first run', first, cwd)}`);
  assert.equal(summary.total, 3);
  assert.ok(fs.existsSync(path.join(cwd, 'playwright-report', 'summary.md')), 'summary.md is written');
  assert.ok(fs.existsSync(path.join(cwd, 'playwright-report', 'results.json')), 'results.json is written');
  assert.ok(fs.existsSync(path.join(cwd, 'playwright-report', 'index.html')), 'index.html is written');
  const summaryMd = fs.readFileSync(path.join(cwd, 'playwright-report', 'summary.md'), 'utf-8');
  assert.match(summaryMd, /\| Passed \| Failed \| Total \|/);
  assert.match(summaryMd, /\| 3 \| 0 \| 3 \|/);

  // The redirect on the reference host is followed and the final path is compared on both sides.
  const plan = readJson(path.join(cwd, 'playwright-snapshots', 'plan.json'));
  const rootEntry = plan.entries.find((e) => e.url === `${reference.origin}/`);
  assert.ok(rootEntry, `plan.json has an entry for ${reference.origin}/: ${JSON.stringify(plan.entries.map((e) => e.url))}`);
  assert.equal(rootEntry.path, '/de/', `plan.json entry for / follows the redirect: ${JSON.stringify(rootEntry)}`);
  assert.equal(plan.entries.length, 3);

  const pngs = listPngs(path.join(cwd, 'playwright-snapshots'));
  assert.equal(pngs.length, 3, `three baseline snapshots: ${JSON.stringify(pngs)}`);

  // Every request to either host (sitemap, pre-flight, browser) carries the automation header.
  assert.ok(reference.requests.some((r) => r.path === '/sitemap.xml'), 'the sitemap was fetched from the reference host');
  assert.ok(reference.requests.some((r) => r.path === '/de/about'), 'the reference host served /de/about');
  assert.ok(site.requests.some((r) => r.path === '/de/about'), 'the test host served /de/about');
  assertHeaderOnEveryRequest(reference.requests, 'reference host');
  assertHeaderOnEveryRequest(site.requests, 'test host');

  // Second run in the same cwd: baseline and reference probes are reused; the reference host stays untouched.
  const referenceRequestsAfterFirstRun = reference.requests.length;
  const siteRequestsAfterFirstRun = site.requests.length;
  const second = await runCli(cwd);
  assert.equal(second.code, 0, describeRun('second run', second, cwd));
  assert.match(second.stdout, /Using existing baseline snapshots/, describeRun('second run', second, cwd));
  assert.doesNotMatch(second.stdout, /Creating baseline snapshots/, describeRun('second run', second, cwd));
  const extraReferenceRequests = reference.requests.slice(referenceRequestsAfterFirstRun).map((r) => `${r.method} ${r.path}`);
  assert.deepEqual(extraReferenceRequests, [], `the cached run must not contact the reference host, but it requested: ${JSON.stringify(extraReferenceRequests)}`);
  assert.ok(site.requests.length > siteRequestsAfterFirstRun, 'the cached run still tests the test host');
  const summary2 = readJson(path.join(cwd, 'playwright-report', 'summary.json'));
  assert.equal(summary2.passed, 3, describeRun('second run', second, cwd));
  assert.equal(summary2.failed, 0, describeRun('second run', second, cwd));
  assert.equal(listPngs(path.join(cwd, 'playwright-snapshots')).length, 3, 'no extra snapshots after the cached run');

  ws.passed();
});

test('B: a page that renders differently on the test host fails with a visual difference', { timeout: TEST_TIMEOUT }, async (t) => {
  const reference = await startSite({ pages: PAGES, sitemap: SITEMAP, redirects: REDIRECTS });
  const site = await startSite({ pages: PAGES, sitemap: SITEMAP, redirects: REDIRECTS, overrides: { '/de/about': 'about-changed.html' } });
  t.after(() => Promise.all([reference.close(), site.close()]));
  const cwd = makeWorkspace(reference.origin, site.origin);
  const ws = keepOnFailure(t, cwd);
  const changedUrl = `${reference.origin}/de/about`;

  const run = await runCli(cwd);
  assert.equal(run.code, 1, describeRun('run', run, cwd));

  const summaryMd = fs.readFileSync(path.join(cwd, 'playwright-report', 'summary.md'), 'utf-8');
  assert.match(summaryMd, /### Visual differences/, `summary.md:\n${summaryMd}`);
  assert.match(summaryMd, /\d+ pixels differ \(ratio [\d.]+\)/, `summary.md carries the pixel count:\n${summaryMd}`);
  assert.ok(summaryMd.includes(changedUrl), `summary.md names ${changedUrl}:\n${summaryMd}`);
  assert.doesNotMatch(summaryMd, /### No baseline from the reference host/, `summary.md:\n${summaryMd}`);
  assert.match(summaryMd, /\| 2 \| 1 \| 3 \|/, `summary.md:\n${summaryMd}`);

  const summary = readJson(path.join(cwd, 'playwright-report', 'summary.json'));
  assert.equal(summary.passed, 2, describeRun('run', run, cwd));
  assert.equal(summary.failed, 1, describeRun('run', run, cwd));
  assert.equal(summary.total, 3);
  const changed = summary.outcomes.find((o) => o.url === changedUrl);
  assert.ok(changed, `outcome for ${changedUrl}: ${JSON.stringify(summary.outcomes)}`);
  assert.equal(changed.status, 'failed');
  assert.equal(changed.project, 'desktop');
  assert.ok(!changed.noBaseline, `a visual difference is not a missing baseline: ${JSON.stringify(changed)}`);
  assert.match(changed.message || '', /screenshot|pixels|differ/i, `failure message mentions the comparison: ${JSON.stringify(changed)}`);
  for (const o of summary.outcomes.filter((o) => o.url !== changedUrl)) {
    assert.equal(o.status, 'passed', `other URLs pass: ${JSON.stringify(o)}`);
  }

  // Baseline exists for every URL, including the changed one (it was captured on the reference host).
  assert.equal(listPngs(path.join(cwd, 'playwright-snapshots')).length, 3);

  ws.passed();
});

test('C: a URL the reference host cannot serve gets no baseline and fails in the test phase', { timeout: TEST_TIMEOUT }, async (t) => {
  const reference = await startSite({ pages: PAGES, sitemap: SITEMAP, redirects: REDIRECTS, destroy: ['/de/contact'] });
  const site = await startSite({ pages: PAGES, sitemap: SITEMAP, redirects: REDIRECTS });
  t.after(() => Promise.all([reference.close(), site.close()]));
  const cwd = makeWorkspace(reference.origin, site.origin);
  const ws = keepOnFailure(t, cwd);
  const brokenUrl = `${reference.origin}/de/contact`;

  const run = await runCli(cwd);
  assert.equal(run.code, 1, describeRun('run', run, cwd));

  const plan = readJson(path.join(cwd, 'playwright-snapshots', 'plan.json'));
  const broken = plan.entries.find((e) => e.url === brokenUrl);
  assert.ok(broken, `plan.json has an entry for ${brokenUrl}`);
  assert.equal(typeof broken.baselineFailed?.desktop, 'string', `plan.json records the failed baseline: ${JSON.stringify(broken)}`);
  assert.ok(broken.notes?.some((n) => /reference unreachable/.test(n)), `pre-flight noted the unreachable reference: ${JSON.stringify(broken)}`);
  for (const e of plan.entries.filter((e) => e.url !== brokenUrl)) {
    assert.equal(e.baselineFailed, undefined, `other entries have a baseline: ${JSON.stringify(e)}`);
  }

  const summaryMd = fs.readFileSync(path.join(cwd, 'playwright-report', 'summary.md'), 'utf-8');
  assert.match(summaryMd, /### No baseline from the reference host/, `summary.md:\n${summaryMd}`);
  assert.ok(summaryMd.includes(brokenUrl), `summary.md names ${brokenUrl}:\n${summaryMd}`);
  assert.doesNotMatch(summaryMd, /### Visual differences/, `summary.md:\n${summaryMd}`);

  const summary = readJson(path.join(cwd, 'playwright-report', 'summary.json'));
  assert.equal(summary.passed, 2, describeRun('run', run, cwd));
  assert.equal(summary.failed, 1, describeRun('run', run, cwd));
  const outcome = summary.outcomes.find((o) => o.url === brokenUrl);
  assert.ok(outcome, `outcome for ${brokenUrl}: ${JSON.stringify(summary.outcomes)}`);
  assert.equal(outcome.status, 'failed');
  assert.ok(outcome.noBaseline, `outcome carries noBaseline: ${JSON.stringify(outcome)}`);
  assert.match(outcome.message || '', /snapshot doesn't exist/i, `test phase fails on the missing snapshot: ${JSON.stringify(outcome)}`);

  // The test phase runs with updateSnapshots 'none': no golden is written for the URL without a baseline.
  const pngs = listPngs(path.join(cwd, 'playwright-snapshots'));
  assert.equal(pngs.length, SITEMAP.length - 1, `one snapshot per URL minus the broken one: ${JSON.stringify(pngs)}`);
  assert.ok(pngs.every((p) => !p.includes('contact')), `no golden for the broken URL: ${JSON.stringify(pngs)}`);

  assert.match(run.stdout, /baseline screenshot\(s\) could not be captured/, describeRun('run', run, cwd));

  ws.passed();
});

test('D: when no baseline can be created at all the CLI exits 2', { timeout: TEST_TIMEOUT }, async (t) => {
  const reference = await startSite({ pages: PAGES, sitemap: SITEMAP, redirects: REDIRECTS, destroy: ['/', '/de/', '/de/about', '/de/contact'] });
  const site = await startSite({ pages: PAGES, sitemap: SITEMAP, redirects: REDIRECTS });
  t.after(() => Promise.all([reference.close(), site.close()]));
  const cwd = makeWorkspace(reference.origin, site.origin);
  const ws = keepOnFailure(t, cwd);

  const run = await runCli(cwd);
  assert.equal(run.code, 2, describeRun('run', run, cwd));
  assert.ok(
    (run.stdout + run.stderr).includes('Baseline could not be created for any URL'),
    describeRun('run', run, cwd),
  );
  assert.equal(listPngs(path.join(cwd, 'playwright-snapshots')).length, 0, 'no snapshot was written');
  assert.ok(!fs.existsSync(path.join(cwd, 'playwright-report', 'summary.json')), 'no summary for an aborted run');

  ws.passed();
});

// --- helpers -------------------------------------------------------------------------

function makeWorkspace(referenceUrl, testUrl) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'playwright-vrt-e2e-'));
  fs.writeFileSync(
    path.join(cwd, 'playwright-vrt.config.json'),
    JSON.stringify({ referenceUrl, testUrl, maxUrls: 10 }, null, 2),
    'utf-8',
  );
  return cwd;
}

/** Remove the temp workspace after the test unless it failed (kept for diagnosis; the path is in every message). */
function keepOnFailure(t, cwd) {
  let passed = false;
  t.after(() => {
    if (passed) fs.rmSync(cwd, { recursive: true, force: true });
  });
  return { passed: () => { passed = true; } };
}

function runCli(cwd) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    // Do not leak the node:test context into the CLI's child processes. CI is passed through unchanged.
    delete env.NODE_TEST_CONTEXT;

    const proc = spawn(process.execPath, [CLI, 'run', '--config', 'playwright-vrt.config.json', '--skip-install'], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`CLI did not finish within ${CLI_TIMEOUT} ms\n${formatOutput(stdout, stderr)}`));
    }, CLI_TIMEOUT);

    proc.on('error', (error) => { clearTimeout(timer); reject(error); });
    proc.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

function describeRun(label, run, cwd) {
  return `${label}: exit ${run.code}${run.signal ? ` (signal ${run.signal})` : ''}, workspace ${cwd}\n${formatOutput(run.stdout, run.stderr)}`;
}

function formatOutput(stdout, stderr) {
  const cap = (s) => (s.length > 20_000 ? `…(${s.length - 20_000} chars trimmed)\n${s.slice(-20_000)}` : s);
  return `--- stdout ---\n${cap(stdout)}\n--- stderr ---\n${cap(stderr)}\n--------------`;
}

function readJson(file) {
  assert.ok(fs.existsSync(file), `${file} exists`);
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

/** Relative paths of every .png under dir (recursively). */
function listPngs(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.png')) out.push(path.relative(dir, full));
    }
  };
  walk(dir);
  return out;
}

function assertHeaderOnEveryRequest(requests, label) {
  assert.ok(requests.length > 0, `${label} received requests`);
  const missing = requests.filter((r) => r.headers[HEADER] !== HEADER_VALUE).map((r) => `${r.method} ${r.path} (${HEADER}: ${JSON.stringify(r.headers[HEADER])})`);
  assert.deepEqual(missing, [], `${label}: every request carries "${HEADER}: ${HEADER_VALUE}"; ${missing.length} of ${requests.length} did not`);
}
