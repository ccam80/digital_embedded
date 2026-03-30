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

// Symbols that were only used by the inline TestElement class
const classOnlySymbols = [
  'AbstractCircuitElement',
  'resolvePins',
  'createInverterConfig',
  'createClockConfig',
];

// Type imports that were only for the class
const classOnlyTypeImports = [
  'RenderContext',
  'Rect',
];

function countOccurrences(content, symbol) {
  const re = new RegExp('\\b' + symbol + '\\b', 'g');
  return (content.match(re) || []).length;
}

function removeFromImport(importLine, symbolsToRemove) {
  // Extract the braces content
  const match = importLine.match(/^\s*(import(?:\s+type)?\s*\{)([^}]+)(\}\s*from\s*.+)$/);
  if (!match) return importLine;
  const prefix = match[1];
  const items = match[2];
  const suffix = match[3];

  const parts = items.split(',').map(s => s.trim()).filter(Boolean);
  const remaining = parts.filter(p => !symbolsToRemove.includes(p));
  if (remaining.length === 0) return null; // Remove entire line
  return prefix + ' ' + remaining.join(', ') + ' ' + suffix;
}

for (const f of files) {
  let content = readFileSync(f, 'utf8');
  const lines = content.split('\n');
  const newLines = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Skip import lines that only contain class-only symbols
    if (line.includes('import') && line.includes('{')) {
      // Check which class-only symbols are in this line
      const toRemove = classOnlySymbols.filter(sym => {
        if (!line.includes(sym)) return false;
        // Count total occurrences in file (excluding import lines)
        const bodyContent = content.replace(/^import.*$/gm, '');
        const bodyCount = countOccurrences(bodyContent, sym);
        return bodyCount === 0; // Only in import, not in body
      });

      const typeToRemove = classOnlyTypeImports.filter(sym => {
        if (!line.includes(sym)) return false;
        const bodyContent = content.replace(/^import.*$/gm, '');
        const bodyCount = countOccurrences(bodyContent, sym);
        return bodyCount === 0;
      });

      const allToRemove = [...toRemove, ...typeToRemove];

      if (allToRemove.length > 0) {
        const newLine = removeFromImport(line, allToRemove);
        if (newLine === null) {
          // Skip this line entirely
          continue;
        }
        newLines.push(newLine);
        continue;
      }
    }

    newLines.push(line);
  }

  const newContent = newLines.join('\n');
  if (newContent !== content) {
    writeFileSync(f, newContent);
    console.log(f.split('/').pop() + ': cleaned up unused imports');
  } else {
    console.log(f.split('/').pop() + ': no changes needed');
  }
}
