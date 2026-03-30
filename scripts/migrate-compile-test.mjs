import { readFileSync, writeFileSync } from 'fs';

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

const f = 'src/compile/__tests__/compile.test.ts';
const content = readFileSync(f, 'utf8');
const before = (content.match(/new TestElement\(/g) || []).length;
const transformed = migrateFile(content);
const after = (transformed.match(/new TestElement\(/g) || []).length;
const replaced = (transformed.match(/createTestElementFromDecls\(/g) || []).length;
console.log(f.split('/').pop() + ': ' + before + ' -> ' + after + ' remaining, ' + replaced + ' replaced');
writeFileSync(f, transformed);
console.log('Written.');
if (after > 0) {
  const lines = transformed.split('\n');
  lines.forEach((line, idx) => {
    if (line.includes('new TestElement(')) {
      console.log('  Remaining line ' + (idx+1) + ': ' + line.trim().substring(0, 100));
    }
  });
}
