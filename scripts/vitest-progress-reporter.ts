/**
 * Hang-finder reporter. Prints `FILE_START`, `TEST_DONE`, `FILE_END`
 * events as they happen. Live-flushed.
 *
 * Usage: vitest run --reporter=./scripts/vitest-progress-reporter.ts
 *
 * The "currently running file(s)" at any moment = files that have had
 * FILE_START printed but no FILE_END printed yet. If the run hangs,
 * those files are the hang suspects.
 */
import type { Reporter, File, Task } from 'vitest';
import { relative } from 'path';

function ts(): string {
  return new Date().toISOString().slice(11, 23);
}

function rel(cwd: string, f: string): string {
  return relative(cwd, f).replace(/\\/g, '/');
}

export default class ProgressReporter implements Reporter {
  private cwd = process.cwd();
  private fileById = new Map<string, string>();      // file id -> rel path
  private startedFiles = new Set<string>();
  private endedFiles = new Set<string>();

  onPathsCollected(paths?: string[]) {
    if (paths) process.stdout.write(`[${ts()}] PATHS_COLLECTED count=${paths.length}\n`);
  }

  onCollected(files?: File[]) {
    if (!files) return;
    for (const f of files) {
      this.fileById.set(f.id, rel(this.cwd, f.filepath));
    }
  }

  onTaskUpdate(packs: any[]) {
    for (const pack of packs) {
      const id: string = pack?.[0] ?? '';
      const result = pack?.[1];
      const meta = pack?.[2];
      if (!result) continue;

      // Use the file id mapping: a top-level file task has its id matching
      // a registered fileById entry.
      let filePath = this.fileById.get(id);
      if (!filePath) {
        // Sub-task — try to derive parent file via meta.
        const f = meta?.file ?? meta?.filepath;
        if (!f) continue;
        const r = rel(this.cwd, f);
        if (result.state === 'fail' || result.state === 'pass' || result.state === 'skip') {
          // Per-test terminal — useful as a heartbeat
          // Skip noisy heartbeat for passing sub-tests; only print failures.
          if (result.state === 'fail') {
            process.stdout.write(`[${ts()}] TEST_FAIL ${r}\n`);
          }
        }
        continue;
      }

      const state = result.state;
      if (state === 'run' && !this.startedFiles.has(filePath)) {
        this.startedFiles.add(filePath);
        process.stdout.write(`[${ts()}] FILE_START ${filePath}\n`);
      } else if ((state === 'pass' || state === 'fail') && !this.endedFiles.has(filePath)) {
        this.endedFiles.add(filePath);
        process.stdout.write(`[${ts()}] FILE_END   ${filePath}  ${state.toUpperCase()}\n`);
      }
    }
  }

  onFinished(files?: File[]) {
    if (!files) return;
    // Print END for any file we missed.
    for (const f of files) {
      const r = rel(this.cwd, f.filepath);
      if (this.endedFiles.has(r)) continue;
      const failed = countFailed(f.tasks);
      process.stdout.write(`[${ts()}] FILE_END   ${r}  ${failed > 0 ? 'FAIL' : 'PASS'}\n`);
      this.endedFiles.add(r);
    }
    process.stdout.write(`[${ts()}] RUN_FINISHED files=${files.length}\n`);
  }
}

function countFailed(tasks: Task[]): number {
  let n = 0;
  for (const t of tasks as any[]) {
    if (t.type === 'suite' && t.tasks) n += countFailed(t.tasks);
    else if (t.result?.state === 'fail') n++;
  }
  return n;
}
