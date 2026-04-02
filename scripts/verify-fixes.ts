/**
 * Quick verification script for the 6 bug fixes.
 * Run: npx tsx scripts/verify-fixes.ts
 */
import { createDefaultRegistry } from "../src/components/register-all.js";
import { DefaultSimulatorFacade } from "../src/headless/default-facade.js";
import type { CircuitSpec } from "../src/headless/netlist-types.js";

const registry = createDefaultRegistry();
const runner = new DefaultSimulatorFacade(registry);

let pass = 0;
let fail = 0;

function check(name: string, actual: number, expected: number) {
  if (actual === expected) {
    console.log(`  PASS: ${name} = ${actual}`);
    pass++;
  } else {
    console.log(`  FAIL: ${name} = ${actual}, expected ${expected}`);
    fail++;
  }
}

async function buildAndRun(spec: CircuitSpec) {
  const circuit = runner.build(spec);
  const engine = runner.compile(circuit);
  await runner.settle(engine);
  return { engine };
}

// Bug 1: Const value
console.log("\n--- Bug 1: Const value ---");
{
  const { engine } = await buildAndRun({
    components: [
      { id: "C", type: "Const", props: { bitWidth: 8, value: 42 } },
      { id: "Y", type: "Out", props: { bitWidth: 8, label: "Y" } },
    ],
    connections: [["C:out", "Y:in"]],
  });
  check("Const(42)", runner.readSignal(engine, "Y"), 42);
}
{
  const { engine } = await buildAndRun({
    components: [
      { id: "C", type: "Const", props: { bitWidth: 1, value: 1 } },
      { id: "Y", type: "Out", props: { bitWidth: 1, label: "Y" } },
    ],
    connections: [["C:out", "Y:in"]],
  });
  check("Const(1)", runner.readSignal(engine, "Y"), 1);
}

// Bug 2: BitExtender
console.log("\n--- Bug 2: BitExtender ---");
{
  const { engine } = await buildAndRun({
    components: [
      { id: "A", type: "In", props: { label: "A", bitWidth: 8 } },
      { id: "E", type: "BitExtender", props: { inputBits: 8, outputBits: 16 } },
      { id: "Y", type: "Out", props: { bitWidth: 16, label: "Y" } },
    ],
    connections: [["A:out", "E:in"], ["E:out", "Y:in"]],
  });
  runner.setSignal(engine, "A", 128);
  await runner.settle(engine);
  check("BitExt(128, 8→16)", runner.readSignal(engine, "Y"), 65408); // sign extend 0x80 → 0xFF80

  runner.setSignal(engine, "A", 5);
  await runner.settle(engine);
  check("BitExt(5, 8→16)", runner.readSignal(engine, "Y"), 5);

  runner.setSignal(engine, "A", 127);
  await runner.settle(engine);
  check("BitExt(127, 8→16)", runner.readSignal(engine, "Y"), 127);
}

// Bug 3: Splitter split
console.log("\n--- Bug 3a: Splitter split 8→4+4 ---");
{
  const { engine } = await buildAndRun({
    components: [
      { id: "D", type: "In", props: { label: "D", bitWidth: 8 } },
      { id: "S", type: "Splitter", props: { "input splitting": "8", "output splitting": "4,4" } },
      { id: "LO", type: "Out", props: { bitWidth: 4, label: "LO" } },
      { id: "HI", type: "Out", props: { bitWidth: 4, label: "HI" } },
    ],
    connections: [["D:out", "S:0-7"], ["S:0-3", "LO:in"], ["S:4-7", "HI:in"]],
  });
  runner.setSignal(engine, "D", 0xA5);
  await runner.settle(engine);
  check("Split LO(0xA5)", runner.readSignal(engine, "LO"), 5);
  check("Split HI(0xA5)", runner.readSignal(engine, "HI"), 10);

  runner.setSignal(engine, "D", 255);
  await runner.settle(engine);
  check("Split LO(255)", runner.readSignal(engine, "LO"), 15);
  check("Split HI(255)", runner.readSignal(engine, "HI"), 15);
}

// Bug 3b: Splitter merge
console.log("\n--- Bug 3b: Splitter merge 3+1→4 ---");
{
  const { engine } = await buildAndRun({
    components: [
      { id: "LO", type: "In", props: { label: "LO", bitWidth: 3 } },
      { id: "HI", type: "In", props: { label: "HI", bitWidth: 1 } },
      { id: "S", type: "Splitter", props: { "input splitting": "3,1", "output splitting": "4" } },
      { id: "Y", type: "Out", props: { bitWidth: 4, label: "Y" } },
    ],
    connections: [["LO:out", "S:0-2"], ["HI:out", "S:3"], ["S:0-3", "Y:in"]],
  });
  runner.setSignal(engine, "LO", 5);
  runner.setSignal(engine, "HI", 1);
  await runner.settle(engine);
  check("Merge(5,1)", runner.readSignal(engine, "Y"), 13); // 5 + 8 = 13

  runner.setSignal(engine, "LO", 7);
  runner.setSignal(engine, "HI", 0);
  await runner.settle(engine);
  check("Merge(7,0)", runner.readSignal(engine, "Y"), 7);
}

// Bug 4: ROM data init
console.log("\n--- Bug 4: ROM data init ---");
{
  const { engine } = await buildAndRun({
    components: [
      { id: "S", type: "In", props: { label: "S", bitWidth: 1 } },
      { id: "G", type: "Ground" },
      { id: "R", type: "ROM", props: { addrBits: 1, dataBits: 16, data: "0503" } },
      { id: "Y", type: "Out", props: { bitWidth: 16, label: "Y" } },
    ],
    connections: [["G:out", "R:A"], ["S:out", "R:sel"], ["R:D", "Y:in"]],
  });
  runner.setSignal(engine, "S", 1);
  await runner.settle(engine);
  check("ROM[0] = 0x0503", runner.readSignal(engine, "Y"), 0x0503);
}

// Summary
console.log(`\n=== Results: ${pass} passed, ${fail} failed ===`);
process.exit(fail > 0 ? 1 : 0);
