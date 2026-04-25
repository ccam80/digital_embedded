"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const REPO_ROOT = process.cwd();
const AUDIT_PATH = path.join(REPO_ROOT, "spec/ngspice-citation-audit.json");

const audit = JSON.parse(fs.readFileSync(AUDIT_PATH, "utf8"));
const rows = audit.rows;
const populationSize = rows.length;
const sampleCount = Math.min(10, populationSize);

// Draw without replacement using crypto.randomInt
const indices = new Set();
while (indices.size < sampleCount) {
  indices.add(crypto.randomInt(0, populationSize));
}

const sampled = Array.from(indices).sort((a, b) => a - b).map((i) => rows[i]);

console.log(JSON.stringify(sampled.map((r) => ({
  inventoryRowId: r.id,
  sourceFile: r.sourceFile,
  sourceLine: r.sourceLine,
  ngspiceRef: r.ngspiceRef,
  ngspicePath: r.ngspicePath,
  claim: r.claim,
  claimKeyword: r.claimKeyword,
  status: r.status,
})), null, 2));
