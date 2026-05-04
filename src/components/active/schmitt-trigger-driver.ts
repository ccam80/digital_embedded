/**
 * SchmittTriggerDriver — internal-only hybrid pin+stamp+state driver leaf for
 * the Schmitt Trigger composite (both inverting and non-inverting variants).
 *
 * Per Composite M28 (phase-composite-architecture.md), J-028
 * (contracts_group_02.md). Emitted by `SchmittInvertingDefinition` and
 * `SchmittNonInvertingDefinition` parent netlists (schmitt-trigger.ts) as the
 * single sub-element `drv` in both SCHMITT_INVERTING_NETLIST and
 * SCHMITT_NON_INVERTING_NETLIST.
 *
 * Canonical Template D exemplar: hysteresis-based level detection with a
 * Norton conductance stamp on the output (nDrive) node. Reads input voltage
 * from `rhsOld`, applies hysteresis to update OUTPUT_LATCH, then stamps a
 * stiff Norton source driving `out` toward vOH or vOL relative to `gnd`.
 *
 * Schema: SCHMITT_TRIGGER_SCHEMA is owned by this driver (the parent composite
 * has no MNA math and declares no schema of its own). One slot: OUTPUT_LATCH.
 *
 * Spec assumptions made explicit (J-028):
 *   1. Hysteresis (from schmitt-trigger.ts top-of-file docstring):
 *        Output goes HIGH when input rises above vTH.
 *        Output goes LOW  when input falls below vTL.
 *        Between thresholds, output holds previous state.
 *   2. Inverting flag: when inverting=1, the latch sense is flipped —
 *        input BELOW vTL  → latch HIGH (output vOH).
 *        input ABOVE vTH  → latch LOW  (output vOL).
 *        Non-inverting (inverting=0) uses the direct sense.
 *   3. Stamp model: two-node Norton source between `out` and `gnd`.
 *        G_drive = 1 / R_NORTON (stiff conductance, not rOut — rOut is handled
 *        by the parent's separate Resistor sub-element). Stamps conductance on
 *        (out,out) (out,gnd) (gnd,out) (gnd,gnd) plus RHS current injection.
 *        Target voltage vTarget = latch ? vOH : vOL.
 *        I_Norton = G_drive * vTarget (equivalent Norton current at out node).
 *   4. `rOut` from the parent's param set is NOT a driver param — it is wired
 *        to the Resistor sub-element in the netlist. The driver's internal
 *        Norton conductance uses a fixed stiff value (R_NORTON = 1e-3 Ω).
 *   5. Bottom-of-load history write: OUTPUT_LATCH written to s0 exactly once.
 */

import { AbstractPoolBackedAnalogElement, type AnalogElement } from "../../solver/analog/element.js";
import type { LoadContext } from "../../solver/analog/load-context.js";
import type { SetupContext } from "../../solver/analog/setup-context.js";
import { NGSPICE_LOAD_ORDER } from "../../solver/analog/ngspice-load-order.js";
import { defineStateSchema } from "../../solver/analog/state-schema.js";
import { PinDirection, type PinDeclaration } from "../../core/pin.js";
import { PropertyBag } from "../../core/properties.js";
import type { ComponentDefinition, ParamDef } from "../../core/registry.js";

// ---------------------------------------------------------------------------
// State schema — owned by this driver.
// ---------------------------------------------------------------------------

export const SCHMITT_TRIGGER_SCHEMA = defineStateSchema("SchmittTriggerDriverElement", [
  {
    name: "OUTPUT_LATCH",
    doc: "Last committed output level: 1.0 = HIGH (vOH), 0.0 = LOW (vOL). Holds state between thresholds.",
  },
]);

// ---------------------------------------------------------------------------
// Slot constant — resolved from the driver-owned schema.
// ---------------------------------------------------------------------------

const SLOT_OUTPUT_LATCH = SCHMITT_TRIGGER_SCHEMA.indexOf.get("OUTPUT_LATCH")!;

// ---------------------------------------------------------------------------
// Pin layout — mirrors the parent netlist connectivity row [0, 3, 2]:
//   pin 0 = in   (input voltage, read-only)
//   pin 1 = out  (nDrive node, Norton-stamped)
//   pin 2 = gnd  (reference node for Norton source)
// ---------------------------------------------------------------------------

const SCHMITT_TRIGGER_DRIVER_PIN_LAYOUT: PinDeclaration[] = [
  { direction: PinDirection.INPUT,  label: "in",  defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.OUTPUT, label: "out", defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.INPUT,  label: "gnd", defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
];

// ---------------------------------------------------------------------------
// Param defs — internal-only mirror of the parent's netlist param surface.
// ---------------------------------------------------------------------------

const SCHMITT_TRIGGER_DRIVER_PARAM_DEFS: ParamDef[] = [
  { key: "vTH",       default: 2.0 },
  { key: "vTL",       default: 1.0 },
  { key: "vOH",       default: 3.3 },
  { key: "vOL",       default: 0.0 },
  { key: "inverting", default: 0   },
];

const SCHMITT_TRIGGER_DRIVER_DEFAULTS: Record<string, number> = {
  vTH:       2.0,
  vTL:       1.0,
  vOH:       3.3,
  vOL:       0.0,
  inverting: 0,
};

// Stiff Norton conductance: drives nDrive to vOH/vOL through 1 mΩ equivalent.
const G_NORTON = 1 / 1e-3;

// ---------------------------------------------------------------------------
// SchmittTriggerDriverElement
// ---------------------------------------------------------------------------

export class SchmittTriggerDriverElement extends AbstractPoolBackedAnalogElement {
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.BEHAVIORAL;
  readonly stateSchema = SCHMITT_TRIGGER_SCHEMA;
  readonly stateSize = SCHMITT_TRIGGER_SCHEMA.size;

  private _vTH: number;
  private _vTL: number;
  private _vOH: number;
  private _vOL: number;
  private _inverting: number;

  // Four matrix handles for the two-node Norton stamp: (out,out), (out,gnd),
  // (gnd,out), (gnd,gnd). Any handle whose node is ground (node 0) stays -1.
  private _hOutOut  = -1;
  private _hOutGnd  = -1;
  private _hGndOut  = -1;
  private _hGndGnd  = -1;

  constructor(pinNodes: ReadonlyMap<string, number>, props: PropertyBag) {
    super(pinNodes);
    this._vTH       = props.hasModelParam("vTH")       ? props.getModelParam<number>("vTH")       : SCHMITT_TRIGGER_DRIVER_DEFAULTS["vTH"]!;
    this._vTL       = props.hasModelParam("vTL")       ? props.getModelParam<number>("vTL")        : SCHMITT_TRIGGER_DRIVER_DEFAULTS["vTL"]!;
    this._vOH       = props.hasModelParam("vOH")       ? props.getModelParam<number>("vOH")       : SCHMITT_TRIGGER_DRIVER_DEFAULTS["vOH"]!;
    this._vOL       = props.hasModelParam("vOL")       ? props.getModelParam<number>("vOL")       : SCHMITT_TRIGGER_DRIVER_DEFAULTS["vOL"]!;
    this._inverting = props.hasModelParam("inverting") ? props.getModelParam<number>("inverting") : SCHMITT_TRIGGER_DRIVER_DEFAULTS["inverting"]!;
  }

  setup(ctx: SetupContext): void {
    this._stateBase = ctx.allocStates(this.stateSize);
    const outNode = this._pinNodes.get("out")!;
    const gndNode = this._pinNodes.get("gnd")!;
    if (outNode !== 0)                         this._hOutOut = ctx.solver.allocElement(outNode, outNode);
    if (outNode !== 0 && gndNode !== 0)        this._hOutGnd = ctx.solver.allocElement(outNode, gndNode);
    if (gndNode !== 0 && outNode !== 0)        this._hGndOut = ctx.solver.allocElement(gndNode, outNode);
    if (gndNode !== 0)                         this._hGndGnd = ctx.solver.allocElement(gndNode, gndNode);
  }

  setParam(key: string, value: number): void {
    switch (key) {
      case "vTH":       this._vTH       = value; break;
      case "vTL":       this._vTL       = value; break;
      case "vOH":       this._vOH       = value; break;
      case "vOL":       this._vOL       = value; break;
      case "inverting": this._inverting = value; break;
    }
  }

  /**
   * load() — hybrid Template D shape.
   *
   * Reads input voltage from rhsOld, applies hysteresis using s1[OUTPUT_LATCH]
   * as the prior committed level, then stamps a stiff Norton source on (out,gnd)
   * to drive nDrive toward the target voltage. Bottom-of-load writes latchNew
   * to s0[OUTPUT_LATCH].
   */
  load(ctx: LoadContext): void {
    const rhsOld = ctx.rhsOld;
    const s0 = this._pool.states[0];
    const s1 = this._pool.states[1];
    const base = this._stateBase;

    const vIn  = rhsOld[this._pinNodes.get("in")!];

    // Hysteresis: compare against thresholds using prior latch level.
    const latchOld = s1[base + SLOT_OUTPUT_LATCH] >= 0.5 ? 1 : 0;
    let latchNew: number = latchOld;
    if (latchOld === 0 && vIn >= this._vTH) latchNew = 1;
    else if (latchOld === 1 && vIn < this._vTL)  latchNew = 0;

    // Inverting: flip the output sense when inverting=1.
    const outputHigh = this._inverting >= 0.5 ? (latchNew === 0 ? 1 : 0) : latchNew;

    // Target voltage and Norton stamp.
    // Norton equivalent: I_src = G * vTarget injected at out, sunk at gnd.
    // G stamped on (out,out) and (gnd,gnd); -G on (out,gnd) and (gnd,out).
    const vTarget = outputHigh ? this._vOH : this._vOL;
    const iNorton = G_NORTON * vTarget;

    if (this._hOutOut  !== -1) ctx.solver.stampElement(this._hOutOut,   G_NORTON);
    if (this._hOutGnd  !== -1) ctx.solver.stampElement(this._hOutGnd,  -G_NORTON);
    if (this._hGndOut  !== -1) ctx.solver.stampElement(this._hGndOut,  -G_NORTON);
    if (this._hGndGnd  !== -1) ctx.solver.stampElement(this._hGndGnd,   G_NORTON);

    const outNode = this._pinNodes.get("out")!;
    const gndNode = this._pinNodes.get("gnd")!;
    if (outNode !== 0) ctx.rhs[outNode] += iNorton;
    if (gndNode !== 0) ctx.rhs[gndNode] -= iNorton;

    // Bottom-of-load write.
    s0[base + SLOT_OUTPUT_LATCH] = latchNew;
  }

  getPinCurrents(rhs: Float64Array): number[] {
    const outNode = this._pinNodes.get("out")!;
    const gndNode = this._pinNodes.get("gnd")!;
    const s1 = this._pool.states[1];
    const latchOld = s1[this._stateBase + SLOT_OUTPUT_LATCH] >= 0.5 ? 1 : 0;
    const outputHigh = this._inverting >= 0.5 ? (latchOld === 0 ? 1 : 0) : latchOld;
    const vTarget = outputHigh ? this._vOH : this._vOL;
    const vOut = rhs[outNode];
    const vGnd = gndNode !== 0 ? rhs[gndNode] : 0;
    const I = G_NORTON * (vOut - vGnd - vTarget);
    // in is a pure read; out sources I; gnd sinks I.
    return [0, I, -I];
  }
}

// ---------------------------------------------------------------------------
// ComponentDefinition
// ---------------------------------------------------------------------------

export const SchmittTriggerDriverDefinition: ComponentDefinition = {
  name: "SchmittTriggerDriver",
  typeId: -1,
  internalOnly: true,
  pinLayout: SCHMITT_TRIGGER_DRIVER_PIN_LAYOUT,
  modelRegistry: {
    default: {
      kind: "inline",
      paramDefs: SCHMITT_TRIGGER_DRIVER_PARAM_DEFS,
      params: SCHMITT_TRIGGER_DRIVER_DEFAULTS,
      factory: (pinNodes: ReadonlyMap<string, number>, props: PropertyBag, _getTime: () => number): AnalogElement =>
        new SchmittTriggerDriverElement(pinNodes, props),
    },
  },
  defaultModel: "default",
};
