import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

describe("Task 3.2.5 — xfact scope audit", () => {
  /**
   * Scope audit for ctx.xfact reads across src/components/ and src/solver/analog/.
   *
   * Every read of .xfact or ctx.xfact (except the one write at analog-engine.ts:447)
   * must be guarded by (ctx.cktMode & MODEINITPRED) !== 0.
   *
   * Expected reads after Phase 3.2:
   * - diode.ts: 1 read in MODEINITPRED branch
   * - bjt.ts: 2 reads in L0 MODEINITPRED branch + 3 reads in L1 MODEINITPRED branch
   *
   * All other reads (including test/harness code outside production load() methods)
   * must be in the allowlist.
   */

  const allowlistComponents: { file: string; line: number; reason: string }[] = [
    {
      file: "semiconductors\\mosfet.ts",
      line: 1496,
      reason:
        "comment inside MODEINITPRED|MODEINITTRAN guard — mentions ctx.xfact to explain why it is NOT used (mos1load.c:828 uses local xfact, computed once per call); not an actual ctx.xfact read",
    },
  ];

  const allowlistSolver: { file: string; line: number; reason: string }[] = [
    {
      file: "analog-engine.ts",
      line: 447,
      reason: "engine-side xfact write (ctx.loadCtx.xfact = deltaOld[0]/deltaOld[1]); cite: bjtload.c:279 xfact = CKTdelta/CKTdeltaOld[1]",
    },
  ];

  function isInsideMODEINITPREDGuard(fullFilePath: string, lineNum: number): boolean {
    try {
      const content = fs.readFileSync(fullFilePath, "utf-8");
      const lines = content.split("\n");
      const lineIndex = lineNum - 1;

      if (lineIndex < 0 || lineIndex >= lines.length) return false;

      // Scan backwards from this line looking for a guarding MODEINITPRED if statement
      let depth = 0;

      for (let i = lineIndex; i >= Math.max(0, lineIndex - 150); i--) {
        const line = lines[i] || "";

        // Process characters from right to left
        for (let j = line.length - 1; j >= 0; j--) {
          const ch = line[j];
          if (ch === "{") {
            depth--;
            if (depth < 0) {
              // Found the opening brace of our enclosing block
              const beforeBrace = line.substring(0, j);
              if (/\b(if|else\s+if)\s*\(.*MODEINITPRED\)/.test(beforeBrace)) {
                return true;
              }
              // Check previous line for guard
              if (i > 0) {
                const prevLine = lines[i - 1] || "";
                if (/\b(if|else\s+if)\s*\(.*MODEINITPRED\)/.test(prevLine)) {
                  return true;
                }
              }
              return false;
            }
          } else if (ch === "}") {
            depth++;
          }
        }
      }

      return false;
    } catch {
      return false;
    }
  }

  function collectXfactReads(dirPath: string): { fullPath: string; line: number }[] {
    const results: { fullPath: string; line: number }[] = [];

    function walk(dir: string) {
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);

          if (entry.isDirectory()) {
            if (!["__tests__", "node_modules", ".git"].includes(entry.name)) {
              walk(fullPath);
            }
          } else if (entry.isFile() && entry.name.endsWith(".ts")) {
            const content = fs.readFileSync(fullPath, "utf-8");
            const lines = content.split("\n");

            lines.forEach((line, index) => {
              if (
                line &&
                (/\.xfact\b|ctx\.xfact\b|ctx\.loadCtx\.xfact\b/.test(line)) &&
                !/ctx\.loadCtx\.xfact\s*=/.test(line) &&
                !/ctx\.xfact\s*=/.test(line)
              ) {
                results.push({
                  fullPath,
                  line: index + 1,
                });
              }
            });
          }
        }
      } catch {
        // Skip
      }
    }

    walk(dirPath);
    return results;
  }

  it("has zero unguarded xfact reads in src/components/", () => {
    const componentDir = path.resolve(process.cwd(), "src/components");
    if (!fs.existsSync(componentDir)) {
      expect(true).toBe(true);
      return;
    }

    const reads = collectXfactReads(componentDir);
    const unguarded = reads
      .filter((read) => !isInsideMODEINITPREDGuard(read.fullPath, read.line))
      .map((read) => {
        const relPath = path.relative(componentDir, read.fullPath);
        return `${relPath}:${read.line}`;
      });

    const violations = unguarded.filter(
      (read) => !allowlistComponents.some((a) => read.includes(`${a.file}:${a.line}`))
    );

    expect(violations, `Unguarded xfact reads:\n${violations.join("\n")}`).toEqual([]);
  });

  it("has zero unguarded xfact reads in src/solver/analog/", () => {
    const solverDir = path.resolve(process.cwd(), "src/solver/analog");
    if (!fs.existsSync(solverDir)) {
      expect(true).toBe(true);
      return;
    }

    const reads = collectXfactReads(solverDir);
    const unguarded = reads
      .filter((read) => !isInsideMODEINITPREDGuard(read.fullPath, read.line))
      .map((read) => {
        const relPath = path.relative(solverDir, read.fullPath);
        return `${relPath}:${read.line}`;
      });

    const violations = unguarded.filter(
      (read) => !allowlistSolver.some((a) => read.includes(`${a.file}:${a.line}`))
    );

    expect(violations, `Unguarded xfact reads:\n${violations.join("\n")}`).toEqual([]);
  });

  it("allowlist is exhaustive — no stale entries", () => {
    const componentDir = path.resolve(process.cwd(), "src/components");
    const solverDir = path.resolve(process.cwd(), "src/solver/analog");

    const allAllowlist = [
      ...allowlistComponents.map((a) => ({ ...a, dir: componentDir })),
      ...allowlistSolver.map((a) => ({ ...a, dir: solverDir })),
    ];

    const stale = allAllowlist.filter((entry) => {
      const filePath = path.join(entry.dir, entry.file);
      if (!fs.existsSync(filePath)) return true;
      try {
        const content = fs.readFileSync(filePath, "utf-8");
        const lines = content.split("\n");
        const lineContent = lines[entry.line - 1];
        return !lineContent || !lineContent.includes("xfact");
      } catch {
        return true;
      }
    });

    const messages = stale.map((e) => `${e.file}:${e.line}`);
    expect(messages, `Stale allowlist entries:\n${messages.join("\n")}`).toEqual([]);
  });
});
