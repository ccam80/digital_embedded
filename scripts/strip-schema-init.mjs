#!/usr/bin/env node
/**
 * One-shot codemod for the schema-init mechanism removal (4d).
 *
 * For every .ts file under src/, strips:
 *   1. `, init: { kind: "zero" }` (constant value: 0 default; init field deletion)
 *   2. `applyInitialValues,` from imports
 *   3. `applyInitialValues` (last-of-import — `\n  applyInitialValues,?` line)
 *   4. `applyInitialValues(...);` callsites (and surrounding indent)
 *
 * Runs as a fixed-point pass (re-runs until no more changes per file). Reports
 * which files were touched and any files containing `init: { kind: "constant"`
 * or `kind: "fromParams"` for manual review.
 */

import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join, extname } from "node:path";

const ROOT = "C:/local_working_projects/digital_in_browser/src";

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full));
    else if (st.isFile() && extname(full) === ".ts") out.push(full);
  }
  return out;
}

const files = walk(ROOT);
const touched = [];
const needsReview = [];

for (const file of files) {
  let src = readFileSync(file, "utf8");
  const before = src;

  // 1. `, init: { kind: "zero" }` → ``  (per-slot zero-init annotation)
  src = src.replace(/,\s*init:\s*\{\s*kind:\s*"zero"\s*\}/g, "");

  // 1b. `, init: { kind: "constant", value: <numeric-or-Number.NaN> }` → ``
  // (per-slot non-zero const annotations — the §4d migration moves these
  //  semantics to instance fields; load() guarded by _firstSample where
  //  load-bearing).
  src = src.replace(
    /,\s*init:\s*\{\s*kind:\s*"constant",\s*value:\s*(?:-?\d+(?:\.\d+)?|Number\.NaN|NaN)\s*\}/g,
    "",
  );

  // Stand-alone `applyInitialValues(SCHEMA, pool, base, ...);` callsites
  // (with surrounding whitespace + newline).
  src = src.replace(
    /^[ \t]*applyInitialValues\([^;]*\);\s*\n/gm,
    "",
  );

  // Import line removals — match either `applyInitialValues,` (followed by
  // newline/space) or as the only/last symbol in a multi-line import block.
  src = src.replace(/^[ \t]*applyInitialValues,?\s*\n/gm, "");

  // Single-line single-quote `import { applyInitialValues }` form, if any.
  src = src.replace(
    /import\s*\{\s*applyInitialValues\s*\}\s*from\s*"[^"]+";\s*\n/g,
    "",
  );

  // Inline `, applyInitialValues` in single-line imports.
  src = src.replace(/,\s*applyInitialValues\b/g, "");
  src = src.replace(/\bapplyInitialValues\s*,\s*/g, "");

  if (src !== before) {
    writeFileSync(file, src, "utf8");
    touched.push(file);
  }

  // Flag any remaining non-zero inits for manual review.
  if (/init:\s*\{\s*kind:\s*"(constant|fromParams)"/.test(src)) {
    needsReview.push(file);
  }
}

console.log(`Touched ${touched.length} files:`);
for (const f of touched) console.log(`  ${f.replace(/\\/g, "/")}`);

if (needsReview.length > 0) {
  console.log(`\nFiles still containing non-zero inits (need manual review):`);
  for (const f of needsReview) console.log(`  ${f.replace(/\\/g, "/")}`);
} else {
  console.log("\nNo non-zero inits remaining.");
}
