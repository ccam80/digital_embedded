import { readFileSync, writeFileSync } from 'fs';

const path = 'C:/local_working_projects/digital_in_browser/src/components/semiconductors/__tests__/diode.test.ts';
let src = readFileSync(path, 'utf8');
const orig = src;

// ====================================================================
// 1. voltage_limiting_applied: Float64Array(2)->3, voltages[0]->[1], matrixSize:2->3
// ====================================================================
src = src.replace(
  /const voltages = new Float64Array\(2\);\n([ \t]*)voltages\[0\] = 0\.3;\n([ \t]*)voltages\[1\] = 0;\n([ \t]*)\/\/ Drive to 0\.3V operating point\n([ \t]*)driveToOp\(element, voltages, 20, \{ matrixSize: 2 \}\)/,
  'const voltages = new Float64Array(3);\n$1voltages[1] = 0.3;\n$2voltages[2] = 0;\n$3// Drive to 0.3V operating point\n$4driveToOp(element, voltages, 20, { matrixSize: 3 })'
);
src = src.replace(
  /\/\/ Now simulate a large NR step to 5\.0V\n([ \t]*)voltages\[0\] = 5\.0;\n([ \t]*)voltages\[1\] = 0;\n([ \t]*)const jumpSolver/,
  '// Now simulate a large NR step to 5.0V\n$1voltages[1] = 5.0;\n$2voltages[2] = 0;\n$3const jumpSolver'
);
src = src.replace(
  /solver: jumpSolver,\n([ \t]*)elements: \[element\],\n([ \t]*)matrixSize: 2,\n([ \t]*)nodeCount: 2,/,
  'solver: jumpSolver,\n$1elements: [element],\n$2matrixSize: 3,\n$3nodeCount: 3,'
);
// Fix expect after write-back check (unicode arrow in comment)
src = src.replace(
  /expect\(voltages\[0\]\)\.toBe\(5\.0\);\n([ \t]*)expect\(voltages\[1\]\)\.toBe\(0\);/,
  'expect(voltages[1]).toBe(5.0);\n$1expect(voltages[2]).toBe(0);'
);
console.log('1 voltage_limiting done');

// ====================================================================
// 2. junction_capacitance_when_cjo_nonzero: Float64Array(2)->3, [0]=-2->[1]=-2
// ====================================================================
src = src.replace(
  /const voltages = new Float64Array\(2\);\n([ \t]*)voltages\[0\] = -2; \/\/ anode at -2V\n([ \t]*)voltages\[1\] = 0;  \/\/ cathode at 0V\n([ \t]*)const capSolver/,
  'const voltages = new Float64Array(3);\n$1voltages[1] = -2; // anode at -2V\n$2voltages[2] = 0;  // cathode at 0V\n$3const capSolver'
);
// capSolver._initStructure(2) -> 3
src = src.replace(
  /(const capCtx = makeLoadCtx\(\{[\s\S]*?\}\);\n[ \t]*)capSolver\._initStructure\(2\);/,
  '$1capSolver._initStructure(3);'
);
console.log('2 junction_cap done');

// ====================================================================
// 3. load_at_initJct_with_OFF: Float64Array(2)->3, voltages[0]=5->[1]=5
// ====================================================================
src = src.replace(
  /const voltages = new Float64Array\(2\);\n([ \t]*)voltages\[0\] = 5; \/\/ would give Vd=5V without OFF/,
  'const voltages = new Float64Array(3);\n$1voltages[1] = 5; // would give Vd=5V without OFF'
);
// solver._initStructure(2) for el.load (initJct)
src = src.replace(
  /const solver = new SparseSolver\(\);\n([ \t]*)solver\._initStructure\(2\);\n([ \t]*)el\.load\(buildUnitCtx\(solver, voltages/,
  'const solver = new SparseSolver();\n$1solver._initStructure(3);\n$2el.load(buildUnitCtx(solver, voltages'
);
// convSolver._initStructure(2)
src = src.replace(
  /const convSolver = new SparseSolver\(\);\n([ \t]*)convSolver\._initStructure\(2\);\n([ \t]*)const converged = el\.checkConvergence!/,
  'const convSolver = new SparseSolver();\n$1convSolver._initStructure(3);\n$2const converged = el.checkConvergence!'
);
console.log('3 initJct_OFF done');

// ====================================================================
// 4. LimitingEvent tests: voltages[0] -> [1] (all use Float64Array(10))
// ====================================================================
src = src.replace(
  /voltages\[0\] = 5\.0; \/\/ node 1 = anode/g,
  'voltages[1] = 5.0; // node 1 = anode'
);
src = src.replace(
  /const voltages = new Float64Array\(10\);\n([ \t]*)voltages\[0\] = 5\.0;\n([ \t]*)expect\(\(\) => loadOnce\(element, voltages, null\)\)\.not\.toThrow\(\)/,
  'const voltages = new Float64Array(10);\n$1voltages[1] = 5.0;\n$2expect(() => loadOnce(element, voltages, null)).not.toThrow()'
);
src = src.replace(
  /const voltages = new Float64Array\(10\);\n([ \t]*)voltages\[0\] = 0\.0;\n([ \t]*)loadOnce\(element, voltages, null\);\n([ \t]*)\/\/ Now a large jump/,
  'const voltages = new Float64Array(10);\n$1voltages[1] = 0.0;\n$2loadOnce(element, voltages, null);\n$3// Now a large jump'
);
src = src.replace(
  /\/\/ Now a large jump: should be limited\n([ \t]*)voltages\[0\] = 10\.0;/,
  '// Now a large jump: should be limited\n$1voltages[1] = 10.0;'
);
src = src.replace(
  /const voltages = new Float64Array\(10\);\n([ \t]*)voltages\[0\] = 0\.6;\n([ \t]*)\/\/ Warm up/,
  'const voltages = new Float64Array(10);\n$1voltages[1] = 0.6;\n$2// Warm up'
);
src = src.replace(
  /\/\/ Tiny step[^\n]*\n([ \t]*)voltages\[0\] = 0\.601;/,
  '// Tiny step- should not be limited\n$1voltages[1] = 0.601;'
);
console.log('4 LimitingEvent done');

// ====================================================================
// 5. diodeSlot / diodeGd helpers: voltages[0] = vd -> [1] (Float64Array(10))
// ====================================================================
src = src.replace(
  /const voltages = new Float64Array\(10\);\n([ \t]*)voltages\[0\] = vd;\n([ \t]*)driveToOp\(element, voltages, 50/g,
  'const voltages = new Float64Array(10);\n$1voltages[1] = vd;\n$2driveToOp(element, voltages, 50'
);
console.log('5 diodeSlot/diodeGd done');

// ====================================================================
// 6. pn_cap_transient: buildUnitCtx(solver, new Float64Array([vd, 0])) -> [0, vd]
// ====================================================================
src = src.replace(
  /const ctx = buildUnitCtx\(solver, new Float64Array\(\[vd, 0\]\), \{/,
  'const ctx = buildUnitCtx(solver, new Float64Array([0, vd]), {'
);
console.log('6 pn_cap_transient done');

// ====================================================================
// 7. forward_bias_dcop_stamp_parity: [VD, 0] -> [0, VD, 0], initStructure(2)->3, RHS [0]->[1], [1]->[2]
// ====================================================================
src = src.replace(
  /const voltages = new Float64Array\(\[VD, 0\]\);\n([ \t]*)const ctx = makeParityCtx\(solver, voltages/,
  'const voltages = new Float64Array([0, VD, 0]);\n$1const ctx = makeParityCtx(solver, voltages'
);
// The comment before solver in dcop_parity; replace _initStructure(2) in that block
src = src.replace(
  /\/\/ Real 2\xD73\xD72 SparseSolver[^\n]*\n([ \t]*)const solver = new SparseSolver\(\);\n([ \t]*)solver\._initStructure\(2\);\n([ \t]*)const voltages = new Float64Array\(\[0, VD, 0\]\)/,
  '// Real 3\xD73 SparseSolver (node indices 0,1,2 for ground, anode, cathode rows).\n$1const solver = new SparseSolver();\n$2solver._initStructure(3);\n$3const voltages = new Float64Array([0, VD, 0])'
);
// If the comment didn't match exactly, try another pattern
src = src.replace(
  /\/\/ Real 2[^\n]*\n([ \t]*)const solver = new SparseSolver\(\);\n([ \t]*)solver\._initStructure\(2\);\n([ \t]*)const voltages = new Float64Array\(\[0, VD, 0\]\)/,
  '// Real 3x3 SparseSolver (nodes 0=ground, 1=anode, 2=cathode).\n$1const solver = new SparseSolver();\n$2solver._initStructure(3);\n$3const voltages = new Float64Array([0, VD, 0])'
);
// RHS assertions
src = src.replace(
  /expect\(rhsVec\[0\]\)\.toBe\(-NGSPICE_IEQ\);\n([ \t]*)expect\(rhsVec\[1\]\)\.toBe\(NGSPICE_IEQ\)/,
  'expect(rhsVec[1]).toBe(-NGSPICE_IEQ);\n$1expect(rhsVec[2]).toBe(NGSPICE_IEQ)'
);
console.log('7 dcop_parity done');

// ====================================================================
// 8. junction_cap_transient_parity: new Float64Array([VD]) -> [0, VD]
// ====================================================================
src = src.replace(
  /const ctx = makeParityCtx\(solver, new Float64Array\(\[VD\]\), \{/,
  'const ctx = makeParityCtx(solver, new Float64Array([0, VD]), {'
);
console.log('8 tran_parity done');

// ====================================================================
// 9. MODEINITSMSIG inline array literals
// ====================================================================
src = src.replace(/new Float64Array\(\[5\.0, 0\]\)/g, 'new Float64Array([0, 5.0, 0])');
src = src.replace(/new Float64Array\(\[2\.0, 0\]\)/g, 'new Float64Array([0, 2.0, 0])');
src = src.replace(/new Float64Array\(\[3\.0, 0\]\)/g, 'new Float64Array([0, 3.0, 0])');
src = src.replace(/new Float64Array\(\[0\.3, 0\]\)/g, 'new Float64Array([0, 0.3, 0])');
console.log('9 MODEINITSMSIG arrays done');

// solver._initStructure(2) when followed by voltages of size 3
src = src.replace(
  /solver\._initStructure\(2\);\n([ \t]*)const voltages = new Float64Array\(\[0,/g,
  'solver._initStructure(3);\n$1const voltages = new Float64Array([0,'
);
console.log('9b initStructure(2) updated');

// ====================================================================
// 10. checkConvergence: Float64Array(2)->3, initStructure(2)->3, [0.3,0]->[0,0.3,0]
// ====================================================================
src = src.replace(
  /solver\._initStructure\(2\);\n([ \t]*)const result = el\.checkConvergence!\(buildUnitCtx\(solver, new Float64Array\(2\)/g,
  'solver._initStructure(3);\n$1const result = el.checkConvergence!(buildUnitCtx(solver, new Float64Array(3)'
);
src = src.replace(
  /const convergedVoltages = new Float64Array\(\[0\.3, 0\]\)/g,
  'const convergedVoltages = new Float64Array([0, 0.3, 0])'
);
src = src.replace(
  /solver\._initStructure\(2\);\n([ \t]*)\/\/ Voltages match state0 exactly/,
  'solver._initStructure(3);\n$1// Voltages match state0 exactly'
);
console.log('10 checkConvergence done');

// ====================================================================
// 11. MODEINITJCT: Float64Array(2)->3, initStructure(2)->3
// ====================================================================
src = src.replace(
  /solver\._initStructure\(2\);\n([ \t]*)core\.load\(buildUnitCtx\(solver, new Float64Array\(2\)/g,
  'solver._initStructure(3);\n$1core.load(buildUnitCtx(solver, new Float64Array(3)'
);
console.log('11 MODEINITJCT done');

console.log('\nAll diode fixes applied. Changed:', src !== orig);
writeFileSync(path, src, 'utf8');
