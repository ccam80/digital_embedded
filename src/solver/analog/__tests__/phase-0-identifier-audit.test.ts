/**
 * Phase 0 identifier-audit test.
 *
 * Manifest-driven vitest test that enumerates every banned identifier, walks
 * src/, scripts/, e2e/ (excluding node_modules/, dist/, ref/ngspice/, spec/,
 * .git/), and fails on any unexpected hit.
 *
 * Phase 9.1.1 re-runs this test as its final sweep tool.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

interface AllowlistEntry {
  file: string; // relative to repo root, forward slashes
  reason: string;
}

interface BannedIdentifier {
  id: string; // unique kebab-case identifier for this rule
  pattern: RegExp; // word-boundary anchored
  scopeGlob?: string; // when set, restrict the scan to this single file (relative to repo root, forward slashes)
  /**
   * Files where this identifier is expected and permitted.
   * Empty (or absent) means the identifier must be absent everywhere.
   * "test-reference-ok" entries still appear in the allowlist — the distinction
   * is communicated via the reason string.
   */
  allowlist?: ReadonlyArray<AllowlistEntry>;
  reason: string; // why banned
}

export const BANNED_IDENTIFIERS: ReadonlyArray<BannedIdentifier> = [
  // -------------------------------------------------------------------------
  // Absent everywhere — A1 transition identifiers deleted in Phase 2.5 / 0.1
  // -------------------------------------------------------------------------
  {
    id: "updateOp",
    pattern: /\b_updateOp\b/,
    reason:
      "Deleted in Phase 2.5 A1 refactor. Per-load-call update discriminant replaced by ctx.cktMode dispatch.",
  },
  {
    id: "stampCompanion",
    pattern: /\b_stampCompanion\b/,
    reason:
      "Deleted in Phase 2.5 A1 refactor. Companion stamping folded into load() directly.",
  },
  {
    id: "ctxInitMode",
    pattern: /\b_ctxInitMode\b/,
    reason:
      "Deleted in Phase 2.5 A1 refactor. Private ctx-mode cache removed.",
  },
  {
    id: "firsttime",
    pattern: /\b_firsttime\b/,
    reason:
      "Deleted in Phase 2.5 A1 refactor. First-iteration flag replaced by ctx.cktMode.",
  },
  {
    id: "firstNrForThisStep",
    pattern: /\bfirstNrForThisStep\b/,
    reason:
      "Deleted in Phase 2.5 A1 refactor. Per-step first-NR iteration flag removed.",
  },
  {
    id: "loadCtx-iteration",
    pattern: /\bloadCtx\.iteration\b/,
    reason:
      "Deleted in Phase 2.5 A1 refactor. LoadContext no longer exposes a raw iteration counter.",
  },
  {
    id: "ctx-initMode",
    pattern: /\bctx\.initMode\b/,
    reason:
      "Deleted in Phase 2.5 A1 refactor. ctx.initMode field removed from LoadContext.",
  },
  {
    id: "ctx-isDcOp",
    pattern: /\bctx\.isDcOp\b/,
    reason:
      "Deleted in Phase 2.5 A1 refactor. ctx.isDcOp field removed from LoadContext.",
  },
  {
    id: "ctx-isTransient",
    pattern: /\bctx\.isTransient\b/,
    reason:
      "Deleted in Phase 2.5 A1 refactor. ctx.isTransient field removed from LoadContext.",
  },
  {
    id: "ctx-isAc",
    pattern: /\bctx\.isAc\b/,
    reason:
      "Deleted in Phase 2.5 A1 refactor. ctx.isAc field removed from LoadContext.",
  },
  {
    id: "ctx-isTransientDcop",
    pattern: /\bctx\.isTransientDcop\b/,
    reason:
      "Deleted in Phase 2.5 A1 refactor. ctx.isTransientDcop field removed from LoadContext.",
  },
  {
    id: "statePool-analysisMode",
    pattern: /\bstatePool\.analysisMode\b/,
    reason:
      "Deleted in Phase 2.5 A1 refactor. StatePool no longer carries an analysisMode field.",
  },
  {
    id: "pool-uic",
    pattern: /\bpool\.uic\b/,
    reason:
      "Deleted in Phase 2.5 A1 refactor. pool.uic (use-initial-conditions flag) removed from StatePool.",
  },
  {
    id: "poolBackedElements",
    pattern: /\bpoolBackedElements\b/,
    reason:
      "Deleted in Phase 2.5 A1 refactor. The poolBackedElements registry was removed.",
  },
  {
    id: "refreshElementRefs",
    pattern: /\brefreshElementRefs\b/,
    reason:
      "Deleted in Phase 2.5 A1 refactor. refreshElementRefs helper removed.",
  },
  {
    id: "mnaAssembler",
    pattern: /\bMNAAssembler\b/,
    reason:
      "Deleted in Phase 2.5 refactor. MNAAssembler class replaced by direct stamp helpers.",
  },
  {
    id: "tunnelDiodeMapping",
    pattern: /\bTUNNEL_DIODE_MAPPING\b/,
    reason:
      "Deleted in Phase 0.1 (derivedNgspiceSlots cleanup). No device mapping object remains for tunnel-diode.",
  },
  {
    id: "varactorMapping",
    pattern: /\bVARACTOR_MAPPING\b/,
    reason:
      "Deleted in Phase 0.1 / 0.2. No device mapping object remains for varactor.",
  },
  {
    id: "derivedNgspiceSlots",
    pattern: /\bderivedNgspiceSlots\b/,
    reason:
      "Deleted in Phase 0.1 (Task 0.1.1). DerivedNgspiceSlot interface and DeviceMapping field removed; reader branches in ngspice-bridge, compare, and parity-helpers removed.",
  },
  {
    id: "junctionCap",
    pattern: /\bjunctionCap\b/,
    reason:
      "Deleted in Phase 2.5 MOSFET/JFET refactor. Per-element junctionCap helper removed.",
  },
  {
    id: "coupledInductorState",
    pattern: /\bCoupledInductorState\b/,
    reason:
      "Deleted in Phase 0.1 (Task 0.1.2). Historical type name stripped from coupled-inductor.ts.",
  },
  {
    id: "createState",
    pattern: /\bcreateState\b/,
    reason:
      "Deleted in Phase 0.1 (Task 0.1.2). Historical factory removed; state is initialised via initState(pool).",
  },

  // -------------------------------------------------------------------------
  // InitMode — the stand-alone type name (word-boundary catches only the
  // PascalCase form; resolvedInitMode / initMode variable names do not match)
  // -------------------------------------------------------------------------
  {
    id: "initMode-type",
    pattern: /\bInitMode\b/,
    reason:
      "Deleted type name. The string-union InitMode type was removed in Phase 2.5 A1 refactor. resolvedInitMode and initMode as variable/field names are not this type and are not matched by this word-boundary pattern.",
  },

  // -------------------------------------------------------------------------
  // Deleted SLOT_* families
  // -------------------------------------------------------------------------
  {
    id: "slot-gd-junction",
    pattern: /\bSLOT_GD_JUNCTION\b/,
    reason:
      "Deleted in Phase 2.5 MOSFET refactor. GD junction slot removed from MOSFET state schema.",
  },
  {
    id: "slot-id-junction",
    pattern: /\bSLOT_ID_JUNCTION\b/,
    reason:
      "Deleted in Phase 2.5 JFET refactor. ID junction slot removed from JFET state schema.",
  },
  {
    id: "l1-slot-cap-geq",
    pattern: /\bL1_SLOT_CAP_GEQ_/,
    reason:
      "Deleted in Phase 2.5 MOSFET L1 refactor. L1-prefixed capacitance-GEQ slot family removed.",
  },
  {
    id: "l1-slot-ieq",
    pattern: /\bL1_SLOT_IEQ_/,
    reason:
      "Deleted in Phase 2.5 MOSFET L1 refactor. L1-prefixed IEQ slot family removed.",
  },
  {
    id: "slot-cap-geq-gs",
    pattern: /\bSLOT_CAP_GEQ_GS\b/,
    reason:
      "Deleted in Phase 2.5 MOSFET refactor. Per-terminal GS capacitance GEQ slot removed.",
  },
  {
    id: "slot-cap-geq-gd",
    pattern: /\bSLOT_CAP_GEQ_GD\b/,
    reason:
      "Deleted in Phase 2.5 MOSFET refactor. Per-terminal GD capacitance GEQ slot removed.",
  },
  {
    id: "slot-cap-geq-db",
    pattern: /\bSLOT_CAP_GEQ_DB\b/,
    reason:
      "Deleted in Phase 2.5 MOSFET refactor. Per-terminal DB capacitance GEQ slot removed.",
  },
  {
    id: "slot-cap-geq-sb",
    pattern: /\bSLOT_CAP_GEQ_SB\b/,
    reason:
      "Deleted in Phase 2.5 MOSFET refactor. Per-terminal SB capacitance GEQ slot removed.",
  },
  {
    id: "slot-cap-geq-gb",
    pattern: /\bSLOT_CAP_GEQ_GB\b/,
    reason:
      "Deleted in Phase 2.5 MOSFET refactor. Per-terminal GB capacitance GEQ slot removed.",
  },
  {
    id: "slot-ieq-gs",
    pattern: /\bSLOT_IEQ_GS\b/,
    reason:
      "Deleted in Phase 2.5 MOSFET refactor. Per-terminal GS IEQ slot removed.",
  },
  {
    id: "slot-ieq-gd",
    pattern: /\bSLOT_IEQ_GD\b/,
    reason:
      "Deleted in Phase 2.5 MOSFET refactor. Per-terminal GD IEQ slot removed.",
  },
  {
    id: "slot-ieq-db",
    pattern: /\bSLOT_IEQ_DB\b/,
    reason:
      "Deleted in Phase 2.5 MOSFET refactor. Per-terminal DB IEQ slot removed.",
  },
  {
    id: "slot-ieq-sb",
    pattern: /\bSLOT_IEQ_SB\b/,
    reason:
      "Deleted in Phase 2.5 MOSFET refactor. Per-terminal SB IEQ slot removed.",
  },
  {
    id: "slot-ieq-gb",
    pattern: /\bSLOT_IEQ_GB\b/,
    reason:
      "Deleted in Phase 2.5 MOSFET refactor. Per-terminal GB IEQ slot removed.",
  },
  {
    id: "slot-q-gs",
    pattern: /\bSLOT_Q_GS\b/,
    reason:
      "Deleted in Phase 2.5 MOSFET refactor. Per-terminal GS charge slot removed.",
  },
  {
    id: "slot-q-gd",
    pattern: /\bSLOT_Q_GD\b/,
    reason:
      "Deleted in Phase 2.5 MOSFET refactor. Per-terminal GD charge slot removed.",
  },
  {
    id: "slot-q-gb",
    pattern: /\bSLOT_Q_GB\b/,
    reason:
      "Deleted in Phase 2.5 MOSFET refactor. Per-terminal GB charge slot removed.",
  },
  {
    id: "slot-q-db",
    pattern: /\bSLOT_Q_DB\b/,
    reason:
      "Deleted in Phase 2.5 MOSFET refactor. Per-terminal DB charge slot removed.",
  },
  {
    id: "slot-q-sb",
    pattern: /\bSLOT_Q_SB\b/,
    reason:
      "Deleted in Phase 2.5 MOSFET refactor. Per-terminal SB charge slot removed.",
  },

  // -------------------------------------------------------------------------
  // Bare short-form slots deleted in Phase 0.2 (tunnel-diode and LED collapse)
  // -------------------------------------------------------------------------
  {
    id: "slot-cap-geq-bare",
    pattern: /\bSLOT_CAP_GEQ\b/,
    reason:
      "Deleted in Phase 0.2 (Tasks 0.2.1 and 0.2.2). Cross-method capGeq state slot collapsed into load() local in tunnel-diode.ts and led.ts.",
  },
  {
    id: "slot-cap-ieq-bare",
    pattern: /\bSLOT_CAP_IEQ\b/,
    reason:
      "Deleted in Phase 0.2 (Tasks 0.2.1 and 0.2.2). Cross-method capIeq state slot collapsed into load() local in tunnel-diode.ts and led.ts.",
  },

  // -------------------------------------------------------------------------
  // _prevVoltage / _prevCurrent — scoped to digital-pin-model.ts only.
  // These identifiers may legitimately appear elsewhere (e.g. _prevVoltages in
  // behavioral edge-detection). The check is deliberately file-scoped so
  // broader uses are not penalised.
  // -------------------------------------------------------------------------
  {
    id: "prevVoltage",
    pattern: /\b_prevVoltage\b/,
    scopeGlob: "src/solver/analog/digital-pin-model.ts",
    reason:
      "Deleted from digital-pin-model.ts in Phase 0.2 (Task 0.2.3). Per-object integration history field replaced by AnalogCapacitorElement child. Only checked in digital-pin-model.ts; _prevVoltages (plural) elsewhere are unrelated edge-detection latches.",
  },
  {
    id: "prevCurrent",
    pattern: /\b_prevCurrent\b/,
    scopeGlob: "src/solver/analog/digital-pin-model.ts",
    reason:
      "Deleted from digital-pin-model.ts in Phase 0.2 (Task 0.2.3). Per-object integration history field replaced by AnalogCapacitorElement child. Only checked in digital-pin-model.ts.",
  },

  // -------------------------------------------------------------------------
  // _prevClockVoltage — allowlisted in edge-detection files
  // -------------------------------------------------------------------------
  {
    id: "prevClockVoltage",
    pattern: /\b_prevClockVoltage\b/,
    allowlist: [
      {
        file: "src/solver/analog/behavioral-flipflop.ts",
        reason:
          "edge-detection latch, not integration history; outside A1 rule scope",
      },
      {
        file: "src/solver/analog/behavioral-sequential.ts",
        reason:
          "edge-detection latch, not integration history; outside A1 rule scope",
      },
      {
        file: "src/solver/analog/behavioral-flipflop/d-async.ts",
        reason:
          "edge-detection latch, not integration history; outside A1 rule scope",
      },
      {
        file: "src/solver/analog/behavioral-flipflop/jk-async.ts",
        reason:
          "edge-detection latch, not integration history; outside A1 rule scope",
      },
      {
        file: "src/solver/analog/behavioral-flipflop/jk.ts",
        reason:
          "edge-detection latch, not integration history; outside A1 rule scope",
      },
      {
        file: "src/solver/analog/behavioral-flipflop/rs.ts",
        reason:
          "edge-detection latch, not integration history; outside A1 rule scope",
      },
      {
        file: "src/solver/analog/behavioral-flipflop/t.ts",
        reason:
          "edge-detection latch, not integration history; outside A1 rule scope",
      },
    ],
    reason:
      "Edge-detection latch; outside A1 rule scope. Permitted only in the listed behavioral files where rising-edge detection is implemented.",
  },

  // -------------------------------------------------------------------------
  // Math.exp(700) / Math.min(..., 700) thermal-exp clamp — absent from
  // production src/. The one test-side reference in tunnel-diode.test.ts
  // (Math.min(..., 700) at line 217) is allowlisted. Math.exp(700) is absent
  // everywhere including tests, so no allowlist entry is needed for it.
  // -------------------------------------------------------------------------
  {
    id: "math-exp-700",
    pattern: /Math\.exp\(700\)/,
    reason:
      "Banned production thermal-exp clamp Math.exp(700). Must not appear anywhere in src/, scripts/, or e2e/.",
  },
  {
    id: "math-min-700",
    pattern: /Math\.min\([^)]*,\s*700\)/,
    allowlist: [
      {
        file: "src/components/semiconductors/__tests__/tunnel-diode.test.ts",
        reason:
          "test-side reference computation, not the banned production clamp",
      },
    ],
    reason:
      "Banned production thermal-exp clamp Math.min(..., 700). Must not appear in production code; a test-side reference computation in tunnel-diode.test.ts is allowlisted.",
  },

  // -------------------------------------------------------------------------
  // Banned Vds clamp patterns
  // -------------------------------------------------------------------------
  {
    id: "vds-lower-clamp",
    pattern: /\(vds\s*<\s*-10\)/,
    reason:
      "Banned Vds lower-clamp pattern (vds < -10). Deleted in Phase 2.5 MOSFET refactor.",
  },
  {
    id: "vds-upper-clamp",
    pattern: /\(vds\s*>\s*50\)/,
    reason:
      "Banned Vds upper-clamp pattern (vds > 50). Deleted in Phase 2.5 MOSFET refactor.",
  },

  // -------------------------------------------------------------------------
  // Phase 3 Wave 3.3 — banned IntegrationMethod literals
  // -------------------------------------------------------------------------
  {
    id: "bdf1-literal",
    pattern: /(["'])bdf1\1/,
    reason:
      "Phase 3 Wave 3.3: 'bdf1' is an invented integration method; " +
      "ngspice has no BDF-1 as a selectable method (cktdefs.h:107-108). " +
      "Order 1 under either 'trapezoidal' or 'gear' uses the trap-1 " +
      "coefficients per nicomcof.c:40-41.",
  },
  {
    id: "bdf2-literal",
    pattern: /(["'])bdf2\1/,
    reason:
      "Phase 3 Wave 3.3: 'bdf2' is a digiTS rename of ngspice GEAR. " +
      "Collapsed into 'gear' per cktdefs.h:107-108 (TRAPEZOIDAL=1, " +
      "GEAR=2). Order 2 routes through solveGearVandermonde.",
  },
  {
    id: "integrationMethod-auto",
    pattern: /integrationMethod\s*:\s*["']auto["']/,
    reason:
      "Phase 3 Wave 3.3: 'auto' is never resolved to a concrete " +
      "method anywhere in the engine — a silent invention. Default " +
      "is 'trapezoidal' per cktntask.c:99.",
  },

  // -------------------------------------------------------------------------
  // Phase 3 Cleanup (C-3.4.4) — block BDF prose / identifier re-introduction
  // -------------------------------------------------------------------------
  {
    id: "bdf-hyphenated",
    pattern: /BDF[-_ ][12]/i,
    reason:
      "Phase 3 Cleanup: 'BDF-1' / 'BDF-2' (and _1 / _2 / space-1 / space-2 variants, " +
      "any case) is the banned prose name for integration methods. Order 1 under " +
      "trapezoidal or gear uses trap-1 coefficients (nicomcof.c:40-41); what was " +
      "called BDF-2 is GEAR order 2 (nicomcof.c:52-127). Use 'order-1 trap', " +
      "'backward Euler', or 'gear order 2' instead.",
  },
  {
    id: "bdf-substring",
    pattern: /bdf[12]/i,
    reason:
      "Phase 3 Cleanup: 'bdf1' / 'bdf2' (any case, any position — standalone " +
      "literal, suffix of an identifier, substring of a constant label, etc.) " +
      "is banned. Covers 'rBdf2', 'NGSPICE_REF_BDF2', 'updateCompanion_bdf1', " +
      "'BDF1'-run-together-in-prose, etc. Rename to 'order1_trap' / 'order2_gear' / " +
      "'gear2' / 'rGear2' / 'NGSPICE_REF_GEAR2' as appropriate. Note: this regex " +
      "deliberately has no word-boundary anchors — the older 3.3.6 rules use " +
      "`([\"'])bdf1\\1` which already scopes to quoted literals; this rule must " +
      "catch the identifier-embedded cases those regexes miss.",
  },
];

// ---------------------------------------------------------------------------
// Filesystem walker
// ---------------------------------------------------------------------------

const EXCLUDED_DIR_NAMES = new Set([
  "node_modules",
  "dist",
  "ref",
  "spec",
  ".git",
]);

/**
 * Returns true if the directory should be excluded from the walk.
 * "ref/ngspice" is excluded by stopping at "ref" entirely — no ngspice-
 * related files live elsewhere under ref/.
 */
function isExcludedDir(dirPath: string, repoRoot: string): boolean {
  const rel = path.relative(repoRoot, dirPath).replace(/\\/g, "/");
  const parts = rel.split("/");
  return parts.some((part) => EXCLUDED_DIR_NAMES.has(part));
}

function walkFiles(dir: string, repoRoot: string): string[] {
  const results: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!isExcludedDir(fullPath, repoRoot)) {
        results.push(...walkFiles(fullPath, repoRoot));
      }
    } else if (entry.isFile()) {
      results.push(fullPath);
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The absolute path to this test file, used to exclude it from the walk so
 * the manifest strings inside don't self-match.
 */
const THIS_FILE = path.resolve(__dirname, "phase-0-identifier-audit.test.ts");

/**
 * Repo root is three levels up from __dirname:
 *   src/solver/analog/__tests__  →  src/solver/analog  →  src/solver  →  src  →  repo-root
 */
const REPO_ROOT = path.resolve(__dirname, "../../../../");

const SCOPE_DIRS = ["src", "scripts", "e2e"].map((d) =>
  path.join(REPO_ROOT, d)
);

function collectAllFiles(): string[] {
  const files: string[] = [];
  for (const dir of SCOPE_DIRS) {
    if (fs.existsSync(dir)) {
      files.push(...walkFiles(dir, REPO_ROOT));
    }
  }
  return files.filter((f) => path.resolve(f) !== THIS_FILE);
}

function toRelForward(absPath: string): string {
  return path.relative(REPO_ROOT, absPath).replace(/\\/g, "/");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("IdentifierAudit", () => {
  it("scope_dirs_exist", () => {
    for (const dir of SCOPE_DIRS) {
      expect(
        fs.existsSync(dir),
        `Required scope directory missing: ${dir}`
      ).toBe(true);
    }
  });

  it("no_unexpected_hits", () => {
    const allFiles = collectAllFiles();

    const violations: string[] = [];

    for (const entry of BANNED_IDENTIFIERS) {
      const { pattern, reason, allowlist, scopeGlob } = entry;

      // Determine which files to scan
      let filesToScan: string[];
      if (scopeGlob != null) {
        const absScope = path.join(REPO_ROOT, scopeGlob.replace(/\//g, path.sep));
        filesToScan = allFiles.filter(
          (f) => path.resolve(f) === path.resolve(absScope)
        );
      } else {
        filesToScan = allFiles;
      }

      const allowlistFiles = new Set(allowlist?.map((a) => a.file) ?? []);

      for (const filePath of filesToScan) {
        const relFile = toRelForward(filePath);
        const content = fs.readFileSync(filePath, "utf8");
        const lines = content.split("\n");

        const hitLines: number[] = [];
        for (let i = 0; i < lines.length; i++) {
          if (pattern.test(lines[i])) {
            hitLines.push(i + 1); // 1-based
          }
        }

        if (hitLines.length === 0) continue;

        if (!allowlistFiles.has(relFile)) {
          // Unexpected hit — file not in allowlist at all
          violations.push(
            `  UNEXPECTED HIT: ${relFile}\n` +
              `    identifier: ${pattern}\n` +
              `    reason: ${reason}\n` +
              `    lines: ${hitLines.join(", ")}`
          );
        }
        // File is in allowlist — the hit is permitted; reason is documentation only.
      }
    }

    if (violations.length > 0) {
      throw new Error(
        `Banned identifier audit found ${violations.length} violation(s):\n\n` +
          violations.join("\n\n")
      );
    }
  });

  it("allowlist_is_not_stale", () => {
    const staleness: string[] = [];

    for (const entry of BANNED_IDENTIFIERS) {
      const { pattern, allowlist } = entry;
      if (!allowlist || allowlist.length === 0) continue;

      for (const allowed of allowlist) {
        const absPath = path.join(
          REPO_ROOT,
          allowed.file.replace(/\//g, path.sep)
        );

        if (!fs.existsSync(absPath)) {
          staleness.push(
            `  STALE ALLOWLIST (file missing): ${allowed.file}\n` +
              `    identifier: ${pattern}\n` +
              `    reason: ${allowed.reason}`
          );
          continue;
        }

        const content = fs.readFileSync(absPath, "utf8");
        if (!pattern.test(content)) {
          staleness.push(
            `  STALE ALLOWLIST (no match in file): ${allowed.file}\n` +
              `    identifier: ${pattern}\n` +
              `    reason: ${allowed.reason}`
          );
        }
      }
    }

    if (staleness.length > 0) {
      throw new Error(
        `Allowlist staleness detected — ${staleness.length} stale entry(ies):\n\n` +
          staleness.join("\n\n")
      );
    }
  });
});
