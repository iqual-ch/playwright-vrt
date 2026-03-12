# iqual VRT

**Standalone Visual Regression Testing CLI tool using [Playwright](https://github.com/microsoft/playwright) 🎭**

Zero-installation visual regression testing (VRT) that runs directly in CI/CD. Scale your visual regression testing efforst with a simple config file.

## Quick Start

```sh
npx @iqual/playwright-vrt run \
  --reference https://production.example.com \
  --test https://staging.example.com
```

That's it! The tool will:

- Auto-install the correct Chromium version (matching the pinned Playwright dependency)
- Auto-discover URLs from your sitemap (or crawl the homepage)
- Create baseline screenshots from the reference URL
- Compare against test environment
- Generate visual diff report in `playwright-report/`

> [!TIP]
> Using `--reference` is optional, but requires a baseline if it is not set. You can always (re-)create a baseline with `--udpate-baseline`.

## Why Use This?

- **No per-project code setup** - Just run `npx @iqual/playwright-vrt run --test <url>` or `--config <file>`
- **Smart defaults** - Works without a config file
- **Flexible** - Use CLI args for quick tests, config files for complex setups
- **CI/CD optimized** - Allows caching baselines, auto-detects config changes

## Usage with config

For more advanced setups, or to allow the generation of configuration files it is also possible
to add a `playwright-vrt.config.json` config file in your current working directory:

```json
{
  "referenceUrl": "https://production.example.com",
  "testUrl": "https://staging.example.com",
  "maxUrls": 25,
  "exclude": ["**/admin/**"]
}
```

Then run the VRT using the `--config` flag:

```bash
# Run with config file (includes both URLs)
npx @iqual/playwright-vrt run --config ./playwright-vrt.config.json
```

## Features

- ✅ **Zero code** - Run with `npx`, no custom code needed
- ✅ **Auto browser install** - Automatically installs the correct Chromium version
- ✅ **Auto URL discovery** - Sitemap parsing + crawler fallback
- ✅ **Smart caching** - Reuses URLs and baselines, avoids hitting production
- ✅ **Multi-viewport** - Test desktop, mobile, tablet simultaneously
- ✅ **Standard reports** - Playwright HTML reports with visual diffs
- ✅ **CI/CD ready** - Built for GitHub Actions, GitLab CI, etc.

## Configuration

Full config example (includes URLs + advanced settings):

```json
{
  "referenceUrl": "https://production.com",
  "testUrl": "https://staging.com",
  "sitemapPath": "/sitemap.xml",
  "maxUrls": 25,
  "exclude": ["**/admin/**", "**/user/**"],
  "include": ["**"],
  "viewports": [
    { "name": "desktop", "width": 1920, "height": 1080 },
    { "name": "mobile", "width": 375, "height": 667 }
  ],
  "threshold": {
    "maxDiffPixels": 100,
    "maxDiffPixelRatio": 0.01
  },
  "extraHTTPHeaders": {
    "Authorization": "Basic dXNlcjpwYXNz"
  }
}
```

## CLI Options

```bash
npx @iqual/playwright-vrt run \
  --test <url>           # Test URL (required if no config)
  --config <path>        # Config file (required if no --test)
  --reference <url>      # Reference URL (optional, for comparison)
  --output <dir>         # Output directory
  --max-urls <number>    # Limit URLs to test
  --project <name>       # Test specific viewport only
  --verbose              # Detailed logging
  --update-baseline      # Force regenerate URLs and baseline snapshots
  --skip-install         # Skip automatic Chromium installation
  --clean                # Remove all cached data

Note: If no --reference is provided and no baseline exists, you must use --update-baseline
```

## Caching & Performance

## Baseline Behavior

The tool requires a **reference URL** or an **existing baseline** to run:

**With explicit reference URL:**

- Provided via `--reference` flag or `referenceUrl` in config
- Baseline is created/updated from the reference system
- Test URL is compared against this baseline

**Without explicit reference URL:**

- **First run**: You must use `--update-baseline` to create initial baseline from test URL
- **Subsequent runs**: Compares test URL against cached baseline
- Fails if no baseline exists and `--update-baseline` not set

This prevents accidentally creating baselines from the wrong environment.

The tool intelligently caches URLs and baseline snapshots based on your **configuration**:

**First run:**

- Collects URLs from sitemap/crawler
- Creates baseline snapshots from `referenceUrl`
- Stores cache validation hashes
- Tests against `testUrl`

**Subsequent runs:**

- Validates cache by checking config and test file hashes
- If cache is valid: reuses URLs and baseline snapshots
- If cache is invalid: automatically regenerates (config/test changed)
- Only tests against `testUrl` (reference system not touched when cache is valid!)

**Automatic cache invalidation:**

The cache is automatically invalidated and regenerated when:

- Configuration changes (URLs, viewports, filters, thresholds, etc.)
- Test file (`vrt.spec.js`) changes in the package

The hash is based on the **final merged config object**, not the config file itself.

**Force update:**

```bash
npx @iqual/playwright-vrt run --config config.json --update-baseline
```

This regenerates both URLs and baseline snapshots from the reference system regardless of cache validity.

**Directory structure:**

- `playwright-snapshots/` - Cached URLs + baseline screenshots (cache this in CI!)
- `playwright-report/` - HTML test report + results
- `playwright-tmp/` - Temporary test artifacts (auto-cleared)

## GitHub Actions

This project provides a composite GitHub Action for easy integration. It handles Node.js setup, baseline caching, running the tests, and uploading the report artifact.

```yaml
- name: Visual Regression Tests
  uses: iqual-ch/playwright-vrt@v0
  with:
    config: playwright-vrt.config.json
```

### Action Inputs

| Input | Description | Required | Default |
|-------|-------------|----------|---------|
| `config` | Path to `playwright-vrt.config.json` file | No | |
| `node-version` | Node.js version to use | No | `24` |
| `cache` | Enable caching of baseline snapshots | No | `true` |
| `cache-key` | Custom additional cache key for baseline snapshots | No | `default` |
| `upload-report` | Upload Playwright HTML report as artifact | No | `true` |
| `report-name` | Name of the uploaded report artifact | No | `vrt-report` |
| `working-directory` | Working directory for the VRT run | No | `.` |

## How It Works

1. **Collect URLs** - Parse sitemap or crawl site (cached after first run)
2. **Filter & limit** - Apply include/exclude patterns, limit to maxUrls
3. **Create baseline** - Screenshot all URLs from `referenceUrl` (cached after first run)
4. **Run tests** - Screenshot all URLs from `testUrl` and compare
5. **Generate report** - Create Playwright HTML report with diffs

All URLs and baseline snapshots are cached in `playwright-snapshots/` to minimize load on your production system.

## Exit Codes

- `0` - All tests passed
- `1` - Visual differences detected
- `2` - Configuration or runtime error

## Requirements

- [Node.js](https://nodejs.org) v24+ (for `npx` command)
- Chromium is installed automatically (use `--skip-install` to disable)
