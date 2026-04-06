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
        process.stdout.write(result.state === 'pass' ? '.' : result.state === 'fail' ? 'F' : '');
      }
    }
  }

  onFinished(files?: File[]) {
    if (!quiet) process.stdout.write('\n\n');

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
      console.log(`${status} ${this.passed} passed, ${this.failed} failed, ${this.skipped} skipped (${elapsed}s, ${this.totalFiles} files)`);
      if (this.failed > 0 && jsonWritten) {
        console.log(`Details: ${outPath}`);
      } else if (this.failed > 0) {
        console.log(JSON.stringify(jsonReport));
      }
      return;
    }

    // Print human-readable summary
    console.log(`${'='.repeat(60)}`);
    console.log(`  ${this.passed} passed  ${this.failed} failed  ${this.skipped} skipped  (${elapsed}s)`);
    console.log(`  ${this.totalFiles} test files`);
    console.log(`${'='.repeat(60)}`);

    if (this.failureGroups.size === 0) return;

    // Print grouped failures (human-readable)
    console.log('\nFailures grouped by error:\n');
    let groupIdx = 0;
    for (const [, group] of this.failureGroups) {
      groupIdx++;
      console.log(`  [${groupIdx}] ${group.message}  (x${group.count})`);
      for (const loc of group.locations) {
        const pos = loc.line != null ? `:${loc.line}${loc.column != null ? ':' + loc.column : ''}` : '';
        console.log(`      ${loc.file}${pos}  "${loc.test}"`);
      }
      console.log('');
    }

    if (jsonWritten) {
      console.log(`Structured report: ${outPath}`);
    } else if (this.failed > 0) {
      console.log('\n--- FAILURE_REPORT_JSON ---');
      console.log(JSON.stringify(jsonReport, null, 2));
      console.log('--- END_FAILURE_REPORT_JSON ---');
    }
  }

  private collectFailures(tasks: any[], filePath: string) {
    for (const task of tasks) {
      if (task.type === 'suite' && task.tasks) {
        this.collectFailures(task.tasks, filePath);
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

  private countLeafResults(tasks: any[]) {
    for (const task of tasks) {
      if (task.type === 'suite' && task.tasks) {
        this.countLeafResults(task.tasks);
        continue;
      }
      const state = task.result?.state;
      if (state === 'pass') this.passed++;
      else if (state === 'fail') this.failed++;
      else if (task.mode === 'skip' || state === 'skip') this.skipped++;
    }
  }
}
