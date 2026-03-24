import { readFileSync, readFile, readdir } from 'fs';
import { createDefaultRegistry } from '../src/components/register-all.js';
import { CircuitBuilder } from '../src/headless/builder.js';
import { loadWithSubcircuits } from '../src/io/subcircuit-loader.js';
import { NodeResolver } from '../src/io/file-resolver.js';

const registry = createDefaultRegistry();
const builder = new CircuitBuilder(registry);

const readFileFn = (path: string) => new Promise<string>((res, rej) => {
  readFile(path, 'utf-8', (err, data) => err ? rej(err) : res(data));
});
const readdirFn = (path: string) => new Promise<string[]>((res, rej) => {
  readdir(path, (err, entries) => err ? rej(err) : res(entries));
});

// Test on the full MCU
const mcuXml = readFileSync('fixtures/Sim/MCU.dig', 'utf-8');
const resolver = new NodeResolver('fixtures/Sim/', readFileFn, readdirFn);
const mcu = await loadWithSubcircuits(mcuXml, resolver, registry);

console.log('MCU BEFORE:', builder.validate(mcu).length, 'diagnostics');
for (const d of builder.validate(mcu)) console.log('  ', d.severity, d.code, d.message);

// Fix: set the ADD pin in sysreg to 16-bit (scope into PWMCTRL subcircuit)
// Actually PWMCTRL is a sysreg.dig instance — the ADD In component is INSIDE it.
// We need to fix at the sysreg.dig source level, not patch at runtime.
// But the set op works on the loaded circuit, and the sysreg subcircuit was
// already loaded with the Register bitWidth fix. Let's just validate.
