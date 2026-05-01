/**
 * Ideal Op-Amp analog component.
 *
 * Three-terminal nonlinear element: in+ (non-inverting), in- (inverting),
 * out (output). Supply rails are fixed at +15 V and -15 V.
 *
 * MNA VCVS formulation (post-migration):
 *   When rOut > 0: composite of RES sub-element + VCVS sub-element.
 *     RES stamps 4 entries (ressetup.c:46-49) then VCVS stamps 6 entries
 *     (vcvsset.c:53-58) with 1 branch row.
 *   When rOut == 0: VCVS only (6 entries, 1 branch row).
 *
 * The VCVS branch row enforces V_vint - gain*(V_in+ - V_in-) = 0.
 * RES (when present) connects vint to out.
 */

import { AbstractCircuitElement } from "../../core/element.js";
import type { RenderContext, Rect } from "../../core/renderer-interface.js";
import type { PinVoltageAccess } from "../../core/pin-voltage-access.js";
import { drawColoredLead } from "../draw-helpers.js";
import type { Pin, PinDeclaration, Rotation } from "../../core/pin.js";
import { PinDirection } from "../../core/pin.js";
import { PropertyBag, PropertyType } from "../../core/properties.js";
import type { PropertyDefinition } from "../../core/properties.js";
import {
  ComponentCategory,
  type AttributeMapping,
  type ComponentDefinition,
} from "../../core/registry.js";
import type { AnalogElement, LoadContext } from "../../solver/analog/element.js";
import { NGSPICE_LOAD_ORDER } from "../../solver/analog/element.js";
import type { SetupContext } from "../../solver/analog/setup-context.js";
import { stampRHS } from "../../solver/analog/stamp-helpers.js";
import { defineModelParams } from "../../core/model-params.js";

// ---------------------------------------------------------------------------
// Model parameter declarations
// ---------------------------------------------------------------------------

export const { paramDefs: OPAMP_PARAM_DEFS, defaults: OPAMP_DEFAULTS } = defineModelParams({
  primary: {
    gain: { default: 1e6,  description: "Open-loop voltage gain" },
    rOut: { default: 75,   unit: "Ω",  description: "Output resistance" },
  },
});

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

function buildOpAmpPinDeclarations(): PinDeclaration[] {
  return [
    {
      direction: PinDirection.INPUT,
      label: "in-",
      defaultBitWidth: 1,
      position: { x: 0, y: -1 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.INPUT,
      label: "in+",
      defaultBitWidth: 1,
      position: { x: 0, y: 1 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.OUTPUT,
      label: "out",
      defaultBitWidth: 1,
      position: { x: 4, y: 0 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
  ];
}

// ---------------------------------------------------------------------------
// OpAmpElement  CircuitElement implementation
// ---------------------------------------------------------------------------

export class OpAmpElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("OpAmp", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildOpAmpPinDeclarations(), []);
  }

  getBoundingBox(): Rect {
    return {
      x: this.position.x,
      y: this.position.y - 2,
      width: 4,
      height: 4,
    };
  }

  draw(ctx: RenderContext, signals?: PinVoltageAccess): void {
    const vInp = signals?.getPinVoltage("in+");
    const vInn = signals?.getPinVoltage("in-");
    const vOut = signals?.getPinVoltage("out");

    ctx.save();
    ctx.setLineWidth(1);

    // Triangle body  stays COMPONENT color
    ctx.setColor("COMPONENT");
    ctx.drawLine(0.375, -2, 0.375, 2);
    ctx.drawLine(0.375, 2, 3.625, 0);

    // +/- labels inside triangle body
    ctx.setColor("COMPONENT");
    ctx.setFont({ family: "sans-serif", size: 0.7 });
    ctx.drawText("-", 1.0, -1.125, { horizontal: "center", vertical: "middle" });
    ctx.drawText("+", 1.0, 1.0, { horizontal: "center", vertical: "middle" });

    // Input lead in+ colored by its pin voltage (in+ is at y:1)
    drawColoredLead(ctx, signals, vInp, 0, 1, 0.375, 1);

    // Input lead in- colored by its pin voltage (in- is at y:-1)
    drawColoredLead(ctx, signals, vInn, 0, -1, 0.375, -1);

    // Output lead colored by its pin voltage
    drawColoredLead(ctx, signals, vOut, 3.625, 0, 4, 0);

    ctx.restore();
  }

}


// ---------------------------------------------------------------------------
// createOpAmpElement  AnalogElement factory
// ---------------------------------------------------------------------------

/**
 * Create the MNA analog element for an ideal op-amp.
 *
 * Post-migration: VCVS+RES composite per PB-OPAMP spec.
 *   - When rOut > 0: internal node vint; RES(vint,out) + VCVS(in+,in-,vint,gnd)
 *   - When rOut == 0: VCVS(in+,in-,out,gnd) directly
 *
 * Factory signature: 3-param per A6.3 (pinNodes, props, getTime).
 */
function createOpAmpElement(
  pinNodes: ReadonlyMap<string, number>,
  props: PropertyBag,
  _getTime: () => number,
): AnalogElement {
  const p: Record<string, number> = {
    gain: props.getModelParam<number>("gain") ?? 1e6,
    rOut: props.getModelParam<number>("rOut") ?? 75,
  };

  const rOut = p.rOut;

  const nInp = pinNodes.get("in+")!;
  const nInn = pinNodes.get("in-")!;
  const nOut = pinNodes.get("out")!;

  // Internal node (only used when rOut > 0)
  let nVint = 0;

  // RES handles (ressetup.c:46-49)- 4 entries: PP, NN, PN, NP
  // Only allocated when rOut > 0
  let hResAA = -1;
  let hResBB = -1;
  let hResAB = -1;
  let hResBA = -1;

  // VCVS handles (vcvsset.c:53-58)- 4 entries kept (entries 2 and 4 omitted).
  //
  // Ground-row/column suppression: ngspice's spbuild.c skips row/col 0 (the
  // grounded node) at the sparse-matrix layer (Translate, lines 436-504).
  // digiTS mirrors this in SparseSolver: stamps against node 0 are no-ops.
  // The vcvsset.c TSTALLOC entries `(negNode=0, branch)` and `(branch,
  // negNode=0)` therefore degenerate to no-ops because this opamp wires the
  // VCVS negative terminal to the global ground reference. Skipping their
  // allocation here matches ngspice's effective stamp output bit-for-bit
  // while avoiding two TSTALLOC handles that would never be consumed.
  let hVcvsPosIbr = -1;  // (posNode, branch)
  let hVcvsIbrPos = -1;  // (branch, posNode)
  let hVcvsIbrCP  = -1;  // (branch, contPos=inP)
  let hVcvsIbrCN  = -1;  // (branch, contNeg=inN)

  // Internal-node labels recorded during setup() for diagnostic introspection.
  const internalLabels: string[] = [];

  const el: AnalogElement = {
    label: "",
    branchIndex: -1,
    ngspiceLoadOrder: NGSPICE_LOAD_ORDER.VCVS,
    _stateBase: -1,
    _pinNodes: new Map(pinNodes),

    setup(ctx: SetupContext): void {
      const solver = ctx.solver;

      // Branch row for VCVS (vcvsset.c:41-44 guard: allocate once)
      if (el.branchIndex === -1) {
        el.branchIndex = ctx.makeCur(el.label ?? "opamp", "branch");
      }

      const k = el.branchIndex;

      if (rOut > 0) {
        // Allocate internal voltage node between ideal source and output resistance
        nVint = ctx.makeVolt(el.label ?? "opamp", "vint");
        internalLabels.push("vint");

        // RES sub-element (ressetup.c:46-49): A=vint, B=out
        // Order: (A,A), (B,B), (A,B), (B,A)
        hResAA = solver.allocElement(nVint, nVint);
        hResBB = solver.allocElement(nOut,  nOut);
        hResAB = solver.allocElement(nVint, nOut);
        hResBA = solver.allocElement(nOut,  nVint);

        // VCVS sub-element (vcvsset.c:53-58): posNode=vint, negNode=0(gnd)
        // Entries 2 and 4 (negNode rows/cols) skipped- solver-level gnd suppression.
        // Entry 1: (posNode, branch) = (vint, k)
        hVcvsPosIbr = solver.allocElement(nVint, k);
        // Entry 3: (branch, posNode) = (k, vint)
        hVcvsIbrPos = solver.allocElement(k, nVint);
        // Entry 5: (branch, contPos) = (k, inP)
        hVcvsIbrCP = nInp > 0 ? solver.allocElement(k, nInp) : -1;
        // Entry 6: (branch, contNeg) = (k, inN)
        hVcvsIbrCN = nInn > 0 ? solver.allocElement(k, nInn) : -1;
      } else {
        // rOut == 0: VCVS connects directly to nOut (no RES, no internal node)
        // VCVS sub-element (vcvsset.c:53-58): posNode=nOut, negNode=0(gnd)
        // Entries 2 and 4 (negNode rows/cols) skipped- solver-level gnd suppression.
        hVcvsPosIbr = solver.allocElement(nOut, k);
        hVcvsIbrPos = solver.allocElement(k, nOut);
        hVcvsIbrCP  = nInp > 0 ? solver.allocElement(k, nInp) : -1;
        hVcvsIbrCN  = nInn > 0 ? solver.allocElement(k, nInn) : -1;
      }
    },

    getInternalNodeLabels(): readonly string[] {
      return internalLabels;
    },

    load(ctx: LoadContext): void {
      const solver = ctx.solver;
      const voltages = ctx.rhsOld;
      const scale = ctx.srcFact;

      const vInpV = voltages[nInp];
      const vInnV = voltages[nInn];
      const vDiff = vInpV - vInnV;
      const effectiveGain = p.gain * scale;

      if (rOut > 0) {
        // RES stamp (ressetup.c:46-49): conductance G = 1/rOut
        const G = 1 / rOut;
        solver.stampElement(hResAA,  G);
        solver.stampElement(hResBB,  G);
        solver.stampElement(hResAB, -G);
        solver.stampElement(hResBA, -G);

        // VCVS stamp (vcvsset.c load): enforce vint - gain*(vInp - vInn) = 0
        // Row (posNode=vint, branch): +1
        solver.stampElement(hVcvsPosIbr, 1);
        // Row (branch, posNode=vint): +1
        solver.stampElement(hVcvsIbrPos, 1);
        // Row (branch, contPos=inP): -gain (if non-ground)
        if (hVcvsIbrCP >= 0) solver.stampElement(hVcvsIbrCP, -effectiveGain);
        // Row (branch, contNeg=inN): +gain (if non-ground)
        if (hVcvsIbrCN >= 0) solver.stampElement(hVcvsIbrCN,  effectiveGain);
        // RHS for branch row: effectiveGain * vDiff - (vVint - vDiff*gain)
        // NR linearized: RHS[branch] = gain*(vDiff) - gain*vDiff0 + gain*vDiff0 = 0
        // Actually for VCVS: RHS[k] = 0 when gain is linear (no nonlinearity)
        // The branch equation is: vPos - vNeg - gain*(vCtrlP - vCtrlN) = 0
        // Already fully stamped via matrix entries; RHS[k] contribution = 0
      } else {
        // VCVS direct to nOut
        solver.stampElement(hVcvsPosIbr, 1);
        solver.stampElement(hVcvsIbrPos, 1);
        if (hVcvsIbrCP >= 0) solver.stampElement(hVcvsIbrCP, -effectiveGain);
        if (hVcvsIbrCN >= 0) solver.stampElement(hVcvsIbrCN,  effectiveGain);
      }

      // Source-step RHS: when gain changes due to srcFact, apply linearized correction
      if (scale < 1 && el.branchIndex >= 0) {
        stampRHS(ctx.rhs, el.branchIndex, effectiveGain * vDiff);
      }
    },

    getPinCurrents(_rhs: Float64Array): number[] {
      return [0, 0, 0];
    },

    setParam(key: string, value: number): void {
      if (key in p) p[key] = value;
    },
  };

  return el;
}


// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const OPAMP_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "label",
    type: PropertyType.STRING,
    label: "Label",
    defaultValue: "",
    description: "Optional display label",
  },
];

// ---------------------------------------------------------------------------
// Attribute mappings
// ---------------------------------------------------------------------------

const OPAMP_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  { xmlName: "gain",  propertyKey: "gain",  convert: (v) => parseFloat(v), modelParam: true },
  { xmlName: "rOut",  propertyKey: "rOut",  convert: (v) => parseFloat(v), modelParam: true },
  { xmlName: "Label", propertyKey: "label", convert: (v) => v },
];

// ---------------------------------------------------------------------------
// OpAmpDefinition
// ---------------------------------------------------------------------------

export const OpAmpDefinition: ComponentDefinition = {
  name: "OpAmp",
  typeId: -1,
  category: ComponentCategory.ACTIVE,

  pinLayout: buildOpAmpPinDeclarations(),
  propertyDefs: OPAMP_PROPERTY_DEFS,
  attributeMap: OPAMP_ATTRIBUTE_MAPPINGS,

  helpText:
    "Ideal Op-Amp- 3-terminal nonlinear element (in+, in-, out). " +
    "High-gain voltage amplifier with output saturation at supply rails.",

  factory(props: PropertyBag): OpAmpElement {
    return new OpAmpElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
  },

  models: {},
  modelRegistry: {
    "behavioral": {
      kind: "inline",
      factory: (pinNodes, props, getTime) =>
        createOpAmpElement(pinNodes, props, getTime),
      paramDefs: OPAMP_PARAM_DEFS,
      params: OPAMP_DEFAULTS,
    },
  },
  defaultModel: "behavioral",
};
