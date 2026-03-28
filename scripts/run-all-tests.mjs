/**
 * Run both Vitest and Playwright test suites sequentially.
 * Always runs both even if the first fails. Exits non-zero if either fails.
 *
 * Flags:
 *   -q / --quiet   Minimal output (summary line + JSON path). Sets VITEST_QUIET=1.
 */
import { spawnSync } from 'child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';

const args = process.argv.slice(2);
const quietMode = args.includes('-q') || args.includes('--quiet');

const env = { ...process.env };
if (quietMode) env.VITEST_QUIET = '1';

const vitest = spawnSync('npx', ['vitest', 'run'], { stdio: 'inherit', shell: true, env });
// In quiet mode, suppress Playwright's stdout (JSON reporter still writes to file)
const pwStdio = quietMode ? ['inherit', 'pipe', 'pipe'] : 'inherit';
const pwStart = Date.now();
const playwright = spawnSync('npx', ['playwright', 'test'], { stdio: pwStdio, shell: true, env });
const pwDuration = ((Date.now() - pwStart) / 1000).toFixed(1);

// --- Merge reports into a single combined JSON ---
const outPath = 'test-results/test-failures.json';

/** Read Vitest compact reporter JSON */
function readVitestReport() {
  try {
    return JSON.parse(readFileSync('.vitest-failures.json', 'utf8'));
  } catch { return null; }
}

/** Parse Playwright's built-in JSON reporter output into our format */
function readPlaywrightReport() {
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
    console.log(`COMBINED: ${total - totalFail} passed, ${totalFail} failed (vitest: ${vp}/${vp+vf} ${vt}s, playwright: ${pp}/${pp+pf} ${pwDuration}s)`);
    console.log(`Details: ${outPath}`);
  }
}

process.exit(vitest.status || playwright.status);
