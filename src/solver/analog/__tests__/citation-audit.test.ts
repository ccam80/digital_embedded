import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync } from "fs";
import { resolve, join, relative } from "path";

const repoRoot = resolve(__dirname, "../../../../");
const jsonPath = join(repoRoot, "spec", "ngspice-citation-audit.json");
const mdPath = join(repoRoot, "spec", "ngspice-citation-audit.md");

interface InventoryRow {
  id: string;
  sourceFile: string;
  sourceLine: number;
  ngspiceRef: string;
  ngspicePath: string;
  claim: string;
  claimKeyword: string;
  status: string;
  notes: string;
}

interface Inventory {
  schemaVersion: number;
  generatedAt: string;
  statusDefinitions: Record<string, string>;
  rows: InventoryRow[];
}

function loadInventory(): Inventory {
  const raw = readFileSync(jsonPath, "utf8");
  return JSON.parse(raw) as Inventory;
}

function walkTs(dir: string, files: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === "dist") continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) walkTs(full, files);
    else if (e.name.endsWith(".ts")) files.push(full);
  }
  return files;
}

describe("InventoryStructure", () => {
  it("schemaLoads", () => {
    expect(existsSync(jsonPath), `${jsonPath} must exist`).toBe(true);
    const inv = loadInventory();
    expect(inv).toHaveProperty("schemaVersion");
    expect(inv).toHaveProperty("generatedAt");
    expect(inv).toHaveProperty("statusDefinitions");
    expect(inv).toHaveProperty("rows");
    expect(typeof inv.schemaVersion).toBe("number");
    expect(Array.isArray(inv.rows)).toBe(true);
  });

  it("markdownCompanionExists", () => {
    expect(existsSync(mdPath), `${mdPath} must exist`).toBe(true);
    const content = readFileSync(mdPath, "utf8");
    expect(content).toContain("Status definitions");
    expect(content).toContain("Inventory");
    expect(content).toContain("Priority corrections");
    expect(content).toContain("Maintenance protocol");
  });

  it("rowFieldsPresent", () => {
    const inv = loadInventory();
    for (const row of inv.rows) {
      expect(typeof row.id, `id must be string in row ${row.id}`).toBe("string");
      expect(row.id.length, `id must be non-empty in row ${row.id}`).toBeGreaterThan(0);
      expect(typeof row.sourceFile, `sourceFile must be string in row ${row.id}`).toBe("string");
      expect(row.sourceFile.length, `sourceFile must be non-empty in row ${row.id}`).toBeGreaterThan(0);
      expect(typeof row.ngspiceRef, `ngspiceRef must be string in row ${row.id}`).toBe("string");
      expect(row.ngspiceRef.length, `ngspiceRef must be non-empty in row ${row.id}`).toBeGreaterThan(0);
      expect(typeof row.claim, `claim must be string in row ${row.id}`).toBe("string");
      expect(row.claim.length, `claim must be non-empty in row ${row.id}`).toBeGreaterThan(0);
      expect(typeof row.status, `status must be string in row ${row.id}`).toBe("string");
      expect(row.status.length, `status must be non-empty in row ${row.id}`).toBeGreaterThan(0);
      expect(typeof row.sourceLine, `sourceLine must be number in row ${row.id}`).toBe("number");
      expect(Number.isInteger(row.sourceLine), `sourceLine must be integer in row ${row.id}`).toBe(true);
      expect(row.sourceLine, `sourceLine must be >= 1 in row ${row.id}`).toBeGreaterThanOrEqual(1);
    }
  });

  it("statusEnumValid", () => {
    const inv = loadInventory();
    const validStatuses = new Set(Object.keys(inv.statusDefinitions));
    for (const row of inv.rows) {
      expect(
        validStatuses.has(row.status),
        `Row ${row.id} has invalid status "${row.status}"; valid: ${[...validStatuses].join(", ")}`
      ).toBe(true);
    }
  });

  it("staleRowsHaveCorrection", () => {
    const inv = loadInventory();
    const correctionRe = /[a-zA-Z_0-9]+\.(c|h):\d+(-\d+)?/;
    for (const row of inv.rows) {
      if (row.status === "stale") {
        expect(
          row.notes.length,
          `Stale row ${row.id} must have non-empty notes`
        ).toBeGreaterThan(0);
        expect(
          correctionRe.test(row.notes),
          `Stale row ${row.id} notes must contain a citation regex match; got: "${row.notes}"`
        ).toBe(true);
      }
    }
  });

  it("verifiedRowsResolve", () => {
    const inv = loadInventory();
    for (const row of inv.rows) {
      if (row.status === "verified") {
        const absPath = join(repoRoot, row.ngspicePath);
        expect(
          existsSync(absPath),
          `Verified row ${row.id}: ngspicePath "${row.ngspicePath}" must exist`
        ).toBe(true);
        expect(
          row.claimKeyword.length,
          `Verified row ${row.id}: claimKeyword must be non-empty (verified rows must record evidence per spec/phase-8 Task 8.1.1)`
        ).toBeGreaterThan(0);
        const fileContent = readFileSync(absPath, "utf8");
        const fileLines = fileContent.split("\n");
        const rangeMatch = row.ngspiceRef.match(/:(\d+)(?:-(\d+))?$/);
        let rangeText: string;
        if (rangeMatch) {
          const startLine = parseInt(rangeMatch[1], 10);
          const endLine = rangeMatch[2] ? parseInt(rangeMatch[2], 10) : startLine;
          expect(
            startLine,
            `Verified row ${row.id}: start line ${startLine} must be within file length ${fileLines.length}`
          ).toBeLessThanOrEqual(fileLines.length);
          expect(
            endLine,
            `Verified row ${row.id}: end line ${endLine} must be within file length ${fileLines.length}`
          ).toBeLessThanOrEqual(fileLines.length);
          rangeText = fileLines.slice(startLine - 1, endLine).join("\n");
        } else {
          rangeText = fileContent;
        }
        expect(
          rangeText,
          `Verified row ${row.id}: claimKeyword "${row.claimKeyword}" must appear in ${rangeMatch ? "cited range" : "cited file"}`
        ).toContain(row.claimKeyword);
      }
    }
  });

  it("idsUnique", () => {
    const inv = loadInventory();
    const seen = new Set<string>();
    for (const row of inv.rows) {
      expect(
        seen.has(row.id),
        `Duplicate id found: "${row.id}"`
      ).toBe(false);
      seen.add(row.id);
    }
  });

  it("everyCitationCovered", () => {
    const inv = loadInventory();
    const srcDir = join(repoRoot, "src");
    const tsFiles = walkTs(srcDir);
    const citationRe = /[a-zA-Z_0-9]+\.(c|h):\d+(-\d+)?/g;
    const commentLineRe = /^\s*(?:\*|\/\/|\/\*)|\s\/\/|\s\/\*/;

    // Build lookup set: "sourceFile|sourceLine|ngspiceRef"
    const covered = new Set<string>();
    for (const row of inv.rows) {
      covered.add(row.sourceFile + "|" + row.sourceLine + "|" + row.ngspiceRef);
    }

    const missing: string[] = [];
    for (const file of tsFiles) {
      const content = readFileSync(file, "utf8");
      const lines = content.split("\n");
      const relPath = relative(repoRoot, file).split("\\").join("/");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!commentLineRe.test(line)) continue;
        citationRe.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = citationRe.exec(line)) !== null) {
          const key = relPath + "|" + (i + 1) + "|" + m[0];
          if (!covered.has(key)) {
            missing.push(`${relPath}:${i + 1} ref="${m[0]}"`);
          }
        }
      }
    }

    expect(
      missing,
      `The following citations are not covered in the inventory:\n${missing.join("\n")}`
    ).toHaveLength(0);
  });
});

describe("AnalogTypesCitations", () => {
  it("allVerified", () => {
    const inv = loadInventory();
    const analogTypeRows = inv.rows.filter(
      (r) => r.sourceFile === "src/core/analog-types.ts"
    );
    expect(
      analogTypeRows.length,
      "Expected at least one inventory row for src/core/analog-types.ts"
    ).toBeGreaterThan(0);
    for (const row of analogTypeRows) {
      expect(
        row.status,
        `Row ${row.id} (${row.ngspiceRef}) must be verified but is "${row.status}"`
      ).toBe("verified");
    }
  });
});

describe("DcopCitations", () => {
  const DCOP_FILE = "src/solver/analog/dc-operating-point.ts";

  it("enumeratedCorrectionsLanded", () => {
    const inv = loadInventory();
    const dcopRows = inv.rows.filter((r) => r.sourceFile === DCOP_FILE);

    const expected: Array<[number, string]> = [
      [65,  "cktop.c:385"],
      [253, "cktncdump.c"],
      [451, "cktncdump.c"],
      [529, "cktop.c:179"],
      [701, "cktop.c:381"],
      [709, "cktop.c:406-409"],
      [718, "cktop.c:413-458"],
      [747, "cktop.c:385-387"],
      [10,  "cktop.c:369-569"],
      [683, "cktop.c:369-569"],
      [687, "cktop.c:369-569"],
    ];

    for (const [sourceLine, expectedRef] of expected) {
      const row = dcopRows.find(
        (r) => r.sourceLine === sourceLine && r.ngspiceRef === expectedRef
      );
      expect(
        row,
        `Expected dc-operating-point.ts:${sourceLine} to have ngspiceRef "${expectedRef}" but no matching row found`
      ).toBeDefined();
      expect(
        row!.status,
        `Row for dc-operating-point.ts:${sourceLine} ngspiceRef="${expectedRef}" must be verified, got "${row!.status}"`
      ).toBe("verified");
    }
  });

  it("allInventoryVerifiedOrMissing", () => {
    const inv = loadInventory();
    const dcopRows = inv.rows.filter((r) => r.sourceFile === DCOP_FILE);
    expect(
      dcopRows.length,
      "Expected at least one inventory row for dc-operating-point.ts"
    ).toBeGreaterThan(0);
    for (const row of dcopRows) {
      expect(
        ["verified", "missing"],
        `Row ${row.id} (${row.ngspiceRef} at line ${row.sourceLine}) must be verified or missing, got "${row.status}"`
      ).toContain(row.status);
    }
  });
});

describe("PlanTargetRotAbsent", () => {
  it("noStaleNiiter991", () => {
    const srcDir = join(repoRoot, "src");
    const target = "niiter.c:991-997";
    const matches: string[] = [];

    function walk(dir: string): void {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.name === "node_modules" || e.name === "dist") continue;
        const full = join(dir, e.name);
        if (e.isDirectory()) {
          walk(full);
        } else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) {
          const content = readFileSync(full, "utf8");
          if (content.includes(target)) {
            matches.push(relative(repoRoot, full).split("\\").join("/"));
          }
        }
      }
    }

    walk(srcDir);
    expect(
      matches,
      `Found stale plan-target citation "${target}" in: ${matches.join(", ")}`
    ).toHaveLength(0);
  });
});

describe("NewtonRaphsonCitations", () => {
  const NR_FILE = "src/solver/analog/newton-raphson.ts";

  it("enumeratedCorrectionsLanded", () => {
    const inv = loadInventory();
    const nrRows = inv.rows.filter((r) => r.sourceFile === NR_FILE);

    const expected: Array<[number, string]> = [
      [66,  "devsup.c:50-82"],
      [289, "niiter.c:622"],
      [514, "niiter.c:1020-1046"],
      [600, "niiter.c:1073-1075"],
    ];

    for (const [sourceLine, expectedRef] of expected) {
      const row = nrRows.find(
        (r) => r.sourceLine === sourceLine && r.ngspiceRef === expectedRef
      );
      expect(
        row,
        `Expected newton-raphson.ts:${sourceLine} to have ngspiceRef "${expectedRef}" but no matching row found`
      ).toBeDefined();
      expect(
        row!.status,
        `Row for newton-raphson.ts:${sourceLine} ngspiceRef="${expectedRef}" must be verified, got "${row!.status}"`
      ).toBe("verified");
    }
  });

  it("allInventoryVerifiedOrMissing", () => {
    const inv = loadInventory();
    const nrRows = inv.rows.filter((r) => r.sourceFile === NR_FILE);
    expect(
      nrRows.length,
      "Expected at least one inventory row for newton-raphson.ts"
    ).toBeGreaterThan(0);
    for (const row of nrRows) {
      expect(
        ["verified", "missing"],
        `Row ${row.id} (${row.ngspiceRef} at line ${row.sourceLine}) must be verified or missing, got "${row.status}"`
      ).toContain(row.status);
    }
  });
});
