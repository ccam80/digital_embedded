import { readFileSync, writeFileSync } from 'fs';

const files = [
  'src/compile/__tests__/compile-integration.test.ts',
  'src/compile/__tests__/stable-net-id.test.ts',
  'src/compile/__tests__/extract-connectivity.test.ts',
  'src/compile/__tests__/compile-bridge-guard.test.ts',
  'src/compile/__tests__/pin-loading-menu.test.ts',
  'src/compile/__tests__/pin-loading-overrides.test.ts',
  'src/solver/digital/__tests__/compiler.test.ts',
  'src/solver/digital/__tests__/bus-resolution.test.ts',
  'src/solver/digital/__tests__/state-slots.test.ts',
  'src/solver/digital/__tests__/wiring-table.test.ts',
  'src/solver/digital/__tests__/two-phase.test.ts',
  'src/solver/digital/__tests__/switch-network.test.ts',
];

function parseArg(content, start) {
  let depth = 0;
  let i = start;
  let inStr = false;
  let strChar = '';

  while (i < content.length) {
    const c = content[i];
    if (inStr) {
      if (c === '\\') { i += 2; continue; }
      if (c === strChar) { inStr = false; }
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { inStr = true; strChar = c; i++; continue; }
    if (c === '(' || c === '{' || c === '[') { depth++; i++; continue; }
    if (c === ')' || c === '}' || c === ']') {
      if (depth === 0) break;
      depth--;
      i++;
      continue;
    }
    if (c === ',' && depth === 0) break;
    i++;
  }
  return [content.slice(start, i).trim(), i];
}

function skipCommaWS(content, pos) {
  let i = pos;
  if (content[i] === ',') i++;
  while (i < content.length && /[\s]/.test(content[i])) i++;
  return i;
}

function migrateFile(content) {
  let result = '';
  let i = 0;
  const marker = 'new TestElement(';

  while (i < content.length) {
    const idx = content.indexOf(marker, i);
    if (idx === -1) {
      result += content.slice(i);
      break;
    }
    result += content.slice(i, idx);

    let pos = idx + marker.length;

    const [typeArg, pos1] = parseArg(content, pos);
    const pos1a = skipCommaWS(content, pos1);

    const [idArg, pos2] = parseArg(content, pos1a);
    const pos2a = skipCommaWS(content, pos2);

    const [posArg, pos3] = parseArg(content, pos2a);
    const pos3a = skipCommaWS(content, pos3);

    const [pinsArg, pos4] = parseArg(content, pos3a);

    let propsArg = null;
    let pos5 = pos4;
    if (content[pos4] === ',') {
      const pos4a = skipCommaWS(content, pos4);
      const [p, p5] = parseArg(content, pos4a);
      propsArg = p;
      pos5 = p5;
    }

    const closePos = pos5;
    if (content[closePos] !== ')') {
      // Fallback: don't transform this occurrence
      result += marker;
      i = idx + marker.length;
      continue;
    }

    const posNorm = posArg.replace(/\s/g, '');
    const isDefaultPos = posNorm === '{x:0,y:0}';

    let replacement = 'createTestElementFromDecls(' + typeArg + ', ' + idArg + ', ' + pinsArg;
    if (propsArg !== null) {
      replacement += ', ' + propsArg;
      if (!isDefaultPos) {
        replacement += ', ' + posArg;
      }
    } else {
      if (!isDefaultPos) {
        replacement += ', undefined, ' + posArg;
      }
    }
    replacement += ')';

    result += replacement;
    i = closePos + 1;
  }

  return result;
}

for (const f of files) {
  const content = readFileSync(f, 'utf8');
  const before = (content.match(/new TestElement\(/g) || []).length;
  const transformed = migrateFile(content);
  const after = (transformed.match(/new TestElement\(/g) || []).length;
  const replaced = (transformed.match(/createTestElementFromDecls\(/g) || []).length;
  console.log(f.split('/').pop() + ': ' + before + ' -> ' + after + ' remaining, ' + replaced + ' replaced');
  if (after === 0) {
    writeFileSync(f, transformed);
    console.log('  Written.');
  } else {
    console.log('  INCOMPLETE - not written, checking...');
    // Show remaining occurrences
    const lines = transformed.split('\n');
    lines.forEach((line, idx) => {
      if (line.includes('new TestElement(')) {
        console.log('  Line ' + (idx+1) + ': ' + line.trim());
      }
    });
  }
}
