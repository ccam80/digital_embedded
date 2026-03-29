/**
 * CMOS D flip-flop transistor-level subcircuit definition as MnaSubcircuitNetlist.
 *
 * Implements a transmission-gate master-slave D flip-flop using 20 MOSFETs:
 *   - 1 clock inverter (2 MOSFETs)
 *   - 2 transmission gates for master and slave (4 MOSFETs each = 8 total with keepers)
 *   - 5 inverters for master, master feedback, slave, slave feedback, and output (10 MOSFETs)
 *   Total: 20 MOSFETs
 *
 * Ports: D=0, C=1, Q=2, nQ=3, VDD=4, GND=5
 * Internal nets (6..12):
 *   CLKbar=6, master_in=7, master_out=8, master_fb=9, slave_in=10, (Q and nQ are ports)
 */

import type { MnaSubcircuitNetlist } from "../../../core/mna-subcircuit-netlist.js";
import type { SubcircuitModelRegistry } from "../subcircuit-model-registry.js";

// ---------------------------------------------------------------------------
// createCmosDFlipflop
//
// Ports: D=0, C=1, Q=2, nQ=3, VDD=4, GND=5
// Internal: CLKbar=6, master_in=7, master_out=8, master_fb=9, slave_in=10
//
// Each MOSFET has 4 pins: gate, drain, source, body
// ---------------------------------------------------------------------------

export function createCmosDFlipflop(): MnaSubcircuitNetlist {
  const D = 0, C = 1, Q = 2, nQ = 3, VDD = 4, GND = 5;
  const CLKbar = 6, master_in = 7, master_out = 8, master_fb = 9, slave_in = 10;

  return {
    ports: ["D", "C", "Q", "nQ", "VDD", "GND"],
    elements: [
      { typeId: "PMOS", modelRef: "PMOS_DEFAULT" },  // 0: CLK inv PMOS
      { typeId: "NMOS", modelRef: "NMOS_DEFAULT" },  // 1: CLK inv NMOS
      { typeId: "NMOS", modelRef: "NMOS_DEFAULT" },  // 2: TG_M NMOS
      { typeId: "PMOS", modelRef: "PMOS_DEFAULT" },  // 3: TG_M PMOS
      { typeId: "PMOS", modelRef: "PMOS_DEFAULT" },  // 4: INV_M PMOS
      { typeId: "NMOS", modelRef: "NMOS_DEFAULT" },  // 5: INV_M NMOS
      { typeId: "NMOS", modelRef: "NMOS_DEFAULT" },  // 6: TG_M_fb NMOS
      { typeId: "PMOS", modelRef: "PMOS_DEFAULT" },  // 7: TG_M_fb PMOS
      { typeId: "PMOS", modelRef: "PMOS_DEFAULT" },  // 8: INV_M_fb PMOS
      { typeId: "NMOS", modelRef: "NMOS_DEFAULT" },  // 9: INV_M_fb NMOS
      { typeId: "NMOS", modelRef: "NMOS_DEFAULT" },  // 10: TG_S NMOS
      { typeId: "PMOS", modelRef: "PMOS_DEFAULT" },  // 11: TG_S PMOS
      { typeId: "PMOS", modelRef: "PMOS_DEFAULT" },  // 12: INV_S1 PMOS
      { typeId: "NMOS", modelRef: "NMOS_DEFAULT" },  // 13: INV_S1 NMOS
      { typeId: "NMOS", modelRef: "NMOS_DEFAULT" },  // 14: TG_S_fb NMOS
      { typeId: "PMOS", modelRef: "PMOS_DEFAULT" },  // 15: TG_S_fb PMOS
      { typeId: "PMOS", modelRef: "PMOS_DEFAULT" },  // 16: INV_S2 PMOS
      { typeId: "NMOS", modelRef: "NMOS_DEFAULT" },  // 17: INV_S2 NMOS
    ],
    internalNetCount: 5,
    netlist: [
      [C, CLKbar, VDD, VDD],             // 0: CLK inv PMOS: gate=C, drain=CLKbar, source=VDD, body=VDD
      [C, CLKbar, GND, GND],             // 1: CLK inv NMOS: gate=C, drain=CLKbar, source=GND, body=GND
      [CLKbar, master_in, D, GND],       // 2: TG_M NMOS: gate=CLKbar, drain=master_in, source=D, body=GND
      [C, master_in, D, VDD],            // 3: TG_M PMOS: gate=C, drain=master_in, source=D, body=VDD
      [master_in, master_out, VDD, VDD], // 4: INV_M PMOS: gate=master_in, drain=master_out, source=VDD, body=VDD
      [master_in, master_out, GND, GND], // 5: INV_M NMOS: gate=master_in, drain=master_out, source=GND, body=GND
      [C, master_in, master_fb, GND],    // 6: TG_M_fb NMOS: gate=C, drain=master_in, source=master_fb, body=GND
      [CLKbar, master_in, master_fb, VDD], // 7: TG_M_fb PMOS: gate=CLKbar, drain=master_in, source=master_fb, body=VDD
      [master_out, master_fb, VDD, VDD], // 8: INV_M_fb PMOS: gate=master_out, drain=master_fb, source=VDD, body=VDD
      [master_out, master_fb, GND, GND], // 9: INV_M_fb NMOS: gate=master_out, drain=master_fb, source=GND, body=GND
      [C, slave_in, master_out, GND],    // 10: TG_S NMOS: gate=C, drain=slave_in, source=master_out, body=GND
      [CLKbar, slave_in, master_out, VDD], // 11: TG_S PMOS: gate=CLKbar, drain=slave_in, source=master_out, body=VDD
      [slave_in, Q, VDD, VDD],           // 12: INV_S1 PMOS: gate=slave_in, drain=Q, source=VDD, body=VDD
      [slave_in, Q, GND, GND],           // 13: INV_S1 NMOS: gate=slave_in, drain=Q, source=GND, body=GND
      [CLKbar, slave_in, nQ, GND],       // 14: TG_S_fb NMOS: gate=CLKbar, drain=slave_in, source=nQ, body=GND
      [C, slave_in, nQ, VDD],            // 15: TG_S_fb PMOS: gate=C, drain=slave_in, source=nQ, body=VDD
      [Q, nQ, VDD, VDD],                 // 16: INV_S2 PMOS: gate=Q, drain=nQ, source=VDD, body=VDD
      [Q, nQ, GND, GND],                 // 17: INV_S2 NMOS: gate=Q, drain=nQ, source=GND, body=GND
    ],
  };
}

// ---------------------------------------------------------------------------
// registerCmosDFlipflop
// ---------------------------------------------------------------------------

export function registerCmosDFlipflop(modelRegistry: SubcircuitModelRegistry): void {
  modelRegistry.register("CmosDFlipflop", createCmosDFlipflop());
}
