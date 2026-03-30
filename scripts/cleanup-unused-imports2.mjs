import { readFileSync, writeFileSync } from 'fs';

const files = [
  'src/compile/__tests__/compile-integration.test.ts',
  'src/compile/__tests__/compile-bridge-guard.test.ts',
  'src/compile/__tests__/extract-connectivity.test.ts',
  'src/compile/__tests__/stable-net-id.test.ts',
  'src/solver/digital/__tests__/bus-resolution.test.ts',
  'src/solver/digital/__tests__/compiler.test.ts',
  'src/solver/digital/__tests__/state-slots.test.ts',
  'src/solver/digital/__tests__/switch-network.test.ts',
  'src/solver/digital/__tests__/two-phase.test.ts',
  'src/solver/digital/__tests__/wiring-table.test.ts',
];

// Symbols only needed by the removed class - remove their imports
const classOnlySymbols = [
  'AbstractCircuitElement',
  'resolvePins',
  'createInverterConfig',
  'createClockConfig',
];

for (const f of files) {
  let content = readFileSync(f, 'utf8');
  const original = content;

  for (const sym of classOnlySymbols) {
    // Count non-import occurrences (strip all import lines first)
    const noImports = content.replace(/^import\b.*$/gm, '');
    const re = new RegExp('\\b' + sym + '\\b', 'g');
    const count = (noImports.match(re) || []).length;

    if (count === 0) {
      // Remove from any import line that contains it
      content = content.split('\n').map(line => {
        if (!line.startsWith('import') || !line.includes(sym)) return line;

        // Remove symbol from the braces
        const newLine = line
          .replace(new RegExp(',\\s*' + sym + '\\b'), '')
          .replace(new RegExp('\\b' + sym + '\\s*,\\s*'), '')
          .replace(new RegExp('\\b' + sym + '\\b'), '');

        // Check if braces are now empty: import { } from ...
        if (/import(?:\s+type)?\s*\{\s*\}\s*from/.test(newLine)) return null;
        // Check if import type { } (from type imports that have comma cleanup)
        if (/import\s*\{\s*\}\s*from/.test(newLine)) return null;

        return newLine;
      }).filter(line => line !== null).join('\n');
    }
  }

  if (content !== original) {
    writeFileSync(f, content);
    const removedSyms = classOnlySymbols.filter(sym => !content.includes(sym) && original.includes(sym));
    console.log(f.split('/').pop() + ': removed ' + removedSyms.join(', '));
  } else {
    console.log(f.split('/').pop() + ': no changes');
  }
}
