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
        const fileContent = readFileSync(absPath, "utf8");
        const fileLines = fileContent.split("\n");
        const rangeMatch = row.ngspiceRef.match(/:(\d+)(?:-(\d+))?$/);
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
          if (row.claimKeyword) {
            const rangeText = fileLines.slice(startLine - 1, endLine).join("\n");
            expect(
              rangeText,
              `Verified row ${row.id}: claimKeyword "${row.claimKeyword}" must appear in cited range`
            ).toContain(row.claimKeyword);
          }
        }
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
