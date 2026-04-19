/**
 * Run Vitest and/or Playwright test suites with optional filtering.
 *
 * Flags:
 *   -q / --quiet              Minimal output (summary line + JSON path). Sets VITEST_QUIET=1.
 *   --timeout=<seconds>       Wall-clock timeout per suite (default 600s). Kills the
 *                             subprocess if exceeded.
 *   --test-timeout=<ms>       Per-test timeout forwarded to vitest (default 15000ms).
 *
 * Filter args (positional or `--`-prefixed keywords):
 *   Any non-flag argument is treated as a filter. Filters are routed by path shape:
 *     - path contains `e2e/` or ends `.spec.ts`         -> playwright
 *     - path contains `src/` or ends `.test.ts`         -> vitest
 *     - everything else (bare keywords)                 -> both suites
 *   When any filter targets only one suite, the other suite is skipped (unless a
 *   keyword also applies to both).
 *
 * Examples:
 *   npm test                                 # run everything
 *   npm test -q state-pool                   # keyword filter, both suites
 *   npm test -q --state-pool                 # same -- leading `--` on keywords is stripped
 *   npm test -q src/solver/analog            # vitest only, path filter
 *   npm test -q e2e/gui/tutorial.spec.ts     # playwright only, path filter
 */
import { spawnSync } from 'child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { dirname, resolve } from 'path';

const args = process.argv.slice(2);

let quietMode = false;
let suiteTimeoutSeconds = 600;
let perTestTimeoutMs = 15000;
const rawFilters = [];

for (const a of args) {
  if (a === '-q' || a === '--quiet') { quietMode = true; continue; }
  const mSuite = /^--timeout=(\d+)$/.exec(a);
  if (mSuite) { suiteTimeoutSeconds = Number(mSuite[1]); continue; }
  const mPer = /^--test-timeout=(\d+)$/.exec(a);
  if (mPer) { perTestTimeoutMs = Number(mPer[1]); continue; }
  // Anything else is a filter. Strip leading `--` so `--state-pool` becomes `state-pool`.
  rawFilters.push(a.startsWith('--') ? a.slice(2) : a);
}

function classify(filter) {
  const norm = filter.replace(/\\/g, '/');
  if (/(^|\/)e2e\//.test(norm) || /\.spec\./.test(norm)) return 'playwright';
  if (/(^|\/)src\//.test(norm) || /\.test\./.test(norm)) return 'vitest';
  return 'both';
}

const classified = rawFilters.map(f => ({ filter: f, kind: classify(f) }));
const vitestFilters = classified.filter(c => c.kind !== 'playwright').map(c => c.filter);
const playwrightFilters = classified.filter(c => c.kind !== 'vitest').map(c => c.filter);

const runVitest = rawFilters.length === 0 || vitestFilters.length > 0;
const runPlaywright = rawFilters.length === 0 || playwrightFilters.length > 0;

const env = { ...process.env };
if (quietMode) env.VITEST_QUIET = '1';

const suiteTimeoutMs = suiteTimeoutSeconds * 1000;

let vitest = null;
if (runVitest) {
  const vitestArgv = ['vitest', 'run', `--test-timeout=${perTestTimeoutMs}`, ...vitestFilters];
  vitest = spawnSync('npx', vitestArgv, {
    stdio: 'inherit',
    shell: true,
    env,
    timeout: suiteTimeoutMs,
    killSignal: 'SIGKILL',
  });
  if (vitest.error && vitest.error.code === 'ETIMEDOUT') {
    console.error(`[run-all-tests] vitest exceeded ${suiteTimeoutSeconds}s wall-clock timeout and was killed.`);
  }
}

let playwright = null;
let pwDuration = '0.0';
if (runPlaywright) {
  const pwStdio = quietMode ? ['inherit', 'pipe', 'pipe'] : 'inherit';
  const pwTmp = resolve('.playwright-tmp');
  const pwBrowsers = resolve('.playwright-browsers');
  rmSync(pwTmp, { recursive: true, force: true });
  mkdirSync(pwTmp, { recursive: true });
  const pwEnv = {
    ...env,
    TEMP: pwTmp,
    TMP: pwTmp,
    TMPDIR: pwTmp,
    PLAYWRIGHT_BROWSERS_PATH: pwBrowsers,
  };
  const pwStart = Date.now();
  const playwrightArgv = ['playwright', 'test', ...playwrightFilters];
  playwright = spawnSync('npx', playwrightArgv, {
    stdio: pwStdio,
    shell: true,
    env: pwEnv,
    timeout: suiteTimeoutMs,
    killSignal: 'SIGKILL',
  });
  pwDuration = ((Date.now() - pwStart) / 1000).toFixed(1);
  if (playwright.error && playwright.error.code === 'ETIMEDOUT') {
    console.error(`[run-all-tests] playwright exceeded ${suiteTimeoutSeconds}s wall-clock timeout and was killed.`);
  }
}

// --- Merge reports into a single combined JSON ---
const outPath = 'test-results/test-failures.json';

/** Read Vitest compact reporter JSON */
function readVitestReport() {
  if (!runVitest) return null;
  try {
    return JSON.parse(readFileSync('.vitest-failures.json', 'utf8'));
  } catch { return null; }
}

/** Parse Playwright's built-in JSON reporter output into our format */
function readPlaywrightReport() {
  if (!runPlaywright) return null;
  try {
    const raw = JSON.parse(readFileSync('test-results/playwright-failures.json', 'utf8'));
    const groups = new Map();
    let passed = 0, failed = 0, skipped = 0;

    for (const suite of raw.suites ?? []) {
      collectPlaywrightSuite(suite, groups, s => {
        if (s === 'passed' || s === 'expected') passed++;
        else if (s === 'failed' || s === 'unexpected') failed++;
        else if (s === 'skipped') skipped++;
      });
    }

    return {
      summary: { passed, failed, skipped, totalFiles: raw.suites?.length ?? 0, durationSeconds: (raw.stats?.duration ?? 0) / 1000 },
      failures: [...groups.values()],
    };
  } catch { return null; }
}

function collectPlaywrightSuite(suite, groups, count) {
  for (const spec of suite.specs ?? []) {
    for (const test of spec.tests ?? []) {
      const status = test.status ?? test.expectedStatus;
      count(status);
      if (status !== 'unexpected' && status !== 'failed') continue;

      for (const result of test.results ?? []) {
        if (result.status === 'passed') continue;
        const rawMsg = result.error?.message ?? result.error?.snippet ?? 'Playwright test failed';
        const firstLine = rawMsg.split('\n')[0].trim();
        const key = firstLine.length > 200 ? firstLine.slice(0, 200) + '...' : firstLine;

        const location = {
          file: suite.file ?? spec.file ?? 'unknown',
          test: spec.title ?? 'unknown',
          line: spec.line ?? null,
          column: spec.column ?? null,
        };

        const existing = groups.get(key);
        if (existing) { existing.count++; existing.locations.push(location); }
        else groups.set(key, { message: key, count: 1, locations: [location] });
      }
    }
  }
  for (const child of suite.suites ?? []) {
    collectPlaywrightSuite(child, groups, count);
  }
}

// Build combined report
const vitestReport = readVitestReport();
const playwrightReport = readPlaywrightReport();

if (vitestReport || playwrightReport) {
  const combined = {
    summary: {
      vitest: vitestReport?.summary ?? null,
      playwright: playwrightReport?.summary ?? null,
      totalFailed: (vitestReport?.summary?.failed ?? 0) + (playwrightReport?.summary?.failed ?? 0),
      totalPassed: (vitestReport?.summary?.passed ?? 0) + (playwrightReport?.summary?.passed ?? 0),
    },
    failures: {
      vitest: vitestReport?.failures ?? [],
      playwright: playwrightReport?.failures ?? [],
    },
  };

  try {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify(combined, null, 2));
  } catch { /* best effort */ }

  if (quietMode) {
    const vf = vitestReport?.summary?.failed ?? 0;
    const vp = vitestReport?.summary?.passed ?? 0;
    const pf = playwrightReport?.summary?.failed ?? 0;
    const pp = playwrightReport?.summary?.passed ?? 0;
    const total = vf + vp + pf + pp;
    const totalFail = vf + pf;
    console.log('');
    const vt = vitestReport?.summary?.durationSeconds?.toFixed(1) ?? '?';
    const vitestPart = runVitest ? `vitest: ${vp}/${vp+vf} ${vt}s` : 'vitest: skipped';
    const pwPart = runPlaywright ? `playwright: ${pp}/${pp+pf} ${pwDuration}s` : 'playwright: skipped';
    console.log(`COMBINED: ${total - totalFail} passed, ${totalFail} failed (${vitestPart}, ${pwPart})`);
    console.log(`Details: ${outPath}`);
  }
}

const vitestStatus = vitest?.status ?? 0;
const playwrightStatus = playwright?.status ?? 0;
// Treat a timed-out (null status + ETIMEDOUT error) as failure.
const vitestFail = vitest && (vitestStatus !== 0 || vitest.error);
const playwrightFail = playwright && (playwrightStatus !== 0 || playwright.error);
process.exit(vitestFail ? (vitestStatus || 124) : (playwrightFail ? (playwrightStatus || 124) : 0));
