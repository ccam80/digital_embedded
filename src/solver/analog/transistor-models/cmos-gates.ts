/**
 * CMOS gate transistor-level subcircuit definitions as MnaSubcircuitNetlist.
 *
 * Each factory function returns an MnaSubcircuitNetlist describing the
 * MOSFET connectivity for standard CMOS logic topologies. The netlists are
 * registered in the SubcircuitModelRegistry and referenced by the
 * subcircuitRefs field on the corresponding gate ComponentDefinition.
 *
 * MOSFET pin order: gate, drain, source, body (4 pins per MOSFET).
 * Body is tied to VDD for PMOS and GND for NMOS.
 *
 * Port index conventions:
 *   Single-input gates: in=0, out=1, VDD=2, GND=3
 *   Two-input gates:    In_1=0, In_2=1, out=2, VDD=3, GND=4
 *   Internal nets start at ports.length.
 */

import type { MnaSubcircuitNetlist } from "../../../core/mna-subcircuit-netlist.js";
import type { SubcircuitModelRegistry } from "../subcircuit-model-registry.js";

// ---------------------------------------------------------------------------
// createCmosInverter
//
// PMOS: gate=in, drain=out, source=VDD, body=VDD
// NMOS: gate=in, drain=out, source=GND, body=GND
//
// Ports: in=0, out=1, VDD=2, GND=3
// ---------------------------------------------------------------------------

export function createCmosInverter(): MnaSubcircuitNetlist {
  return {
    ports: ["in", "out", "VDD", "GND"],
    elements: [
      { typeId: "PMOS", modelRef: "PMOS_DEFAULT" },
      { typeId: "NMOS", modelRef: "NMOS_DEFAULT" },
    ],
    internalNetCount: 0,
    netlist: [
      [0, 1, 2, 2],  // PMOS: gate=in, drain=out, source=VDD, body=VDD
      [0, 1, 3, 3],  // NMOS: gate=in, drain=out, source=GND, body=GND
    ],
  };
}

// ---------------------------------------------------------------------------
// createCmosNand2
//
// Pull-up: 2 PMOS parallel (sources→VDD, gates→A/B, drains→out)
// Pull-down: 2 NMOS series (top drain→out, bottom source→GND, mid=internal)
//
// Ports: In_1=0, In_2=1, out=2, VDD=3, GND=4
// Internal: mid=5
// ---------------------------------------------------------------------------

export function createCmosNand2(): MnaSubcircuitNetlist {
  return {
    ports: ["In_1", "In_2", "out", "VDD", "GND"],
    elements: [
      { typeId: "PMOS", modelRef: "PMOS_DEFAULT" },  // PA: gate=A, drain=out, source=VDD
      { typeId: "PMOS", modelRef: "PMOS_DEFAULT" },  // PB: gate=B, drain=out, source=VDD
      { typeId: "NMOS", modelRef: "NMOS_DEFAULT" },  // NA: gate=A, drain=out, source=mid
      { typeId: "NMOS", modelRef: "NMOS_DEFAULT" },  // NB: gate=B, drain=mid, source=GND
    ],
    internalNetCount: 1,
    netlist: [
      [0, 2, 3, 3],  // PA: gate=In_1, drain=out, source=VDD, body=VDD
      [1, 2, 3, 3],  // PB: gate=In_2, drain=out, source=VDD, body=VDD
      [0, 2, 5, 4],  // NA: gate=In_1, drain=out, source=mid, body=GND
      [1, 5, 4, 4],  // NB: gate=In_2, drain=mid, source=GND, body=GND
    ],
  };
}

// ---------------------------------------------------------------------------
// createCmosNor2
//
// Pull-up: 2 PMOS series (top source→VDD, bottom drain→out, mid=internal)
// Pull-down: 2 NMOS parallel (sources→GND, gates→A/B, drains→out)
//
// Ports: In_1=0, In_2=1, out=2, VDD=3, GND=4
// Internal: mid=5
// ---------------------------------------------------------------------------

export function createCmosNor2(): MnaSubcircuitNetlist {
  return {
    ports: ["In_1", "In_2", "out", "VDD", "GND"],
    elements: [
      { typeId: "PMOS", modelRef: "PMOS_DEFAULT" },  // PA: gate=A, drain=mid, source=VDD
      { typeId: "PMOS", modelRef: "PMOS_DEFAULT" },  // PB: gate=B, drain=out, source=mid
      { typeId: "NMOS", modelRef: "NMOS_DEFAULT" },  // NA: gate=A, drain=out, source=GND
      { typeId: "NMOS", modelRef: "NMOS_DEFAULT" },  // NB: gate=B, drain=out, source=GND
    ],
    internalNetCount: 1,
    netlist: [
      [0, 5, 3, 3],  // PA: gate=In_1, drain=mid, source=VDD, body=VDD
      [1, 2, 5, 3],  // PB: gate=In_2, drain=out, source=mid, body=VDD
      [0, 2, 4, 4],  // NA: gate=In_1, drain=out, source=GND, body=GND
      [1, 2, 4, 4],  // NB: gate=In_2, drain=out, source=GND, body=GND
    ],
  };
}

// ---------------------------------------------------------------------------
// createCmosAnd2
//
// NAND2 + inverter. 6 MOSFETs total.
//
// Ports: In_1=0, In_2=1, out=2, VDD=3, GND=4
// Internal: nand_out=5, nmos_mid=6
// ---------------------------------------------------------------------------

export function createCmosAnd2(): MnaSubcircuitNetlist {
  return {
    ports: ["In_1", "In_2", "out", "VDD", "GND"],
    elements: [
      { typeId: "PMOS", modelRef: "PMOS_DEFAULT" },  // NAND PA
      { typeId: "PMOS", modelRef: "PMOS_DEFAULT" },  // NAND PB
      { typeId: "NMOS", modelRef: "NMOS_DEFAULT" },  // NAND NA
      { typeId: "NMOS", modelRef: "NMOS_DEFAULT" },  // NAND NB
      { typeId: "PMOS", modelRef: "PMOS_DEFAULT" },  // INV PI
      { typeId: "NMOS", modelRef: "NMOS_DEFAULT" },  // INV NI
    ],
    internalNetCount: 2,
    netlist: [
      [0, 5, 3, 3],  // NAND PA: gate=In_1, drain=nand_out, source=VDD, body=VDD
      [1, 5, 3, 3],  // NAND PB: gate=In_2, drain=nand_out, source=VDD, body=VDD
      [0, 5, 6, 4],  // NAND NA: gate=In_1, drain=nand_out, source=mid, body=GND
      [1, 6, 4, 4],  // NAND NB: gate=In_2, drain=mid, source=GND, body=GND
      [5, 2, 3, 3],  // INV PI: gate=nand_out, drain=out, source=VDD, body=VDD
      [5, 2, 4, 4],  // INV NI: gate=nand_out, drain=out, source=GND, body=GND
    ],
  };
}

// ---------------------------------------------------------------------------
// createCmosOr2
//
// NOR2 + inverter. 6 MOSFETs total.
//
// Ports: In_1=0, In_2=1, out=2, VDD=3, GND=4
// Internal: nor_out=5, pmos_mid=6
// ---------------------------------------------------------------------------

export function createCmosOr2(): MnaSubcircuitNetlist {
  return {
    ports: ["In_1", "In_2", "out", "VDD", "GND"],
    elements: [
      { typeId: "PMOS", modelRef: "PMOS_DEFAULT" },  // NOR PA
      { typeId: "PMOS", modelRef: "PMOS_DEFAULT" },  // NOR PB
      { typeId: "NMOS", modelRef: "NMOS_DEFAULT" },  // NOR NA
      { typeId: "NMOS", modelRef: "NMOS_DEFAULT" },  // NOR NB
      { typeId: "PMOS", modelRef: "PMOS_DEFAULT" },  // INV PI
      { typeId: "NMOS", modelRef: "NMOS_DEFAULT" },  // INV NI
    ],
    internalNetCount: 2,
    netlist: [
      [0, 6, 3, 3],  // NOR PA: gate=In_1, drain=pmos_mid, source=VDD, body=VDD
      [1, 5, 6, 3],  // NOR PB: gate=In_2, drain=nor_out, source=pmos_mid, body=VDD
      [0, 5, 4, 4],  // NOR NA: gate=In_1, drain=nor_out, source=GND, body=GND
      [1, 5, 4, 4],  // NOR NB: gate=In_2, drain=nor_out, source=GND, body=GND
      [5, 2, 3, 3],  // INV PI: gate=nor_out, drain=out, source=VDD, body=VDD
      [5, 2, 4, 4],  // INV NI: gate=nor_out, drain=out, source=GND, body=GND
    ],
  };
}

// ---------------------------------------------------------------------------
// createCmosXor2
//
// Transmission-gate XOR: 8 MOSFETs (2 inverters + 2 transmission gates).
//
// Ports: In_1=0, In_2=1, out=2, VDD=3, GND=4
// Internal: A_bar=5, B_bar=6
// ---------------------------------------------------------------------------

export function createCmosXor2(): MnaSubcircuitNetlist {
  return {
    ports: ["In_1", "In_2", "out", "VDD", "GND"],
    elements: [
      { typeId: "PMOS", modelRef: "PMOS_DEFAULT" },  // A inverter PMOS
      { typeId: "NMOS", modelRef: "NMOS_DEFAULT" },  // A inverter NMOS
      { typeId: "PMOS", modelRef: "PMOS_DEFAULT" },  // B inverter PMOS
      { typeId: "NMOS", modelRef: "NMOS_DEFAULT" },  // B inverter NMOS
      { typeId: "NMOS", modelRef: "NMOS_DEFAULT" },  // TG1 NMOS: passes B→out when A=1
      { typeId: "PMOS", modelRef: "PMOS_DEFAULT" },  // TG1 PMOS: passes B→out when A=1
      { typeId: "NMOS", modelRef: "NMOS_DEFAULT" },  // TG2 NMOS: passes B_bar→out when A=0
      { typeId: "PMOS", modelRef: "PMOS_DEFAULT" },  // TG2 PMOS: passes B_bar→out when A=0
    ],
    internalNetCount: 2,
    netlist: [
      [0, 5, 3, 3],  // A inv PMOS: gate=A, drain=A_bar, source=VDD, body=VDD
      [0, 5, 4, 4],  // A inv NMOS: gate=A, drain=A_bar, source=GND, body=GND
      [1, 6, 3, 3],  // B inv PMOS: gate=B, drain=B_bar, source=VDD, body=VDD
      [1, 6, 4, 4],  // B inv NMOS: gate=B, drain=B_bar, source=GND, body=GND
      [0, 2, 1, 4],  // TG1 NMOS: gate=A, drain=out, source=B, body=GND
      [5, 2, 1, 3],  // TG1 PMOS: gate=A_bar, drain=out, source=B, body=VDD
      [5, 2, 6, 4],  // TG2 NMOS: gate=A_bar, drain=out, source=B_bar, body=GND
      [0, 2, 6, 3],  // TG2 PMOS: gate=A, drain=out, source=B_bar, body=VDD
    ],
  };
}

// ---------------------------------------------------------------------------
// createCmosXnor2
//
// XOR + output inverter. 10 MOSFETs total.
//
// Ports: In_1=0, In_2=1, out=2, VDD=3, GND=4
// Internal: A_bar=5, B_bar=6, xor_out=7
// ---------------------------------------------------------------------------

export function createCmosXnor2(): MnaSubcircuitNetlist {
  return {
    ports: ["In_1", "In_2", "out", "VDD", "GND"],
    elements: [
      { typeId: "PMOS", modelRef: "PMOS_DEFAULT" },  // A inverter PMOS
      { typeId: "NMOS", modelRef: "NMOS_DEFAULT" },  // A inverter NMOS
      { typeId: "PMOS", modelRef: "PMOS_DEFAULT" },  // B inverter PMOS
      { typeId: "NMOS", modelRef: "NMOS_DEFAULT" },  // B inverter NMOS
      { typeId: "NMOS", modelRef: "NMOS_DEFAULT" },  // TG1 NMOS
      { typeId: "PMOS", modelRef: "PMOS_DEFAULT" },  // TG1 PMOS
      { typeId: "NMOS", modelRef: "NMOS_DEFAULT" },  // TG2 NMOS
      { typeId: "PMOS", modelRef: "PMOS_DEFAULT" },  // TG2 PMOS
      { typeId: "PMOS", modelRef: "PMOS_DEFAULT" },  // output inverter PMOS
      { typeId: "NMOS", modelRef: "NMOS_DEFAULT" },  // output inverter NMOS
    ],
    internalNetCount: 3,
    netlist: [
      [0, 5, 3, 3],  // A inv PMOS: gate=A, drain=A_bar, source=VDD, body=VDD
      [0, 5, 4, 4],  // A inv NMOS: gate=A, drain=A_bar, source=GND, body=GND
      [1, 6, 3, 3],  // B inv PMOS: gate=B, drain=B_bar, source=VDD, body=VDD
      [1, 6, 4, 4],  // B inv NMOS: gate=B, drain=B_bar, source=GND, body=GND
      [0, 7, 1, 4],  // TG1 NMOS: gate=A, drain=xor_out, source=B, body=GND
      [5, 7, 1, 3],  // TG1 PMOS: gate=A_bar, drain=xor_out, source=B, body=VDD
      [5, 7, 6, 4],  // TG2 NMOS: gate=A_bar, drain=xor_out, source=B_bar, body=GND
      [0, 7, 6, 3],  // TG2 PMOS: gate=A, drain=xor_out, source=B_bar, body=VDD
      [7, 2, 3, 3],  // out inv PMOS: gate=xor_out, drain=out, source=VDD, body=VDD
      [7, 2, 4, 4],  // out inv NMOS: gate=xor_out, drain=out, source=GND, body=GND
    ],
  };
}

// ---------------------------------------------------------------------------
// createCmosBuffer
//
// Two inverters in series. 4 MOSFETs total.
//
// Ports: in=0, out=1, VDD=2, GND=3
// Internal: mid=4
// ---------------------------------------------------------------------------

export function createCmosBuffer(): MnaSubcircuitNetlist {
  return {
    ports: ["in", "out", "VDD", "GND"],
    elements: [
      { typeId: "PMOS", modelRef: "PMOS_DEFAULT" },  // INV1 PMOS
      { typeId: "NMOS", modelRef: "NMOS_DEFAULT" },  // INV1 NMOS
      { typeId: "PMOS", modelRef: "PMOS_DEFAULT" },  // INV2 PMOS
      { typeId: "NMOS", modelRef: "NMOS_DEFAULT" },  // INV2 NMOS
    ],
    internalNetCount: 1,
    netlist: [
      [0, 4, 2, 2],  // INV1 PMOS: gate=in, drain=mid, source=VDD, body=VDD
      [0, 4, 3, 3],  // INV1 NMOS: gate=in, drain=mid, source=GND, body=GND
      [4, 1, 2, 2],  // INV2 PMOS: gate=mid, drain=out, source=VDD, body=VDD
      [4, 1, 3, 3],  // INV2 NMOS: gate=mid, drain=out, source=GND, body=GND
    ],
  };
}

// ---------------------------------------------------------------------------
// registerBuiltinSubcircuitModels
//
// Creates and registers all CMOS gate subcircuit netlists in the
// SubcircuitModelRegistry. Called once at application startup or test setup.
// ---------------------------------------------------------------------------

export function registerBuiltinSubcircuitModels(modelRegistry: SubcircuitModelRegistry): void {
  modelRegistry.register("CmosInverter", createCmosInverter());
  modelRegistry.register("CmosNand2", createCmosNand2());
  modelRegistry.register("CmosNor2", createCmosNor2());
  modelRegistry.register("CmosAnd2", createCmosAnd2());
  modelRegistry.register("CmosOr2", createCmosOr2());
  modelRegistry.register("CmosXor2", createCmosXor2());
  modelRegistry.register("CmosXnor2", createCmosXnor2());
  modelRegistry.register("CmosBuffer", createCmosBuffer());
}
