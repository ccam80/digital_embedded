"use strict";
const fs = require("fs");
const path = require("path");

const REPO_ROOT = process.cwd();
const ALLOWLIST_DIRS = ["ref/ngspice/", "spec/"];

const BANNED_IDENTIFIERS = [
  { id: "updateOp", pattern: /\b_updateOp\b/ },
  { id: "stampCompanion", pattern: /\b_stampCompanion\b/ },
  { id: "ctxInitMode", pattern: /\b_ctxInitMode\b/ },
  { id: "firsttime", pattern: /\b_firsttime\b/ },
  { id: "firstNrForThisStep", pattern: /\bfirstNrForThisStep\b/ },
  { id: "loadCtx-iteration", pattern: /\bloadCtx\.iteration\b/ },
  { id: "ctx-initMode", pattern: /\bctx\.initMode\b/ },
  { id: "ctx-isDcOp", pattern: /\bctx\.isDcOp\b/ },
  { id: "ctx-isTransient", pattern: /\bctx\.isTransient\b/ },
  { id: "ctx-isAc", pattern: /\bctx\.isAc\b/ },
  { id: "ctx-isTransientDcop", pattern: /\bctx\.isTransientDcop\b/ },
  { id: "statePool-analysisMode", pattern: /\bstatePool\.analysisMode\b/ },
  { id: "pool-uic", pattern: /\bpool\.uic\b/ },
  { id: "poolBackedElements", pattern: /\bpoolBackedElements\b/ },
  { id: "refreshElementRefs", pattern: /\brefreshElementRefs\b/ },
  { id: "mnaAssembler", pattern: /\bMNAAssembler\b/ },
  { id: "varactorMapping", pattern: /\bVARACTOR_MAPPING\b/ },
  { id: "derivedNgspiceSlots", pattern: /\bderivedNgspiceSlots\b/ },
  { id: "junctionCap", pattern: /\bjunctionCap\b/ },
  { id: "coupledInductorState", pattern: /\bCoupledInductorState\b/ },
  { id: "createState", pattern: /\bcreateState\b/ },
  { id: "initMode-type", pattern: /\bInitMode\b/ },
  { id: "slot-gd-junction", pattern: /\bSLOT_GD_JUNCTION\b/ },
  { id: "slot-id-junction", pattern: /\bSLOT_ID_JUNCTION\b/ },
  { id: "l1-slot-cap-geq", pattern: /\bL1_SLOT_CAP_GEQ_/ },
  { id: "l1-slot-ieq", pattern: /\bL1_SLOT_IEQ_/ },
  { id: "slot-cap-geq-gs", pattern: /\bSLOT_CAP_GEQ_GS\b/ },
  { id: "slot-cap-geq-gd", pattern: /\bSLOT_CAP_GEQ_GD\b/ },
  { id: "slot-cap-geq-db", pattern: /\bSLOT_CAP_GEQ_DB\b/ },
  { id: "slot-cap-geq-sb", pattern: /\bSLOT_CAP_GEQ_SB\b/ },
  { id: "slot-cap-geq-gb", pattern: /\bSLOT_CAP_GEQ_GB\b/ },
  { id: "slot-ieq-gs", pattern: /\bSLOT_IEQ_GS\b/ },
  { id: "slot-ieq-gd", pattern: /\bSLOT_IEQ_GD\b/ },
  { id: "slot-ieq-db", pattern: /\bSLOT_IEQ_DB\b/ },
  { id: "slot-ieq-sb", pattern: /\bSLOT_IEQ_SB\b/ },
  { id: "slot-ieq-gb", pattern: /\bSLOT_IEQ_GB\b/ },
  { id: "slot-q-gs", pattern: /\bSLOT_Q_GS\b/ },
  { id: "slot-q-gd", pattern: /\bSLOT_Q_GD\b/ },
  { id: "slot-q-gb", pattern: /\bSLOT_Q_GB\b/ },
  { id: "slot-q-db", pattern: /\bSLOT_Q_DB\b/ },
  { id: "slot-q-sb", pattern: /\bSLOT_Q_SB\b/ },
  { id: "slot-cap-geq-bare", pattern: /\bSLOT_CAP_GEQ\b/ },
  { id: "slot-cap-ieq-bare", pattern: /\bSLOT_CAP_IEQ\b/ },
  {
    id: "prevVoltage",
    pattern: /\b_prevVoltage\b/,
    scopeGlob: "src/solver/analog/digital-pin-model.ts",
  },
  {
    id: "prevCurrent",
    pattern: /\b_prevCurrent\b/,
    scopeGlob: "src/solver/analog/digital-pin-model.ts",
  },
  {
    id: "prevClockVoltage",
    pattern: /\b_prevClockVoltage\b/,
    allowlist: [
      "src/solver/analog/behavioral-flipflop.ts",
      "src/solver/analog/behavioral-sequential.ts",
      "src/solver/analog/behavioral-flipflop/d-async.ts",
      "src/solver/analog/behavioral-flipflop/jk-async.ts",
      "src/solver/analog/behavioral-flipflop/jk.ts",
      "src/solver/analog/behavioral-flipflop/rs.ts",
      "src/solver/analog/behavioral-flipflop/t.ts",
    ],
  },
  { id: "math-exp-700", pattern: /Math\.exp\(700\)/ },
  {
    id: "math-min-700",
    pattern: /Math\.min\([^)]*,\s*700\)/,
    allowlist: [
      "src/components/semiconductors/__tests__/tunnel-diode.test.ts",
    ],
  },
  { id: "vds-lower-clamp", pattern: /\(vds\s*<\s*-10\)/ },
  { id: "vds-upper-clamp", pattern: /\(vds\s*>\s*50\)/ },
  { id: "bdf1-literal", pattern: /(["'])bdf1\1/ },
  { id: "bdf2-literal", pattern: /(["'])bdf2\1/ },
  { id: "integrationMethod-auto", pattern: /integrationMethod\s*:\s*["']auto["']/ },
  { id: "bdf-hyphenated", pattern: /BDF[-_ ][12]/i },
  { id: "bdf-substring", pattern: /bdf[12]/i },
];

const EXCLUDED_DIR_NAMES = new Set(["node_modules", "dist", "ref", "spec", ".git"]);

function isExcludedDir(dirPath) {
  const rel = path.relative(REPO_ROOT, dirPath).replace(/\\/g, "/");
  const parts = rel.split("/");
  return parts.some((part) => EXCLUDED_DIR_NAMES.has(part));
}

function walkFiles(dir) {
  const results = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return results; }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!isExcludedDir(fullPath)) results.push(...walkFiles(fullPath));
    } else if (entry.isFile()) {
      results.push(fullPath);
    }
  }
  return results;
}

const SCOPE_DIRS = ["src", "scripts", "e2e"].map((d) => path.join(REPO_ROOT, d));
const EXCLUDED_FILES = new Set([
  path.resolve(REPO_ROOT, "src/solver/analog/__tests__/phase-0-identifier-audit.test.ts"),
  path.resolve(REPO_ROOT, "src/solver/analog/__tests__/phase-9-sweep.test.ts"),
  path.resolve(REPO_ROOT, "scripts/phase-9-identifier-sweep.cjs"),
]);

function collectAllFiles() {
  const files = [];
  for (const dir of SCOPE_DIRS) {
    if (fs.existsSync(dir)) files.push(...walkFiles(dir));
  }
  return files.filter((f) => !EXCLUDED_FILES.has(path.resolve(f)));
}

function toRelForward(absPath) {
  return path.relative(REPO_ROOT, absPath).replace(/\\/g, "/");
}

function isInSnapshotAllowlist(relPath) {
  return ALLOWLIST_DIRS.some((d) => relPath.startsWith(d));
}

const allFiles = collectAllFiles();
const identifiers = [];

for (const entry of BANNED_IDENTIFIERS) {
  const { id, pattern, allowlist, scopeGlob } = entry;
  let filesToScan;
  if (scopeGlob != null) {
    const absScope = path.join(REPO_ROOT, scopeGlob);
    filesToScan = allFiles.filter((f) => path.resolve(f) === path.resolve(absScope));
  } else {
    filesToScan = allFiles;
  }
  const identifierAllowlistFiles = new Set(allowlist || []);
  let hitCount = 0;
  let hitsOutsideAllowlist = 0;
  const offendingPaths = [];
  for (const filePath of filesToScan) {
    const relFile = toRelForward(filePath);
    let content;
    try { content = fs.readFileSync(filePath, "utf8"); } catch (e) { continue; }
    const lines = content.split("\n");
    let fileHits = 0;
    for (const line of lines) {
      if (pattern.test(line)) fileHits++;
    }
    if (fileHits === 0) continue;
    hitCount += fileHits;
    if (!isInSnapshotAllowlist(relFile) && !identifierAllowlistFiles.has(relFile)) {
      hitsOutsideAllowlist += fileHits;
      if (!offendingPaths.includes(relFile)) offendingPaths.push(relFile);
    }
  }
  identifiers.push({
    identifier: id,
    hitCount,
    hitsOutsideAllowlist,
    allowlist: ["ref/ngspice/", "spec/"],
    offendingPaths,
  });
}

const snapshot = {
  capturedAt: new Date().toISOString(),
  listSource: "spec/plan.md Wave 0.1.1 (read at phase start)",
  identifiers,
};

fs.writeFileSync("spec/phase-9-snapshots/identifier-sweep.json", JSON.stringify(snapshot, null, 2));
console.log("Written: spec/phase-9-snapshots/identifier-sweep.json");
console.log("Total identifiers:", identifiers.length);
const offending = identifiers.filter((i) => i.hitsOutsideAllowlist > 0);
console.log("Identifiers with offending paths:", offending.length);
if (offending.length > 0) {
  console.log("STOP - offending identifiers found:");
  for (const o of offending) {
    console.log("  id:", o.identifier, "hits:", o.hitsOutsideAllowlist, "paths:", o.offendingPaths);
  }
  process.exit(1);
}
