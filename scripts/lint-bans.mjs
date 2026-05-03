#!/usr/bin/env node
// Banned-pattern linter for digiTS Wave-1 remediation.
// Reads either staged TS/JS files (default) or the whole tracked tree (--all).
// Emits file:line:rule:evidence on every match. Exit 0 if clean, 1 if any blocking
// violation found. Vocab rule is warn-only unless --strict-vocab is passed.
//
// See spec/REMEDIATION_PLAN.md Stage 0 for the rule design rationale.

import { execSync } from "node:child_process";
import { readFileSync, existsSync, statSync } from "node:fs";

const MODE_ALL = process.argv.includes("--all");
const STRICT_VOCAB = process.argv.includes("--strict-vocab");

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

const TRACKED_EXT = /\.(ts|tsx|mjs|cjs|js)$/;

function shellList(cmd) {
  try {
    return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  } catch (err) {
    process.stderr.write(`[lint-bans] git command failed: ${cmd}\n${err.message}\n`);
    process.exit(2);
  }
}

function stagedFiles() {
  return shellList("git diff --cached --name-only --diff-filter=ACMR")
    .filter((p) => TRACKED_EXT.test(p));
}

function allFiles() {
  return shellList('git ls-files "*.ts" "*.tsx" "*.mjs" "*.cjs" "*.js"');
}

const files = (MODE_ALL ? allFiles() : stagedFiles()).filter((p) => {
  if (!existsSync(p)) return false;
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
});

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------
//
// Each rule:
//   id       - short label printed in output
//   desc     - one-line description
//   severity - "block" | "warn"
//   pattern  - RegExp executed line-by-line (use 'g' flag where you want all hits)
//   applies  - (path) => boolean filter; default: all files
//   exclude  - optional regex against file path to skip
//   refine   - optional (line) => boolean to confirm a candidate match (for cheap context awareness)
// ---------------------------------------------------------------------------

// Files that legitimately enumerate the banned patterns themselves (rule
// descriptions, comments, etc.). Used by B1/B4/B5 excludes; B3 also needs
// the script exclude inline (see below) so its existing exclude regex stays
// readable.
const SELF_EXCLUDE = /(^|\/)(scripts\/lint-bans\.mjs|spec\/REMEDIATION_PLAN\.md|spec\/reviews\/)/;

const RULES = [
  {
    id: "B1-private-tunneling",
    desc: "(x as any)._private field tunneling — ss0 hard rule #2",
    severity: "block",
    pattern: /\bas\s+any\s*\)\s*\._\w+/,
    exclude: SELF_EXCLUDE,
  },
  {
    id: "B2-new-MNAEngine-in-tests",
    desc: "new MNAEngine(...) banned in tests — UC-1",
    severity: "block",
    pattern: /\bnew\s+MNAEngine\s*\(/,
    applies: (p) => /(__tests__|\.spec\.ts$|\.test\.ts$)/.test(p),
  },
  {
    id: "B3-accept-call",
    desc: "accept() vtable slot deleted — ss0 hard rule #6",
    severity: "block",
    // matches  el.accept(ctx)  el.accept!(ctx)  el.accept?.(ctx)  el?.accept!(ctx)
    pattern: /\.\baccept\s*[!?]?\s*\.?\(\s*[A-Za-z_]/,
    // crude exclusion: MNA-internal files where accept may legitimately exist on
    // a different vtable, plus this script (whose rule comments contain the pattern).
    exclude: /(^|\/)(src\/solver\/analog\/mna\/|src\/types\/dom-shim|scripts\/lint-bans\.mjs)/,
  },
  {
    id: "B4-schema-indexOf-as-fn",
    desc: "*_SCHEMA.indexOf(...) is a TypeError — schema is ReadonlyMap",
    severity: "block",
    pattern: /\b\w*_SCHEMA\.indexOf\s*\(/,
    exclude: SELF_EXCLUDE,
  },
  {
    id: "B5-banned-vocab-in-comment",
    desc: "historical-provenance comment ban (legacy/fallback/etc.)",
    severity: STRICT_VOCAB ? "block" : "warn",
    // line-comment OR JSDoc/star-block continuation. Catches // and  *  comments only.
    pattern: /(?:\/\/|^\s*\*\s)[^\n]*\b(legacy|fallback|workaround|temporary|previously|migrated from|backwards compatible|backwards-compatible|shim|TODO|FIXME|HACK)\b/i,
    // Don't lint this file or the remediation plan — both legitimately enumerate the words.
    exclude: /(^|\/)(scripts\/lint-bans\.mjs|spec\/REMEDIATION_PLAN\.md|spec\/reviews\/)/,
  },
  {
    id: "B6-stale-pin-key-A-or-B",
    desc: 'connection or pinNodes uses "A"/"B" — Resistor/Inductor/Crystal/Memristor were migrated to pos/neg',
    severity: "block",
    // Two shapes the wave-1 reviewers caught:
    //   1. CircuitSpec connection literal:  "<label>:A"  or  "<label>:B"
    //   2. Inline element constructor:       new Map([["A", ...], ["B", ...]])
    // Both are wrong only when the file references a migrated component. Refine via fileGuard.
    pattern: /(?:["']\w+:[AB]["']|new\s+Map\s*\(\s*\[\s*\[\s*["'][AB]["'])/,
    applies: (p) => /(__tests__|\.spec\.ts$|\.test\.ts$)/.test(p),
    fileGuard: /\b(resistor|inductor|crystal|memristor|capacitor)\b/i,
    // Refine: standard SPICE element-type prefixes (D/Q/M/J + digits) legitimately
    // use :A pins (Diode anode, BJT/MOS/JFET have their own non-A/B labels but
    // diodes commonly co-occur in fixtures with migrated components). Skip the match
    // when every :A / :B occurrence on the line carries one of those prefixes.
    refine: (line) => {
      const matches = [...line.matchAll(/["'](\w+):[AB]["']/g)];
      if (matches.length === 0) return true;          // Map-form constructor- not prefix-aware
      return !matches.every((m) => /^[DdQqMmJj]\d/.test(m[1]));
    },
  },
  {
    id: "B7-raw-SLOT-import-in-test",
    desc: "raw SLOT_* import from production state-pool file — ss0 hard rule #4 says use stateSchema.indexOf.get",
    severity: "block",
    // Multiline match: `import { ... SLOT_FOO ... } from '../bar.js'`
    pattern: /import\s*\{[\s\S]{0,400}?\bSLOT_[A-Z_][A-Z0-9_]*\b[\s\S]{0,400}?\}\s*from\s*['"][^'"]+['"]/,
    applies: (p) => /(__tests__|\.spec\.ts$|\.test\.ts$)/.test(p),
    multiline: true,
  },
];

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

let blockCount = 0;
let warnCount = 0;
const findings = [];

for (const path of files) {
  let content;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    continue;
  }
  const lines = content.split(/\r?\n/);

  for (const rule of RULES) {
    if (rule.applies && !rule.applies(path)) continue;
    if (rule.exclude && rule.exclude.test(path)) continue;
    if (rule.fileGuard && !rule.fileGuard.test(content)) continue;

    if (rule.multiline) {
      // Scan whole file content; report the line of the match start.
      const re = new RegExp(rule.pattern.source, rule.pattern.flags.includes("g") ? rule.pattern.flags : rule.pattern.flags + "g");
      let m;
      while ((m = re.exec(content)) !== null) {
        const lineNo = content.slice(0, m.index).split(/\r?\n/).length;
        const evidence = m[0].replace(/\s+/g, " ").trim().slice(0, 200);
        findings.push({
          path,
          line: lineNo,
          rule: rule.id,
          severity: rule.severity,
          desc: rule.desc,
          evidence,
        });
        if (rule.severity === "block") blockCount++;
        else warnCount++;
      }
      continue;
    }

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!rule.pattern.test(line)) continue;
      if (rule.refine && !rule.refine(line)) continue;

      findings.push({
        path,
        line: i + 1,
        rule: rule.id,
        severity: rule.severity,
        desc: rule.desc,
        evidence: line.trim().slice(0, 200),
      });
      if (rule.severity === "block") blockCount++;
      else warnCount++;
    }
  }
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

if (findings.length === 0) {
  process.stdout.write(`[lint-bans] clean — ${files.length} file(s) scanned${MODE_ALL ? " (--all)" : " (staged)"}\n`);
  process.exit(0);
}

for (const f of findings) {
  const tag = f.severity === "block" ? "BLOCK" : "warn ";
  process.stdout.write(
    `[${tag}] ${f.path}:${f.line}: ${f.rule} — ${f.desc}\n        ${f.evidence}\n`,
  );
}

process.stdout.write(
  `\n[lint-bans] ${blockCount} blocking, ${warnCount} warning across ${files.length} file(s).\n`,
);

if (blockCount > 0) {
  process.stdout.write(
    `[lint-bans] commit blocked. Fix the BLOCK lines above, or escalate to spec/architectural-alignment.md if you believe the rule is wrong.\n`,
  );
  process.exit(1);
}
process.exit(0);
