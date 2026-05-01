/**
 * Live-progress setup file for diagnosing test hangs under parallel workers.
 *
 * Why a setup file rather than a reporter: in pool=forks, workers batch their
 * task updates and only flush them to the main reporter when a file finishes.
 * That means a reporter cannot see which test is currently running- only what
 * has already completed. By registering global beforeEach/afterEach hooks from
 * INSIDE the worker, we print the test name synchronously before the test body
 * runs, so a hang leaves the offending test name as the last line in the log.
 *
 * Output goes to stderr (sync) and is also appended to a file
 * (.vitest-live.log by default) so logs survive if a worker is force-killed
 * before stderr drains.
 *
 * Wire in via `setupFiles: ['./scripts/vitest-live-setup.ts']` (controlled by
 * VITEST_LIVE=1 in vitest.config.ts).
 */
import { beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { appendFileSync, openSync, writeSync, closeSync } from 'fs';
import { resolve } from 'path';

const PID = process.pid;
const LOG_PATH = resolve(process.cwd(), process.env.VITEST_LIVE_LOG ?? '.vitest-live.log');

let logFd: number | null = null;
try {
  logFd = openSync(LOG_PATH, 'a');
} catch {
  logFd = null;
}

function ts(): string {
  const d = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

function emit(line: string) {
  const full = `[${ts()}] [pid ${PID}] ${line}\n`;
  try {
    process.stderr.write(full);
  } catch {
    // ignore
  }
  if (logFd != null) {
    try {
      writeSync(logFd, full);
    } catch {
      // ignore
    }
  }
}

function fullName(task: any): string {
  const parts: string[] = [];
  let cur = task;
  while (cur) {
    if (cur.name) parts.unshift(cur.name);
    cur = cur.suite;
  }
  return parts.join(' > ');
}

function fileOf(task: any): string {
  let cur = task;
  while (cur && cur.type !== 'suite' && cur.suite) cur = cur.suite;
  while (cur && cur.suite) cur = cur.suite;
  // cur should now be the File task (top-level suite)
  const fp = (cur && (cur.filepath ?? cur.file?.filepath)) ?? task?.file?.filepath ?? '?';
  return String(fp).replace(/\\/g, '/');
}

const startedAt = new Map<string, number>();

beforeAll(() => {
  emit(`FILE_START ${fileOf((globalThis as any).__vitest_worker__?.current ?? {})}`);
});

afterAll(() => {
  emit(`FILE_END   ${fileOf((globalThis as any).__vitest_worker__?.current ?? {})}`);
});

beforeEach((ctx: { task: any }) => {
  const name = fullName(ctx.task);
  const file = fileOf(ctx.task);
  startedAt.set(ctx.task.id, Date.now());
  emit(`STARTING ${file} :: ${name}`);
});

afterEach((ctx: { task: any }) => {
  const name = fullName(ctx.task);
  const file = fileOf(ctx.task);
  const elapsed = Date.now() - (startedAt.get(ctx.task.id) ?? Date.now());
  startedAt.delete(ctx.task.id);
  const state = ctx.task.result?.state ?? '?';
  const tag = state === 'pass' ? 'PASS' : state === 'fail' ? 'FAIL' : state === 'skip' ? 'SKIP' : `END(${state})`;
  emit(`${tag}     ${file} :: ${name} (${elapsed}ms)`);
});

process.on('exit', () => {
  if (startedAt.size > 0) {
    emit(`=== ${startedAt.size} test(s) STILL_RUNNING at process exit ===`);
    for (const id of startedAt.keys()) {
      emit(`STILL_RUNNING task=${id}`);
    }
  }
  if (logFd != null) {
    try {
      closeSync(logFd);
    } catch {
      // ignore
    }
  }
});
