const fs = require('fs');

// Files that have deltaOld but no cktFixLimit — add cktFixLimit, bypass, voltTol after iabstol
const files = [
  'src/components/active/__tests__/adc.test.ts',
  'src/components/sensors/__tests__/ntc-thermistor.test.ts',
  'src/components/sensors/__tests__/spark-gap.test.ts',
  'src/solver/analog/__tests__/sparse-solver.test.ts',
  'src/solver/analog/__tests__/dcop-init-jct.test.ts',
  'src/components/sources/__tests__/variable-rail.test.ts',
  'src/components/sources/__tests__/ac-voltage-source.test.ts',
  'src/components/io/__tests__/analog-clock.test.ts',
  'src/components/sources/__tests__/current-source.test.ts',
  'src/components/sources/__tests__/dc-voltage-source.test.ts',
  'src/components/sources/__tests__/ground.test.ts',
  'src/components/io/__tests__/probe.test.ts'
];

let totalModified = 0;
let totalUnchanged = 0;

for (const f of files) {
  let content;
  try { content = fs.readFileSync(f, 'utf8'); } catch(e) { console.log('MISSING: ' + f); continue; }

  if (!content.includes('deltaOld:')) {
    console.log('NO_DELTAOLD: ' + f);
    totalUnchanged++;
    continue;
  }

  // Replace: (indent)iabstol: VALUE,\n(SAME_indent)};
  // With:    (indent)iabstol: VALUE,\n(indent)cktFixLimit: false,\n(indent)bypass: false,\n(indent)voltTol: 1e-6,\n(indent)};
  const newContent = content.replace(/^([ \t]*)iabstol: ([^,\n]+),(\n\1\};)/gm, (match, indent, val, closing) => {
    return indent + 'iabstol: ' + val + ',\n' +
           indent + 'cktFixLimit: false,\n' +
           indent + 'bypass: false,\n' +
           indent + 'voltTol: 1e-6,' + closing;
  });

  if (newContent === content) {
    console.log('NO_CHANGE: ' + f);
    totalUnchanged++;
  } else {
    fs.writeFileSync(f, newContent, 'utf8');
    const origCount = (content.match(/\biabstol:/g) || []).length;
    const newCount = (newContent.match(/cktFixLimit: false,/g) || []).length;
    console.log('MODIFIED(iabstol=' + origCount + ', added=' + newCount + '): ' + f);
    totalModified++;
  }
}
console.log('\nDone: ' + totalModified + ' modified, ' + totalUnchanged + ' unchanged');
