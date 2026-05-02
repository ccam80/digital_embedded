import type { MnaSubcircuitNetlist } from "../../core/mna-subcircuit-netlist.js";
import type { ComponentDefinition } from "../../core/registry.js";

/**
 * DigitalOutputPinLoaded- behaviourally-driven analog output port with RC load.
 *
 * Topology after the Norton refactor (see behavioral-output-driver.ts):
 *   drv  : BehavioralOutputDriver(pos=node, neg=gnd)
 *           - stamps Norton-equivalent (current source + shunt 1/rOut conductance)
 *             directly at the external node
 *           - when its optional `enableLogic` siblingState ref reads disabled,
 *             swaps to a 1 GΩ shunt with zero current → effective tri-state
 *   cOut : Capacitor(pos=node, neg=gnd) → output load capacitance for RC dynamics
 *
 * Tri-state plumbing: the parent composite (e.g. Driver / DriverInvSel) wires
 * `enableLogic: { kind: "siblingState", subElementName: "drv", slotName:
 * "OUTPUT_LOGIC_LEVEL_ENABLE" }` in this subcircuit's params; the compiler's
 * siblingState resolver writes the resolved PoolSlotRef into the inner drv's
 * PropertyBag, where BehavioralOutputDriver picks it up. Non-tri-state
 * consumers (gates, flipflops, mux, counter, register, etc.) omit the
 * enableLogic param entirely- driver defaults to permanently enabled.
 *
 * Parent composite's behavioural driver leaf must expose a stateSchema slot
 * named OUTPUT_LOGIC_LEVEL (single-bit) or a packed multi-bit value slot
 * (multi-bit). Parent's netlist injects the resolved siblingState ref for
 * `inputLogic` (and optionally `enableLogic`).
 *
 * bitIndex (per A1, defaults to 0): selects which bit of the sibling slot's
 * value this pin represents. Single-bit drivers leave it at 0 and write
 * 0.0/1.0 to the slot. Multi-bit drivers (counter, register, seven-seg)
 * write a packed integer; the parent emits N pin instances with bitIndex:
 * 0..N-1, each binding to the same sibling slot.
 */
export const DIGITAL_OUTPUT_PIN_LOADED_NETLIST: MnaSubcircuitNetlist = {
  ports: ["node", "gnd"],
  params: { rOut: 100, cOut: 1e-12, vOH: 5, vOL: 0, bitIndex: 0 },
  elements: [
    { typeId: "BehavioralOutputDriver", modelRef: "default", subElementName: "drv",
      params: { vOH: "vOH", vOL: "vOL", rOut: "rOut", bitIndex: "bitIndex" /* inputLogic + optional enableLogic injected by parent */ } },
    { typeId: "Capacitor", modelRef: "default", subElementName: "cOut", params: { C: "cOut" } },
  ],
  internalNetCount: 0,
  netlist: [
    [0, 1],   // drv:  pos=node, neg=gnd
    [0, 1],   // cOut: pos=node, neg=gnd
  ],
};

export const DigitalOutputPinLoadedDefinition: ComponentDefinition = {
  name: "DigitalOutputPinLoaded",
  typeId: -1,
  internalOnly: true,
  modelRegistry: {
    default: {
      kind: "netlist",
      netlist: DIGITAL_OUTPUT_PIN_LOADED_NETLIST,
      paramDefs: [
        { key: "rOut",     default: 100 },
        { key: "cOut",     default: 1e-12 },
        { key: "vOH",      default: 5 },
        { key: "vOL",      default: 0 },
        { key: "bitIndex", default: 0 },
        // `inputLogic` and (optional) `enableLogic` are siblingState ref objects
        // wired by the parent composite; not numeric ParamDefs.
      ],
      params: { rOut: 100, cOut: 1e-12, vOH: 5, vOL: 0, bitIndex: 0 },
    },
  },
  defaultModel: "default",
};
