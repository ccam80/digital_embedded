import { readFileSync } from 'node:fs';

const j = JSON.parse(readFileSync('./.vitest-failures.json', 'utf8'));
const f = j.failures;
f.sort((a, b) => b.count - a.count);

let total = 0;
for (const x of f) total += x.count;

console.log('Total failure occurrences:', total, 'across', f.length, 'unique messages');
console.log();

f.slice(0, 30).forEach((x, i) => {
  const file = (x.locations[0]?.file || '').replace(/\\/g, '/');
  const fileShort = file.split('/').slice(-2).join('/');
  console.log('[' + String(i + 1).padStart(2) + '] x' + x.count + '  ' + fileShort + ' :: ' + x.message.slice(0, 160));
});
