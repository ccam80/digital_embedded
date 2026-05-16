/**
 * Task 0.1.2: Strip dead vIH/vIL plumbing from flipflops family
 *
 * Validates exact before-text at each spec-enumerated line, then deletes
 * the matched lines. Run with --dry-run to print planned deletions without
 * writing. Aborts the whole run if any single validation fails.
 *
 * All 7 files have UTF-8 BOM (efbbbf). The script strips BOM for line-level
 * processing and writes back with BOM preserved (line endings also preserved).
 */

import { readFileSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const DRY_RUN = process.argv.includes("--dry-run");

const UTF8_BOM = "﻿";

const DELETIONS = [
  {
    file: "src/components/flipflops/d.ts",
    lines: [48, 49],
    expectedTexts: [
      "// vIH/vIL: per-instance CMOS input thresholds, consumed by the driver leaf",
      "// for clock-edge detection and D-input level classification.",
    ],
  },
  {
    file: "src/components/flipflops/d.ts",
    lines: [89, 90],
    expectedTexts: [
      '          vIH: params.getModelParam<number>("vIH"),',
      '          vIL: params.getModelParam<number>("vIL"),',
    ],
  },
  {
    file: "src/components/flipflops/d-async.ts",
    lines: [85, 86],
    expectedTexts: [
      '          vIH: params.getModelParam<number>("vIH"),',
      '          vIL: params.getModelParam<number>("vIL"),',
    ],
  },
  {
    file: "src/components/flipflops/t.ts",
    lines: [98, 99],
    expectedTexts: [
      '      vIH:         params.getModelParam<number>("vIH"),',
      '      vIL:         params.getModelParam<number>("vIL"),',
    ],
  },
  {
    file: "src/components/flipflops/jk.ts",
    lines: [87, 88],
    expectedTexts: [
      '          vIH: params.getModelParam<number>("vIH"),',
      '          vIL: params.getModelParam<number>("vIL"),',
    ],
  },
  {
    file: "src/components/flipflops/jk-async.ts",
    lines: [86, 87],
    expectedTexts: [
      '          vIH: params.getModelParam<number>("vIH"),',
      '          vIL: params.getModelParam<number>("vIL"),',
    ],
  },
  {
    file: "src/components/flipflops/rs.ts",
    lines: [87, 88],
    expectedTexts: [
      '          vIH: params.getModelParam<number>("vIH"),',
      '          vIL: params.getModelParam<number>("vIL"),',
    ],
  },
  {
    file: "src/components/flipflops/rs-async.ts",
    lines: [87, 88],
    expectedTexts: [
      '          vIH: params.getModelParam<number>("vIH"),',
      '          vIL: params.getModelParam<number>("vIL"),',
    ],
  },
];

const byFile = new Map();
for (const d of DELETIONS) {
  if (!byFile.has(d.file)) byFile.set(d.file, []);
  byFile.get(d.file).push(d);
}

let allValid = true;

for (const [filePath, entries] of byFile) {
  const absPath = resolve(ROOT, filePath);
  const raw = readFileSync(absPath, "utf8");
  const hasBOM = raw.startsWith(UTF8_BOM);
  const content = hasBOM ? raw.slice(1) : raw;
  const hasCRLF = content.includes("\r\n");
  const lines = content.split(hasCRLF ? "\r\n" : "\n");

  if (DRY_RUN) {
    console.log(`\nFILE: ${filePath} (BOM=${hasBOM}, CRLF=${hasCRLF}, lines=${lines.length})`);
  }

  for (const entry of entries) {
    for (let i = 0; i < entry.lines.length; i++) {
      const lineNum = entry.lines[i];
      const expected = entry.expectedTexts[i];
      const actual = lines[lineNum - 1];
      const actualTrimmed = actual !== undefined ? actual.trimEnd() : undefined;
      if (actualTrimmed !== expected) {
        console.error(`VALIDATION FAIL: ${filePath}:${lineNum}`);
        console.error(`  Expected: ${JSON.stringify(expected)}`);
        console.error(`  Actual:   ${JSON.stringify(actual)}`);
        allValid = false;
      } else {
        if (DRY_RUN) {
          console.log(`  DELETE line ${lineNum}: ${JSON.stringify(actual)}`);
        }
      }
    }
  }
}

if (!allValid) {
  console.error("\nABORTED: validation failed — no files written.");
  process.exit(1);
}

if (DRY_RUN) {
  console.log("\nDRY-RUN COMPLETE: all validations passed. No files written.");
  process.exit(0);
}

// Apply deletions
for (const [filePath, entries] of byFile) {
  const absPath = resolve(ROOT, filePath);
  const raw = readFileSync(absPath, "utf8");
  const hasBOM = raw.startsWith(UTF8_BOM);
  const content = hasBOM ? raw.slice(1) : raw;
  const hasCRLF = content.includes("\r\n");
  const lines = content.split(hasCRLF ? "\r\n" : "\n");

  const toDelete = new Set();
  for (const entry of entries) {
    for (const lineNum of entry.lines) {
      toDelete.add(lineNum - 1);
    }
  }

  const newLines = lines.filter((_, idx) => !toDelete.has(idx));
  const newContent = (hasBOM ? UTF8_BOM : "") + newLines.join(hasCRLF ? "\r\n" : "\n");
  writeFileSync(absPath, newContent, "utf8");
  console.log(`WRITTEN: ${filePath} (BOM=${hasBOM}, deleted ${toDelete.size} lines)`);
}

console.log("\nDONE.");
