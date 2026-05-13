/**
 * Compact Vitest reporter that suppresses verbose source dumps.
 * Groups failures by error message and emits a structured JSON summary.
 *
 * Usage: vitest run --reporter=./scripts/vitest-compact-reporter.ts
 */
import type { Reporter, File, TaskResultPack } from 'vitest';
import { relative, dirname } from 'path';
import { writeFileSync, mkdirSync } from 'fs';

interface FailureLocation {
  file: string;
  test: string;
  line: number | null;
  column: number | null;
}

interface FailureGroup {
  message: string;
  count: number;
  locations: FailureLocation[];
}

/* ------------------------------------------------------------------ */

function extractLocation(stack: string | undefined, cwd: string): { line: number | null; column: number | null; file: string | null } {
  if (!stack) return { line: null, column: null, file: null };
  // Walk stack lines looking for first frame inside src/ or scripts/
  for (const frame of stack.split('\n')) {
    const m = frame.match(/(?:at\s+.*?\(|at\s+)(.*?):(\d+):(\d+)/);
    if (!m) continue;
    const filePath = m[1].replace(/\\/g, '/');
    if (filePath.includes('/node_modules/')) continue;
    if (filePath.includes('/src/') || filePath.includes('/scripts/') || filePath.includes('/e2e/')) {
      return { file: filePath, line: parseInt(m[2], 10), column: parseInt(m[3], 10) };
    }
  }
  return { line: null, column: null, file: null };
}

function normalizeMessage(msg: string): string {
  // Trim to first line and cap length for grouping
  const first = msg.split('\n')[0].trim();
  return first.length > 200 ? first.slice(0, 200) + '...' : first;
}

const quiet = !!process.env.VITEST_QUIET;

// When VITEST_TAG_OUTPUT=1, every line the reporter emits is prefixed with a
// sentinel so the parent runner can pass it through verbatim and drop anything
// else (e.g. ngspice DLL writes that bypass koffi's SendChar callback and land
// directly on the worker's fd 1 / fd 2). Heartbeat dots and summary lines use
// distinct prefixes so the filter knows whether to keep the trailing newline.
const tagged = !!process.env.VITEST_TAG_OUTPUT;
const HB_PREFIX = '\x01H';
const LN_PREFIX = '\x01L';

function hbWrite(ch: string): void {
  if (!ch) return;
  if (tagged) process.stdout.write(HB_PREFIX + ch + '\n');
  else process.stdout.write(ch);
}

function lnWrite(s: string = ''): void {
  if (tagged) {
    for (const line of s.split('\n')) {
      process.stdout.write(LN_PREFIX + line + '\n');
    }
  } else {
    process.stdout.write(s + '\n');
  }
}

export default class CompactReporter implements Reporter {
  private cwd = process.cwd();
  private passed = 0;
  private failed = 0;
  private skipped = 0;
  private totalFiles = 0;
  private failureGroups = new Map<string, FailureGroup>();
  private startTime = 0;

  onInit() {
    this.startTime = Date.now();
  }

  onTaskUpdate(packs: TaskResultPack[]) {
    if (!quiet) {
      for (const [, result] of packs) {
        if (!result) continue;
        if (result.state === 'pass') hbWrite('.');
        else if (result.state === 'fail') hbWrite('F');
      }
    }
  }

  onFinished(files?: File[]) {
    if (!quiet) { lnWrite(''); lnWrite(''); }

    if (!files) return;
    this.totalFiles = files.length;

    // Collect all failures
    for (const file of files) {
      this.collectFailures(file.tasks, relative(this.cwd, file.filepath));
    }

    // Count passed, failed, skipped from leaf tasks only (not suites/files)
    for (const file of files) {
      this.countLeafResults(file.tasks);
    }

    const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);

    // Always write JSON report when there are failures
    const jsonReport: { summary: object; failures: FailureGroup[] } = {
      summary: {
        passed: this.passed,
        failed: this.failed,
        skipped: this.skipped,
        totalFiles: this.totalFiles,
        durationSeconds: parseFloat(elapsed),
      },
      failures: [...this.failureGroups.values()],
    };

    const outPath = '.vitest-failures.json';
    let jsonWritten = false;
    try {
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, JSON.stringify(jsonReport, null, 2));
      jsonWritten = true;
    } catch {
      // handled below
    }

    if (quiet) {
      // Minimal output: one summary line + JSON path
      const status = this.failed > 0 ? 'FAIL' : 'PASS';
      lnWrite(`${status} ${this.passed} passed, ${this.failed} failed, ${this.skipped} skipped (${elapsed}s, ${this.totalFiles} files)`);
      if (this.failed > 0 && jsonWritten) {
        lnWrite(`Details: ${outPath}`);
      } else if (this.failed > 0) {
        lnWrite(JSON.stringify(jsonReport));
      }
      return;
    }

    // Print human-readable summary
    lnWrite(`${'='.repeat(60)}`);
    lnWrite(`  ${this.passed} passed  ${this.failed} failed  ${this.skipped} skipped  (${elapsed}s)`);
    lnWrite(`  ${this.totalFiles} test files`);
    lnWrite(`${'='.repeat(60)}`);

    if (this.failureGroups.size === 0) return;

    // Print grouped failures (human-readable)
    lnWrite('\nFailures grouped by error:\n');
    let groupIdx = 0;
    for (const [, group] of this.failureGroups) {
      groupIdx++;
      lnWrite(`  [${groupIdx}] ${group.message}  (x${group.count})`);
      for (const loc of group.locations) {
        const pos = loc.line != null ? `:${loc.line}${loc.column != null ? ':' + loc.column : ''}` : '';
        lnWrite(`      ${loc.file}${pos}  "${loc.test}"`);
      }
      lnWrite('');
    }

    if (jsonWritten) {
      lnWrite(`Structured report: ${outPath}`);
    } else if (this.failed > 0) {
      lnWrite('\n--- FAILURE_REPORT_JSON ---');
      lnWrite(JSON.stringify(jsonReport, null, 2));
      lnWrite('--- END_FAILURE_REPORT_JSON ---');
    }
  }

  private collectFailures(tasks: any[], filePath: string, parentSuiteFailed: boolean = false) {
    for (const task of tasks) {
      if (task.type === 'suite' && task.tasks) {
        const suiteFailed = task.result?.state === 'fail';
        // Suites carry beforeAll/afterAll errors on their own result.errors.
        // Without this, a thrown beforeAll renders all child it()s as "skipped"
        // and the suite-level error itself is silently dropped.
        if (suiteFailed) {
          const errors = task.result?.errors ?? [];
          for (const err of errors) {
            const rawMsg = err.message ?? err.toString?.() ?? 'Unknown suite-level error';
            const key = normalizeMessage(rawMsg);
            const loc = extractLocation(err.stack ?? err.stackStr, this.cwd);
            const location: FailureLocation = {
              file: loc.file ? relative(this.cwd, loc.file) : filePath,
              test: `[suite-setup] ${task.name ?? 'unknown'}`,
              line: loc.line,
              column: loc.column,
            };
            const existing = this.failureGroups.get(key);
            if (existing) {
              existing.count++;
              existing.locations.push(location);
            } else {
              this.failureGroups.set(key, { message: key, count: 1, locations: [location] });
            }
          }
        }
        this.collectFailures(task.tasks, filePath, suiteFailed || parentSuiteFailed);
        continue;
      }
      if (task.result?.state !== 'fail') continue;

      const errors = task.result.errors ?? [];
      for (const err of errors) {
        const rawMsg = err.message ?? err.toString?.() ?? 'Unknown error';
        const key = normalizeMessage(rawMsg);
        const loc = extractLocation(err.stack ?? err.stackStr, this.cwd);

        const location: FailureLocation = {
          file: loc.file ? relative(this.cwd, loc.file) : filePath,
          test: task.name ?? 'unknown',
          line: loc.line,
          column: loc.column,
        };

        const existing = this.failureGroups.get(key);
        if (existing) {
          existing.count++;
          existing.locations.push(location);
        } else {
          this.failureGroups.set(key, { message: key, count: 1, locations: [location] });
        }
      }
    }
  }

  private countLeafResults(tasks: any[], parentSuiteFailed: boolean = false) {
    for (const task of tasks) {
      if (task.type === 'suite' && task.tasks) {
        const suiteFailed = task.result?.state === 'fail';
        this.countLeafResults(task.tasks, suiteFailed || parentSuiteFailed);
        continue;
      }
      const state = task.result?.state;
      if (state === 'pass') this.passed++;
      else if (state === 'fail') this.failed++;
      else if (task.mode === 'skip' || state === 'skip') {
        // Children of a failed suite are marked skipped by Vitest after the
        // beforeAll throw. They didn't choose to skip — count them as failures
        // so the summary reflects the real state of the file.
        if (parentSuiteFailed) this.failed++;
        else this.skipped++;
      }
    }
  }
}
