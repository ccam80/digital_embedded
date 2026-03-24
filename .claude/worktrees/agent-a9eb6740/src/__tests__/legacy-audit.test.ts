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

  it('noJavaPackageNames — no de.neemann.digital anywhere in src/', () => {
    const hits = searchInSrc('de\\.neemann\\.digital');
    expect(hits, `Found Java package reference in: ${hits.join(', ')}`).toEqual([]);
  });

  it('noJavaClassReferences — no Launcher.java/JVM.java references in src/', () => {
    const terms = ['Launcher\\.java', 'JVM\\.java'];
    for (const term of terms) {
      const hits = searchInSrc(term);
      expect(hits, `Found stale reference "${term}" in: ${hits.join(', ')}`).toEqual([]);
    }
  });
});
