"use strict";
/**
 * Phase 9 baseline parser.
 *
 * Reads the captured npm test log from the path given as the first argument
 * (defaults to the Windows temp path used by the implementer), strips ANSI
 * escape codes, parses vitest and playwright output, then writes
 * spec/phase-9-snapshots/full-suite-baseline.json.
 *
 * Usage:
 *   node scripts/phase-9-baseline-parser.cjs <log-file-path>
 */
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const REPO_ROOT = process.cwd();
const OUT_PATH = path.join(REPO_ROOT, "spec/phase-9-snapshots/full-suite-baseline.json");

const logFile = process.argv[2] || "C:/Users/cca79/AppData/Local/Temp/npm-test-phase9.log";
const raw = fs.readFileSync(logFile, "utf8");

// Strip ANSI escape codes
const stripped = raw.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "").replace(/\x1B\][^\x07]*\x07/g, "");

// Get node version
let nodeVersion = "unknown";
try { nodeVersion = execSync("node --version", { encoding: "utf8" }).trim(); } catch (_) {}

// Get exit code from trailing "EXIT=N" line
let exitCode = -1;
const exitMatch = stripped.match(/EXIT=(\d+)\s*$/m);
if (exitMatch) exitCode = parseInt(exitMatch[1], 10);

// Parse vitest summary line: "N passed  M failed  K skipped  (Xs)"
let tests = 0, passed = 0, failed = 0, skipped = 0, durationMs = 0;
const summaryMatch = stripped.match(/(\d+)\s+passed\s+(\d+)\s+failed\s+(\d+)\s+skipped\s+\(([0-9.]+)(s|ms)\)/);
if (summaryMatch) {
  passed = parseInt(summaryMatch[1], 10);
  failed = parseInt(summaryMatch[2], 10);
  skipped = parseInt(summaryMatch[3], 10);
  tests = passed + failed + skipped;
  const dur = parseFloat(summaryMatch[4]);
  durationMs = summaryMatch[5] === "s" ? Math.round(dur * 1000) : Math.round(dur);
}

// Also try playwright-style summary: "N passed (Xs)"
if (tests === 0) {
  const pwMatch = stripped.match(/(\d+)\s+passed\s+\(([0-9.]+)(s|ms)\)/);
  if (pwMatch) {
    passed = parseInt(pwMatch[1], 10);
    const dur = parseFloat(pwMatch[2]);
    durationMs = pwMatch[3] === "s" ? Math.round(dur * 1000) : Math.round(dur);
    tests = passed;
  }
}

// Parse failures from "Failures grouped by error:" vitest block
const failures = [];
const failuresSection = stripped.match(/Failures grouped by error:([\s\S]*?)(?:\n\nStructured report:|$)/);
if (failuresSection) {
  const block = failuresSection[1];
  // Each group starts with "[N] <error message> (xN)"
  const groupPattern = /\[(\d+)\] (.*?)\s+\(x\d+\)\n\s+(.*?)\s+"([^"]+)"/g;
  let m;
  while ((m = groupPattern.exec(block)) !== null) {
    const errorMessage = m[2].trim();
    const fileLine = m[3].trim();
    const testName = m[4].trim();
    // Derive suite from file path
    const fileMatch = fileLine.match(/([^\\\/]+\.test\.[a-z]+)/);
    const suite = fileMatch ? fileMatch[1] : fileLine;
    failures.push({
      suite,
      testPath: fileLine + "::" + testName,
      errorMessage,
      stackSummary: fileLine,
    });
  }
}

// Parse playwright failures if present — look for "FAILED" lines
const pwFailPattern = /\s+\d+\) (.*?) ---([\s\S]*?)(?=\n\s+\d+\) |\n\n[A-Z]|\nFailed|$)/g;
let pwm;
while ((pwm = pwFailPattern.exec(stripped)) !== null) {
  const testTitle = pwm[1].trim();
  const body = pwm[2].trim();
  const stackLines = body.split("\n").slice(0, 20).join("\n");
  const firstLine = body.split("\n")[0].trim();
  failures.push({
    suite: "playwright",
    testPath: testTitle,
    errorMessage: firstLine,
    stackSummary: stackLines,
  });
}

const snapshot = {
  capturedAt: new Date().toISOString(),
  command: "npm test",
  nodeVersion,
  exitCode,
  totals: { tests, passed, failed, skipped, durationMs },
  failures,
};

fs.writeFileSync(OUT_PATH, JSON.stringify(snapshot, null, 2));
console.log("Written:", OUT_PATH);
console.log("exitCode:", exitCode, "passed:", passed, "failed:", failed, "skipped:", skipped);
console.log("Failures captured:", failures.length);
