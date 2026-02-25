#!/usr/bin/env node

import { createRequire } from 'module';
import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

/**
 * Resolve the path to the @playwright/test CLI bundled with this package.
 * Works both in dev (npx ts-node/tsx) and when installed via npx.
 */
export function resolvePlaywrightCli(): string {
  const require = createRequire(import.meta.url);
  try {
    const pkgJsonPath = require.resolve('@playwright/test/package.json');
    const pkgDir = path.dirname(pkgJsonPath);
    const cliPath = path.join(pkgDir, 'cli.js');

    if (!fs.existsSync(cliPath)) {
      throw new Error(`Playwright CLI not found at ${cliPath}`);
    }

    return cliPath;
  } catch (error) {
    throw new Error(
      'Could not resolve @playwright/test CLI. ' +
      'Ensure @playwright/test is installed as a dependency.'
    );
  }
}

/**
 * Ensure Chromium browser is installed for the pinned Playwright version.
 * Runs `playwright install chromium` using the package's own Playwright CLI,
 * guaranteeing the browser version matches the pinned dependency.
 *
 * This is idempotent — if the correct browser is already installed, it exits quickly.
 */
export async function ensureBrowserInstalled(verbose?: boolean): Promise<void> {
  const cliPath = resolvePlaywrightCli();

  console.log('🔧 Ensuring Chromium browser is installed...');
  if (verbose) {
    console.log(`   Playwright CLI: ${cliPath}`);
  }

  return new Promise((resolve, reject) => {
    const proc = spawn('node', [cliPath, 'install', '--with-deps', 'chromium'], {
      stdio: verbose ? 'inherit' : 'pipe',
      shell: false,
    });

    let stderr = '';

    if (!verbose) {
      proc.stderr?.on('data', (data) => {
        stderr += data.toString();
      });
    }

    proc.on('close', (code) => {
      if (code === 0) {
        console.log('✓ Chromium ready');
        resolve();
      } else {
        reject(new Error(
          `Failed to install Chromium (exit code ${code}).` +
          (stderr ? `\n${stderr}` : '')
        ));
      }
    });

    proc.on('error', (error) => {
      reject(new Error(`Failed to run Playwright install: ${error.message}`));
    });
  });
}
