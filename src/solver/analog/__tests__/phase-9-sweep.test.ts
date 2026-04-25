/**
 * Phase 9 sweep tests.
 *
 * Three describe blocks covering the three Phase 9 tasks:
 *   IdentifierSweep  — validates the phase-9-identifier-sweep.json snapshot (task 9.1.1)
 *   CitationSample   — validates the phase-9-citation-sample.json snapshot (task 9.1.2)
 *   FullSuiteBaseline — validates the phase-9-full-suite-baseline.json snapshot (task 9.1.3)
 *
 * All tests are artifact-hygiene checks. They assert that the snapshot files
 * exist, are well-formed, and are internally consistent. They do NOT re-run
 * the underlying grep/verification/test work.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it, expect } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "../../../../");

function readJson(relPath: string): unknown {
  const absPath = path.join(REPO_ROOT, relPath);
  const raw = fs.readFileSync(absPath, "utf8");
  return JSON.parse(raw);
}

function fileExists(relPath: string): boolean {
  return fs.existsSync(path.join(REPO_ROOT, relPath));
}

// ---------------------------------------------------------------------------
// Task 9.1.1 — Identifier Sweep
// ---------------------------------------------------------------------------

describe("IdentifierSweep", () => {
  it("snapshotExists", () => {
    expect(
      fileExists("spec/phase-9-snapshots/identifier-sweep.json"),
      "spec/phase-9-snapshots/identifier-sweep.json must exist"
    ).toBe(true);

    const data = readJson("spec/phase-9-snapshots/identifier-sweep.json") as Record<string, unknown>;

    expect(typeof data.capturedAt, "capturedAt must be a string").toBe("string");
    expect(typeof data.listSource, "listSource must be a string").toBe("string");
    expect(
      (data.listSource as string),
      "listSource must equal the canonical value"
    ).toBe("spec/plan.md Wave 0.1.1 (read at phase start)");
    expect(Array.isArray(data.identifiers), "identifiers must be an array").toBe(true);

    const identifiers = data.identifiers as Array<Record<string, unknown>>;
    expect(identifiers.length, "identifiers must be non-empty").toBeGreaterThan(0);

    for (const entry of identifiers) {
      expect(typeof entry.identifier).toBe("string");
      expect(typeof entry.hitCount).toBe("number");
      expect(typeof entry.hitsOutsideAllowlist).toBe("number");
      expect(Array.isArray(entry.allowlist)).toBe(true);
      expect(Array.isArray(entry.offendingPaths)).toBe(true);
    }
  });

  it("allZeroOffendingPaths", () => {
    const data = readJson("spec/phase-9-snapshots/identifier-sweep.json") as Record<string, unknown>;
    const identifiers = data.identifiers as Array<Record<string, unknown>>;

    const nonZero = identifiers.filter(
      (e) => (e.hitsOutsideAllowlist as number) !== 0
    );

    expect(
      nonZero.length,
      `Expected all identifiers to have hitsOutsideAllowlist === 0, but found non-zero: ${JSON.stringify(nonZero.map((e) => e.identifier))}`
    ).toBe(0);

    for (const entry of identifiers) {
      expect(
        (entry.offendingPaths as unknown[]).length,
        `offendingPaths must be empty for identifier: ${entry.identifier}`
      ).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Task 9.1.2 — Citation Sample
// ---------------------------------------------------------------------------

describe("CitationSample", () => {
  it("snapshotExists", () => {
    expect(
      fileExists("spec/phase-9-snapshots/citation-sample.json"),
      "spec/phase-9-snapshots/citation-sample.json must exist"
    ).toBe(true);

    const data = readJson("spec/phase-9-snapshots/citation-sample.json");
    expect(typeof data).toBe("object");
    expect(data).not.toBeNull();
  });

  it("schemaShape", () => {
    const data = readJson("spec/phase-9-snapshots/citation-sample.json") as Record<string, unknown>;

    expect(typeof data.capturedAt).toBe("string");
    expect(typeof data.populationSize).toBe("number");
    expect(typeof data.sampleSize).toBe("number");
    expect(Array.isArray(data.samples)).toBe(true);
    expect(Array.isArray(data.expansions)).toBe(true);

    const samples = data.samples as Array<Record<string, unknown>>;
    for (const s of samples) {
      expect(typeof s.inventoryRowId, `inventoryRowId must be string in ${JSON.stringify(s)}`).toBe("string");
      expect((s.inventoryRowId as string).length, "inventoryRowId must be non-empty").toBeGreaterThan(0);
      expect(typeof s.sourceFile).toBe("string");
      expect(typeof s.sourceLine).toBe("number");
      expect(typeof s.ngspiceRef).toBe("string");
      expect(typeof s.verificationResult).toBe("string");
      expect(typeof s.matchType).toBe("string");
      expect(typeof s.notes).toBe("string");
      expect((s.notes as string).length, "notes must be non-empty").toBeGreaterThan(0);
    }

    const expansions = data.expansions as Array<Record<string, unknown>>;
    for (const e of expansions) {
      expect(typeof e.triggeredBy).toBe("string");
      expect(typeof e.expandedFile).toBe("string");
      expect(typeof e.citationsAudited).toBe("number");
      expect(typeof e.newStaleFound).toBe("number");
      expect(typeof e.correctionsLanded).toBe("number");
    }
  });

  it("sizeIsTen", () => {
    const data = readJson("spec/phase-9-snapshots/citation-sample.json") as Record<string, unknown>;
    const sampleSize = data.sampleSize as number;
    const populationSize = data.populationSize as number;

    expect(
      sampleSize === 10 || sampleSize === populationSize,
      `sampleSize must be 10 or equal to populationSize (${populationSize}), got ${sampleSize}`
    ).toBe(true);
  });

  it("verdictEnumValid", () => {
    const data = readJson("spec/phase-9-snapshots/citation-sample.json") as Record<string, unknown>;
    const samples = data.samples as Array<Record<string, unknown>>;
    const validVerdicts = new Set(["verified", "stale"]);

    for (const s of samples) {
      expect(
        validVerdicts.has(s.verificationResult as string),
        `verificationResult must be 'verified' or 'stale', got '${s.verificationResult}' for row ${s.inventoryRowId}`
      ).toBe(true);
    }
  });

  it("staleRowsHaveCorrection", () => {
    const data = readJson("spec/phase-9-snapshots/citation-sample.json") as Record<string, unknown>;
    const samples = data.samples as Array<Record<string, unknown>>;
    const correctionPattern = /[a-zA-Z_0-9]+\.(c|h):\d+(-\d+)?/;

    for (const s of samples) {
      if (s.verificationResult === "stale") {
        expect(
          correctionPattern.test(s.notes as string),
          `stale row ${s.inventoryRowId} notes must contain a corrected citation in '<file>:<range>' form`
        ).toBe(true);
      }
    }
  });

  it("expansionsBalanced", () => {
    const data = readJson("spec/phase-9-snapshots/citation-sample.json") as Record<string, unknown>;
    const expansions = data.expansions as Array<Record<string, unknown>>;

    for (const e of expansions) {
      expect(
        e.newStaleFound,
        `expansions entry for ${e.expandedFile}: newStaleFound (${e.newStaleFound}) must equal correctionsLanded (${e.correctionsLanded})`
      ).toBe(e.correctionsLanded);
    }
  });

  it("inventorySyncedForSamples", () => {
    const sampleData = readJson("spec/phase-9-snapshots/citation-sample.json") as Record<string, unknown>;
    const samples = sampleData.samples as Array<Record<string, unknown>>;

    const inventoryData = readJson("spec/ngspice-citation-audit.json") as Record<string, unknown>;
    const rows = inventoryData.rows as Array<Record<string, unknown>>;
    const rowById = new Map<string, Record<string, unknown>>();
    for (const row of rows) {
      rowById.set(row.id as string, row);
    }

    for (const s of samples) {
      const rowId = s.inventoryRowId as string;
      const row = rowById.get(rowId);
      expect(row, `inventory row ${rowId} must exist in spec/ngspice-citation-audit.json`).toBeDefined();
      expect(
        row!.status,
        `inventory row ${rowId} status must match snapshot verificationResult ('${s.verificationResult}')`
      ).toBe(s.verificationResult);
    }
  });
});

// ---------------------------------------------------------------------------
// Task 9.1.3 — Full Suite Baseline
// ---------------------------------------------------------------------------

describe("FullSuiteBaseline", () => {
  it("snapshotExists", () => {
    const snapshotPath = "spec/phase-9-snapshots/full-suite-baseline.json";

    if (!fileExists(snapshotPath)) {
      throw new Error(
        `${snapshotPath} does not exist. ` +
          "This is the baseline-missing signal: the snapshot has not yet been captured. " +
          "Run 'npm test' once and edit the placeholder per phase-9-legacy-reference-review.md."
      );
    }

    const data = readJson(snapshotPath) as Record<string, unknown>;
    expect(typeof data.capturedAt).toBe("string");
    expect(typeof data.command).toBe("string");
    expect(typeof data.nodeVersion).toBe("string");
    expect(typeof data.exitCode).toBe("number");
    expect(typeof data.totals).toBe("object");
    expect(Array.isArray(data.failures)).toBe(true);
  });

  it("schemaFields", () => {
    const snapshotPath = "spec/phase-9-snapshots/full-suite-baseline.json";

    if (!fileExists(snapshotPath)) {
      throw new Error(
        `${snapshotPath} does not exist — baseline not yet captured. ` +
          "Run 'npm test' and write the snapshot before this test can pass."
      );
    }

    const data = readJson(snapshotPath) as Record<string, unknown>;

    expect(data.command, "command must not be null/empty").toBeTruthy();
    expect(typeof data.exitCode, "exitCode must be a number").toBe("number");

    const totals = data.totals as Record<string, unknown>;
    expect(totals, "totals must not be null").not.toBeNull();
    expect(typeof totals.tests).toBe("number");
    expect(typeof totals.passed).toBe("number");
    expect(typeof totals.failed).toBe("number");
    expect(typeof totals.skipped).toBe("number");
    expect(typeof totals.durationMs).toBe("number");

    const failures = data.failures as Array<Record<string, unknown>>;
    for (const f of failures) {
      expect(typeof f.suite).toBe("string");
      expect(typeof f.testPath).toBe("string");
      expect(typeof f.errorMessage).toBe("string");
      expect(typeof f.stackSummary).toBe("string");
    }
  });
});
