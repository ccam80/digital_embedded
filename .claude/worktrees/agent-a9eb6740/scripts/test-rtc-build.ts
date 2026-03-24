import { createDefaultRegistry } from '../src/components/register-all.js';
import { CircuitBuilder } from '../src/headless/builder.js';
import { serializeCircuit } from '../src/io/save.js';
import { writeFileSync } from 'fs';
import type { CircuitSpec } from '../src/headless/netlist-types.js';

const registry = createDefaultRegistry();
const builder = new CircuitBuilder(registry);

// Build the RTC with explicit positions to avoid auto-layout collisions.
// Layout: inputs on the left, logic in the middle, outputs on the right.
const rtcSpec: CircuitSpec = {
  name: "RTC",
  description: "Real-Time Clock peripheral. 8-bit free-running counter with bus read/write and overflow interrupt.",
  components: [
    // Bus interface inputs — spaced vertically on the left
    { id: "ADD",        type: "In",         props: { label: "ADD", bitWidth: 16, position: [0, 0] } },
    { id: "DAT",        type: "In",         props: { label: "DAT", bitWidth: 8,  position: [0, 6] } },
    { id: "R",          type: "In",         props: { label: "R",                 position: [0, 12] } },
    { id: "W",          type: "In",         props: { label: "W",                 position: [0, 18] } },
    { id: "C",          type: "Clock",      props: { label: "C",                 position: [0, 24] } },

    // Address decode — middle-left
    { id: "addr_const", type: "Const",      props: { value: 4096, bitWidth: 16,  position: [6, 4] } },
    { id: "addr_cmp",   type: "Comparator", props: { bitWidth: 16, label: "ADDR_CMP", position: [10, 0] } },

    // R/W qualification gates
    { id: "r_gate",     type: "And",        props: { label: "R_GATE",            position: [16, 8] } },
    { id: "w_gate",     type: "And",        props: { label: "W_GATE",            position: [16, 14] } },

    // Counter — middle-right
    { id: "counter",    type: "Counter",    props: { bitWidth: 8, label: "RTC_CNT", position: [22, 10] } },
    { id: "en_const",   type: "Const",      props: { value: 1,                   position: [18, 10] } },

    // Read-back driver
    { id: "driver",     type: "Driver",     props: { bitWidth: 8,                position: [28, 10] } },

    // Outputs — right side
    { id: "out_dat",    type: "Out",        props: { label: "DAT_OUT", bitWidth: 8, position: [34, 10] } },
    { id: "out_tick",   type: "Out",        props: { label: "TICK",               position: [34, 16] } },
  ],
  connections: [
    // Address decoding
    ["ADD:out",        "addr_cmp:a"],
    ["addr_const:out", "addr_cmp:b"],

    // Qualify R/W with address match
    ["addr_cmp:=",  "r_gate:In_1"],
    ["R:out",       "r_gate:In_2"],
    ["addr_cmp:=",  "w_gate:In_1"],
    ["W:out",       "w_gate:In_2"],

    // Counter: always enabled, clock, clear on write
    ["en_const:out", "counter:en"],
    ["C:out",        "counter:C"],
    ["w_gate:out",   "counter:clr"],

    // Read path: tristate driver onto bus
    ["counter:out",  "driver:in"],
    ["r_gate:out",   "driver:sel"],
    ["driver:out",   "out_dat:in"],

    // Overflow tick output
    ["counter:ovf",  "out_tick:in"],
  ],
};

try {
  const circuit = builder.build(rtcSpec);
  const netlist = builder.netlist(circuit);

  console.log('RTC built successfully!');
  console.log(`Components: ${netlist.components.length}`);
  console.log(`Wires: ${circuit.wires.length}`);
  console.log(`Diagnostics: ${netlist.diagnostics.length}`);
  for (const d of netlist.diagnostics) {
    console.log(`  ${d.severity} ${d.code}: ${d.message}`);
    if (d.pins) {
      for (const p of d.pins) {
        console.log(`    ${p.componentLabel}:${p.pinLabel} [${p.declaredWidth}-bit, ${p.pinDirection}]`);
      }
    }
  }

  if (netlist.diagnostics.filter(d => d.severity === 'error').length === 0) {
    const json = serializeCircuit(circuit);
    writeFileSync('fixtures/Sim/RTC.json', json, 'utf-8');
    console.log(`\nSaved to fixtures/Sim/RTC.json (${json.length} bytes)`);
  }
} catch (e: any) {
  console.error('BUILD ERROR:', e.message);
  console.error(e.stack);
}
