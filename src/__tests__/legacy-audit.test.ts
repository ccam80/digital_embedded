/**
 * Legacy audit tests — verify no stale references to old Java/CheerpJ architecture
 * remain in the codebase (task 11.1.1).
 *
 * Exclusions:
 *   - ref/Digital/ (Java reference submodule)
 *   - spec/phase-0-dead-code-removal.md (historical spec)
 *   - spec/progress.md (historical record)
 *   - node_modules/
 */

import { describe, expect, it } from 'vitest';
import { execSync } from 'child_process';

/**
 * Search for a pattern in src/ using grep.
 * Returns list of matching file paths (excluding known-OK locations).
 */
function searchInSrc(pattern: string): string[] {
  try {
    const result = execSync(
      `grep -rl -E "${pattern}" src/ --exclude-dir=node_modules --include="*.ts" --include="*.tsx" --include="*.js"`,
      { encoding: 'utf-8', timeout: 10000 },
    );
    return result
      .trim()
      .split('\n')
      .filter((l) => l.length > 0)
      .filter((f) => !f.includes('legacy-audit.test.ts'));
  } catch {
    // Exit code 1 = no matches (good), exit code 2 = error (also caught)
    return [];
  }
}

describe('legacy audit', () => {
  it('noStaleReferences — no CheerpJ/Digital.jar/xstream references in src/', () => {
    const terms = ['CheerpJ', 'Digital\\.jar', 'xstream', 'jdk-shim', 'xstream-shim', 'xstream-patch'];
    for (const term of terms) {
      const hits = searchInSrc(term);
      expect(hits, `Found stale reference "${term}" in: ${hits.join(', ')}`).toEqual([]);
    }
  });

  it('noStaleHtmlReferences — no old HTML file references in src/', () => {
    const terms = ['bridge\\.html', 'test-bridge\\.html', 'stack-question-template\\.txt'];
    for (const term of terms) {
      const hits = searchInSrc(term);
      expect(hits, `Found stale reference "${term}" in: ${hits.join(', ')}`).toEqual([]);
    }
  });

  it('noJavaPackageNames — no de.neemann.digital in non-comment code in src/', () => {
    // "Java reference: de.neemann.digital..." in JSDoc comments is legitimate
    // (documents porting provenance). Search for occurrences outside comments.
    // grep for lines matching the pattern but NOT starting with * or // (comment lines)
    try {
      const result = execSync(
        'grep -rn -E "de\\.neemann\\.digital" src/ --include="*.ts" --include="*.tsx" --include="*.js" --exclude-dir=node_modules',
        { encoding: 'utf-8', timeout: 10000 },
      );
      const lines = result.trim().split('\n').filter((l) => l.length > 0);
      // Filter out comment lines (JSDoc `* ...` or `// ...`) and this test file
      const nonCommentLines = lines.filter((line) => {
        if (line.includes('legacy-audit.test.ts')) return false;
        // Extract the code portion after file:line:
        const codeStart = line.indexOf(':', line.indexOf(':') + 1) + 1;
        const code = line.slice(codeStart).trim();
        // Comment patterns: starts with *, //, or is inside /** */
        if (code.startsWith('*') || code.startsWith('//') || code.startsWith('/**')) return false;
        // "Ported from de.neemann..." in line comments
        if (code.includes('// ') && code.indexOf('de.neemann') > code.indexOf('//')) return false;
        return true;
      });
      expect(nonCommentLines, `Found Java package in code:\n${nonCommentLines.join('\n')}`).toEqual([]);
    } catch {
      // No matches — pass
    }
  });

  it('noJavaClassReferences — no Launcher.java/JVM.java references in src/', () => {
    const terms = ['Launcher\\.java', 'JVM\\.java'];
    for (const term of terms) {
      const hits = searchInSrc(term);
      expect(hits, `Found stale reference "${term}" in: ${hits.join(', ')}`).toEqual([]);
    }
  });
});
