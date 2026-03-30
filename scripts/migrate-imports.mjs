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

function removeInlineClass(content) {
  const classStart = content.indexOf('class TestElement extends AbstractCircuitElement');
  if (classStart === -1) return content;

  let depth = 0;
  let i = classStart;
  let foundOpen = false;
  while (i < content.length) {
    if (content[i] === '{') { depth++; foundOpen = true; }
    else if (content[i] === '}') {
      depth--;
      if (foundOpen && depth === 0) {
        let removeStart = classStart;
        // Remove preceding blank lines / comment lines that belong to this block
        while (removeStart > 0 && content[removeStart - 1] === '\n') removeStart--;
        let removeEnd = i + 1;
        while (removeEnd < content.length && content[removeEnd] === '\n') removeEnd++;
        return content.slice(0, removeStart) + '\n\n' + content.slice(removeEnd);
      }
    }
    i++;
  }
  return content;
}

function findLastImportEnd(content) {
  const lines = content.split('\n');
  let lastImportLine = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('import ')) lastImportLine = i;
  }
  if (lastImportLine === -1) return 0;
  let pos = 0;
  for (let i = 0; i <= lastImportLine; i++) {
    pos += lines[i].length + 1;
  }
  return pos;
}

function getFixturePrefix(filePath) {
  if (filePath.includes('solver/digital/__tests__')) return '@/test-fixtures';
  if (filePath.includes('compile/__tests__')) return '../../test-fixtures';
  if (filePath.includes('solver/__tests__')) return '../../test-fixtures';
  return '../../test-fixtures';
}

function updateImports(content, filePath) {
  const fixturePrefix = getFixturePrefix(filePath);

  // Replace noopExec/noopExecute local const/function with nothing (use fixture)
  content = content.replace(/\n\/\/ .*\n?const noopExec(?:ute|):\s*ExecuteFunction\s*=\s*\(\)\s*=>\s*\{\};\n/g, '\n');
  content = content.replace(/\nconst noopExec(?:ute|):\s*ExecuteFunction\s*=\s*\(\)\s*=>\s*\{\};\n/g, '\n');
  content = content.replace(/\nfunction noopExec(?:ute|)\(\):\s*void\s*\{[^}]*\}\n/g, '\n');

  // Replace usage of local noopExec/noopExecute with noopExecFn
  content = content.replace(/\bnoopExec(?:ute)?\b(?!Fn)/g, 'noopExecFn');

  // Remove imports that are only needed by the inline class
  // AbstractCircuitElement
  const abstractCount = (content.match(/\bAbstractCircuitElement\b/g) || []).length;
  if (abstractCount <= 1) {
    // Only in import line - remove it
    content = content.replace(/import \{ AbstractCircuitElement \} from ['"][^'"]+['"];\n/g, '');
    content = content.replace(/, AbstractCircuitElement\b/g, '');
    content = content.replace(/\bAbstractCircuitElement, /g, '');
  }

  // resolvePins, createInverterConfig, createClockConfig - only needed by inline class
  const resolveCount = (content.match(/\bresolvePins\b/g) || []).length;
  const inverterCount = (content.match(/\bcreateInverterConfig\b/g) || []).length;
  const clockCount = (content.match(/\bcreateClockConfig\b/g) || []).length;

  if (resolveCount <= 1) content = content.replace(/,?\s*resolvePins\b/g, '').replace(/\bresolvePins,?\s*/g, '');
  if (inverterCount <= 1) content = content.replace(/,?\s*createInverterConfig\b/g, '').replace(/\bcreateInverterConfig,?\s*/g, '');
  if (clockCount <= 1) content = content.replace(/,?\s*createClockConfig\b/g, '').replace(/\bcreateClockConfig,?\s*/g, '');

  // Clean up empty import statements like: import { } from '...'
  content = content.replace(/import \{[\s,]*\} from ['"][^'"]+['"];\n/g, '');

  // RenderContext and Rect - only needed by inline class draw/getBoundingBox
  const renderCtxCount = (content.match(/\bRenderContext\b/g) || []).length;
  const rectCount = (content.match(/\bRect\b/g) || []).length;

  if (renderCtxCount <= 1) {
    content = content.replace(/import type \{ RenderContext(?:, Rect)? \} from ['"][^'"]+['"];\n/g, '');
    content = content.replace(/import type \{ RenderContext \} from ['"][^'"]+['"];\n/g, '');
    content = content.replace(/,?\s*RenderContext\b/g, '').replace(/\bRenderContext,?\s*/g, '');
  }
  if (rectCount <= 1) {
    content = content.replace(/import type \{ Rect \} from ['"][^'"]+['"];\n/g, '');
    content = content.replace(/,?\s*Rect\b/g, '').replace(/\bRect,?\s*/g, '');
  }

  // Clean up empty type imports
  content = content.replace(/import type \{[\s,]*\} from ['"][^'"]+['"];\n/g, '');

  // Now add fixture imports at the end of existing imports
  const needsCreateFromDecls = content.includes('createTestElementFromDecls(');
  const alreadyHasTestElementImport = content.includes("from '" + fixturePrefix + "/test-element") ||
                                       content.includes('from "' + fixturePrefix + '/test-element');

  if (needsCreateFromDecls && !alreadyHasTestElementImport) {
    const importLine = `import { createTestElementFromDecls } from '${fixturePrefix}/test-element.js';`;
    const lastImportIdx = findLastImportEnd(content);
    content = content.slice(0, lastImportIdx) + importLine + '\n' + content.slice(lastImportIdx);
  }

  const needsNoopExecFn = content.includes('noopExecFn');
  const alreadyHasExecuteStubs = content.includes("from '" + fixturePrefix + "/execute-stubs") ||
                                  content.includes('from "' + fixturePrefix + '/execute-stubs');

  if (needsNoopExecFn && !alreadyHasExecuteStubs) {
    const importLine = `import { noopExecFn } from '${fixturePrefix}/execute-stubs.js';`;
    const lastImportIdx = findLastImportEnd(content);
    content = content.slice(0, lastImportIdx) + importLine + '\n' + content.slice(lastImportIdx);
  }

  return content;
}

for (const f of files) {
  let content = readFileSync(f, 'utf8');

  const beforeClass = (content.match(/class TestElement extends/g) || []).length;
  const beforeNew = (content.match(/new TestElement\(/g) || []).length;

  content = removeInlineClass(content);
  content = updateImports(content, f);

  const afterClass = (content.match(/class TestElement extends/g) || []).length;
  const afterNew = (content.match(/new TestElement\(/g) || []).length;

  console.log(f.split('/').pop() + ': class ' + beforeClass + '->' + afterClass + ', new TestElement ' + beforeNew + '->' + afterNew);

  writeFileSync(f, content);
  console.log('  Written.');
}
