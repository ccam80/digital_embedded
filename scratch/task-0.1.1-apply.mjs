/**
 * Task 0.1.1 apply script — strips dead vIH/vIL plumbing from gate family.
 *
 * Reads each file, validates exact before-text at the specified line numbers,
 * then deletes/replaces lines. Aborts before writing anything if any validation fails.
 *
 * Run with: node scratch/task-0.1.1-apply.mjs [--dry-run]
 */

import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DRY_RUN = process.argv.includes("--dry-run");

function readRaw(relPath) {
  return readFileSync(path.join(ROOT, relPath), "utf8");
}

// ─── planned changes ──────────────────────────────────────────────────────────

const plan = [
  // 1. and.ts: delete line 167 (descriptor comment) + lines 220-221 (forwarding)
  {
    file: "src/components/gates/and.ts",
    ops: [
      { type: "delete", lines: [167], expected: ["// vIH/vIL: per-input CMOS thresholds, consumed by the BehavioralAndDriver leaf."] },
      { type: "delete", lines: [220, 221], expected: [
        "      vIH: params.getModelParam<number>(\"vIH\"),",
        "      vIL: params.getModelParam<number>(\"vIL\"),",
      ]},
    ],
  },
  // 2. or.ts: delete line 179 (descriptor comment) + lines 233-234 (forwarding)
  {
    file: "src/components/gates/or.ts",
    ops: [
      { type: "delete", lines: [179], expected: ["// vIH/vIL: per-input CMOS thresholds, consumed by the BehavioralOrDriver leaf."] },
      { type: "delete", lines: [233, 234], expected: [
        "      vIH: params.getModelParam<number>(\"vIH\"),",
        "      vIL: params.getModelParam<number>(\"vIL\"),",
      ]},
    ],
  },
  // 3. nand.ts: delete lines 202-203 (forwarding only)
  {
    file: "src/components/gates/nand.ts",
    ops: [
      { type: "delete", lines: [202, 203], expected: [
        "      vIH: params.getModelParam<number>(\"vIH\"),",
        "      vIL: params.getModelParam<number>(\"vIL\"),",
      ]},
    ],
  },
  // 4. nor.ts: delete lines 224-225 (forwarding only)
  {
    file: "src/components/gates/nor.ts",
    ops: [
      { type: "delete", lines: [224, 225], expected: [
        "      vIH: params.getModelParam<number>(\"vIH\"),",
        "      vIL: params.getModelParam<number>(\"vIL\"),",
      ]},
    ],
  },
  // 5. xor.ts: delete line 179 (descriptor comment) + lines 232-233 (forwarding)
  {
    file: "src/components/gates/xor.ts",
    ops: [
      { type: "delete", lines: [179], expected: ["// vIH/vIL: per-input CMOS thresholds, consumed by the BehavioralXorDriver leaf."] },
      { type: "delete", lines: [232, 233], expected: [
        "      vIH: params.getModelParam<number>(\"vIH\"),",
        "      vIL: params.getModelParam<number>(\"vIL\"),",
      ]},
    ],
  },
  // 6. xnor.ts: delete lines 235-236 (forwarding only)
  {
    file: "src/components/gates/xnor.ts",
    ops: [
      { type: "delete", lines: [235, 236], expected: [
        "      vIH: params.getModelParam<number>(\"vIH\"),",
        "      vIL: params.getModelParam<number>(\"vIL\"),",
      ]},
    ],
  },
  // 7. not.ts: delete line 235 (descriptor comment) + lines 280-281 (forwarding)
  {
    file: "src/components/gates/not.ts",
    ops: [
      { type: "delete", lines: [235], expected: ["// vIH/vIL: per-input CMOS thresholds, consumed by the BehavioralNotDriver leaf."] },
      { type: "delete", lines: [280, 281], expected: [
        "      vIH: params.getModelParam<number>(\"vIH\"),",
        "      vIL: params.getModelParam<number>(\"vIL\"),",
      ]},
    ],
  },
  // 8. buf.ts: delete lines 145-146 (forwarding only)
  {
    file: "src/components/gates/buf.ts",
    ops: [
      { type: "delete", lines: [145, 146], expected: [
        "      vIH: params.getModelParam<number>(\"vIH\"),",
        "      vIL: params.getModelParam<number>(\"vIL\"),",
      ]},
    ],
  },
  // 9. and-driver.ts: replace lines 136-140 (setParam comment scrub)
  {
    file: "src/solver/analog/behavioral-drivers/and-driver.ts",
    ops: [
      {
        type: "replace",
        startLine: 136,
        count: 5,
        expected: [
          "  setParam(_key: string, _value: number): void {",
          "    // No hot-loadable params; inputCount is structural (allocates _inputNodes)",
          "    // and is not setParam-able. vIH/vIL/vOH/vOL/rOut were removed in the",
          "    // {0, 1} normalization pass — drivers are ideal and rail-agnostic.",
          "  }",
        ],
        replacement: [
          "  setParam(_key: string, _value: number): void {",
          "    // No hot-loadable params.",
          "  }",
        ],
      },
    ],
  },
];

// ─── validate all first ───────────────────────────────────────────────────────

let allValid = true;

for (const entry of plan) {
  const raw = readRaw(entry.file);
  const lines = raw.split(/\r?\n/);

  for (const op of entry.ops) {
    if (op.type === "delete") {
      for (let i = 0; i < op.lines.length; i++) {
        const lineNum = op.lines[i];
        const expected = op.expected[i];
        const actual = lines[lineNum - 1];
        if (actual !== expected) {
          console.error(`VALIDATION FAILED: ${entry.file}:${lineNum}`);
          console.error(`  Expected: ${JSON.stringify(expected)}`);
          console.error(`  Actual:   ${JSON.stringify(actual)}`);
          allValid = false;
        } else {
          console.log(`  OK  ${entry.file}:${lineNum}: ${expected.trim()}`);
        }
      }
    } else if (op.type === "replace") {
      for (let i = 0; i < op.count; i++) {
        const lineNum = op.startLine + i;
        const expected = op.expected[i];
        const actual = lines[lineNum - 1];
        if (actual !== expected) {
          console.error(`VALIDATION FAILED: ${entry.file}:${lineNum}`);
          console.error(`  Expected: ${JSON.stringify(expected)}`);
          console.error(`  Actual:   ${JSON.stringify(actual)}`);
          allValid = false;
        } else {
          console.log(`  OK  ${entry.file}:${lineNum}: ${expected.trim()}`);
        }
      }
    }
  }
}

if (!allValid) {
  console.error("\nABORTED: validation failures above. No files written.");
  process.exit(1);
}

console.log("\nAll validations passed.");

if (DRY_RUN) {
  console.log("DRY RUN — no files written.");
  process.exit(0);
}

// ─── apply changes ────────────────────────────────────────────────────────────

for (const entry of plan) {
  const raw = readRaw(entry.file);
  const lines = raw.split(/\r?\n/);

  // Collect deletes and replacements, apply in reverse order to keep indices stable
  const deletes = [];
  const replacements = [];

  for (const op of entry.ops) {
    if (op.type === "delete") {
      deletes.push(...op.lines);
    } else if (op.type === "replace") {
      replacements.push({ startLine: op.startLine, count: op.count, replacement: op.replacement });
    }
  }

  // Apply replacements first (sorted descending by startLine)
  replacements.sort((a, b) => b.startLine - a.startLine);
  for (const rep of replacements) {
    lines.splice(rep.startLine - 1, rep.count, ...rep.replacement);
  }

  // Apply deletes (sorted descending)
  const sortedDeletes = [...deletes].sort((a, b) => b - a);
  for (const ln of sortedDeletes) {
    lines.splice(ln - 1, 1);
  }

  // Reconstruct with original line endings and trailing newline
  const crlf = raw.includes("\r\n");
  const trailingNL = raw.endsWith("\n") || raw.endsWith("\r\n");
  const joined = lines.join(crlf ? "\r\n" : "\n");
  const output = trailingNL ? joined + (crlf ? "\r\n" : "\n") : joined;

  writeFileSync(path.join(ROOT, entry.file), output, "utf8");
  console.log(`Written: ${entry.file}`);
}

console.log("\nDone.");
