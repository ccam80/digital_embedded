/**
 * Triac analog component â€” bidirectional thyristor.
 *
 * Implements two anti-parallel SCR paths sharing a gate terminal.
 * Conducts in both directions when triggered by gate current, and latches
 * until the main terminal current crosses zero (drops below I_hold).
 *
 * Terminal convention:
 *   MT1 â€” Main Terminal 1 (reference terminal for gate control)
 *   MT2 â€” Main Terminal 2
 *   G   â€” Gate
 *
 * Model: two independent latch states (forward path MT2â†’MT1, reverse path MT1â†’MT2).
 * The active path is selected based on the sign of V_MT2-MT1. Gate current in
 * either polarity triggers the corresponding SCR path.
 *
 * LATCHED slot encoding: 1.0 = forward path latched, -1.0 = reverse path latched,
 * 0.0 = neither latched. Forward and reverse are mutually exclusive.
 */

import { AbstractCircuitElement } from "../../core/element.js";
import type { RenderContext, Rect } from "../../core/renderer-interface.js";
import type { PinVoltageAccess } from "../../core/pin-voltage-access.js";
import { drawColoredLead } from "../draw-helpers.js";
import type { Pin, PinDeclaration, Rotation } from "../../core/pin.js";
import { PinDirection } from "../../core/pin.js";
import { PropertyBag, LABEL_PROPERTY_DEF } from "../../core/properties.js";
import type { PropertyDefinition } from "../../core/properties.js";
import {
  ComponentCategory,
  type AttributeMapping,
  type ComponentDefinition,
} from "../../core/registry.js";
import type { PoolBackedAnalogElementCore, LoadContext } from "../../solver/analog/element.js";
import { NGSPICE_LOAD_ORDER } from "../../solver/analog/element.js";
import { stampG, stampRHS } from "../../solver/analog/stamp-helpers.js";
import { pnjlim } from "../../solver/analog/newton-raphson.js";
import { defineModelParams } from "../../core/model-params.js";
import type { StatePoolRef } from "../../core/analog-types.js";
import { VT } from "../../core/constants.js";
import { defineStateSchema, applyInitialValues } from "../../solver/analog/state-schema.js";
import { MODEINITJCT } from "../../solver/analog/ckt-mode.js";

// ---------------------------------------------------------------------------
// Physical constants
// ---------------------------------------------------------------------------

// VT (thermal voltage) imported from ../../core/constants.js

/** Minimum conductance for numerical stability (GMIN). */
const GMIN = 1e-12;

/** Maximum alpha value â€” prevents division-by-zero. */
const ALPHA_MAX = 0.95;

// ---------------------------------------------------------------------------
// State pool slot indices
// ---------------------------------------------------------------------------

const SLOT_VAK        = 0; // V_MT2 - V_MT1 (main terminal voltage, pnjlim-limited)
const SLOT_VGK        = 1; // V_G - V_MT1 (gate-MT1 voltage, pnjlim-limited)
const SLOT_GEQ        = 2;
const SLOT_IEQ        = 3;
const SLOT_G_GATE_GEQ = 4;
const SLOT_G_GATE_IEQ = 5;
const SLOT_LATCHED    = 6; // 1.0 = fwd latched, -1.0 = rev latched, 0.0 = none
const SLOT_IAK        = 7;
const SLOT_IGK        = 8;

// ---------------------------------------------------------------------------
// Model parameter declarations
// ---------------------------------------------------------------------------

export const { paramDefs: TRIAC_PARAM_DEFS, defaults: TRIAC_PARAM_DEFAULTS } = defineModelParams({
  primary: {
    vOn:  { default: 1.5,   unit: "V", description: "On-state forward voltage drop" },
    iH:   { default: 10e-3, unit: "A", description: "Holding current â€” minimum main current to stay on" },
    rOn:  { default: 0.01,  unit: "Î©", description: "On-state series resistance" },
    iS:   { default: 1e-12, unit: "A", description: "Reverse saturation current" },
  },
  secondary: {
    alpha1:   { default: 0.5,  description: "PNP transistor current gain (fixed)" },
    alpha2_0: { default: 0.3,  description: "NPN off-state current gain" },
    i_ref:    { default: 1e-3, unit: "A", description: "Gate current scale factor for Î±â‚‚ modulation" },
    n:        { default: 1,               description: "Emission coefficient" },
  },
});

// ---------------------------------------------------------------------------
// State schema declaration
// ---------------------------------------------------------------------------

const TRIAC_STATE_SCHEMA = defineStateSchema("TriacElement", [
  { name: "VAK", doc: "MT2-MT1 voltage, pnjlim-limited (V)", init: { kind: "zero" } },
  { name: "VGK", doc: "Gate-MT1 voltage, pnjlim-limited (V)", init: { kind: "zero" } },
  { name: "GEQ", doc: "Linearized MT1-MT2 conductance (S)", init: { kind: "constant", value: 1e-12 } },
  { name: "IEQ", doc: "Linearized MT1-MT2 current source (A)", init: { kind: "zero" } },
  { name: "G_GATE_GEQ", doc: "Gate junction conductance (S)", init: { kind: "constant", value: 1e-12 } },
  { name: "G_GATE_IEQ", doc: "Gate junction current source (A)", init: { kind: "zero" } },
  { name: "LATCHED", doc: "Latch state (1.0=fwd, -1.0=rev, 0.0=none)", init: { kind: "zero" } },
  { name: "IAK", doc: "Main terminal current (A)", init: { kind: "zero" } },
  { name: "IGK", doc: "Gate current (A)", init: { kind: "zero" } },
]);

// ---------------------------------------------------------------------------
// Stamp helpers â€” node 0 is ground (skipped)
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// createTriacElement â€” AnalogElement factory
// ---------------------------------------------------------------------------

export function createTriacElement(
  pinNodes: ReadonlyMap<string, number>,
  _internalNodeIds: readonly number[],
  _branchIdx: number,
  props: PropertyBag,
): PoolBackedAnalogElementCore {
  const nodeMT2 = pinNodes.get("MT2")!; // Main Terminal 2
  const nodeMT1 = pinNodes.get("MT1")!; // Main Terminal 1
  const nodeG   = pinNodes.get("G")!;   // Gate

  const p = {
    vOn:      props.getModelParam<number>("vOn"),
    iH:       props.getModelParam<number>("iH"),
    rOn:      props.getModelParam<number>("rOn"),
    iS:       props.getModelParam<number>("iS"),
    alpha1:   props.getModelParam<number>("alpha1"),
    alpha2_0: props.getModelParam<number>("alpha2_0"),
    i_ref:    props.getModelParam<number>("i_ref"),
    n:        props.getModelParam<number>("n"),
  };

  let nVt = p.n * VT;
  let vcritMain = nVt * Math.log(nVt / (p.iS * Math.SQRT2));
  let vcritGate = nVt * Math.log(nVt / (p.iS * Math.SQRT2));

  // Pool reference â€” set by initState. State arrays accessed via pool.states[N]
  // at call time inside load(). No cached Float64Array refs.
  let pool: StatePoolRef;
  let base: number;

  // Ephemeral per-iteration pnjlim limiting flag
  let pnjlimLimited = false;

  function recomputeDerivedConstants(): void {
    nVt = p.n * VT;
    vcritMain = nVt * Math.log(nVt / (p.iS * Math.SQRT2));
    vcritGate = nVt * Math.log(nVt / (p.iS * Math.SQRT2));
  }

  function computeAlpha2(iGate: number): number {
    const raw = 1 - (1 - p.alpha2_0) * Math.exp(-Math.abs(iGate) / p.i_ref);
    return Math.min(raw, ALPHA_MAX);
  }

  function computeOnState(s0: Float64Array, vmt: number): void {
    const gOn = 1.0 / p.rOn;
    const iOn = (vmt - p.vOn) / p.rOn;
    s0[base + SLOT_GEQ] = gOn + GMIN;
    s0[base + SLOT_IEQ] = iOn - s0[base + SLOT_GEQ] * vmt;
  }

  function computeBlockingState(s0: Float64Array): void {
    s0[base + SLOT_GEQ] = GMIN;
    s0[base + SLOT_IEQ] = 0;
  }

  function computeOperatingPoint(s0: Float64Array, vmt: number, vg1: number): void {
    // Gate current (forward-biased gate-MT1 junction)
    const iGate = p.iS * (Math.exp(vg1 / nVt) - 1) + GMIN * vg1;

    const a2 = computeAlpha2(iGate);
    const a1c = Math.min(p.alpha1, ALPHA_MAX);
    const a2c = Math.min(a2, ALPHA_MAX);
    const alphaSum = a1c + a2c;
    const triggered = alphaSum > 0.95;

    const latched = s0[base + SLOT_LATCHED];

    if (vmt >= 0) {
      // Forward path (MT2â†’MT1)
      if (latched !== 1.0 && triggered) {
        s0[base + SLOT_LATCHED] = 1.0;
      }
      if (s0[base + SLOT_LATCHED] === 1.0) {
        computeOnState(s0, vmt);
        const iMt = s0[base + SLOT_GEQ] * vmt + s0[base + SLOT_IEQ];
        s0[base + SLOT_IAK] = iMt;
        if (iMt < p.iH) {
          s0[base + SLOT_LATCHED] = 0.0;
          computeBlockingState(s0);
          s0[base + SLOT_IAK] = GMIN * vmt;
        }
      } else {
        computeBlockingState(s0);
        s0[base + SLOT_IAK] = GMIN * vmt;
      }
      // Reset reverse latch when polarity changes
      if (s0[base + SLOT_LATCHED] === -1.0) {
        s0[base + SLOT_LATCHED] = 0.0;
      }
    } else {
      // Reverse path (MT1â†’MT2, vmt < 0)
      if (latched !== -1.0 && triggered) {
        s0[base + SLOT_LATCHED] = -1.0;
      }
      if (s0[base + SLOT_LATCHED] === -1.0) {
        // Mirror: current flows MT1â†’MT2, V_drop = -V_on
        const gOn = 1.0 / p.rOn;
        const iOn = (vmt + p.vOn) / p.rOn;
        s0[base + SLOT_GEQ] = gOn + GMIN;
        s0[base + SLOT_IEQ] = iOn - s0[base + SLOT_GEQ] * vmt;
        const iMt = s0[base + SLOT_GEQ] * vmt + s0[base + SLOT_IEQ];
        s0[base + SLOT_IAK] = iMt;
        if (iMt > -p.iH) {
          s0[base + SLOT_LATCHED] = 0.0;
          computeBlockingState(s0);
          s0[base + SLOT_IAK] = GMIN * vmt;
        }
      } else {
        computeBlockingState(s0);
        s0[base + SLOT_IAK] = GMIN * vmt;
      }
      // Reset forward latch when polarity changes
      if (s0[base + SLOT_LATCHED] === 1.0) {
        s0[base + SLOT_LATCHED] = 0.0;
      }
    }

    // Gate junction: linearized at (already pnjlim-limited) vg1
    const expVg = Math.exp(vg1 / nVt);
    const gGate = (p.iS * expVg) / nVt + GMIN;
    const iGateCurrent = p.iS * (expVg - 1);
    s0[base + SLOT_G_GATE_GEQ] = gGate;
    s0[base + SLOT_G_GATE_IEQ] = iGateCurrent - gGate * vg1;
    s0[base + SLOT_IGK] = iGateCurrent;
  }

  return {
    branchIndex: -1,
    ngspiceLoadOrder: NGSPICE_LOAD_ORDER.DIO,
    isNonlinear: true,
    isReactive: false,
    poolBacked: true as const,
    stateSize: 9,
    stateSchema: TRIAC_STATE_SCHEMA,
    stateBaseOffset: -1,
    s0: new Float64Array(0),
    s1: new Float64Array(0),
    s2: new Float64Array(0),
    s3: new Float64Array(0),
    s4: new Float64Array(0),
    s5: new Float64Array(0),
    s6: new Float64Array(0),
    s7: new Float64Array(0),

    initState(poolRef: StatePoolRef): void {
      pool = poolRef;
      base = this.stateBaseOffset;
      applyInitialValues(TRIAC_STATE_SCHEMA, pool, base, {});
    },

    load(ctx: LoadContext): void {
      // Access state arrays at call time â€” no cached Float64Array refs.
      const s0 = pool.states[0];

      const voltages = ctx.rhsOld;
      const v1 = voltages[nodeMT1];
      const v2 = voltages[nodeMT2];
      const vG = voltages[nodeG];

      const vmtRaw = v2 - v1;
      const vg1Raw = vG - v1;

      let vmtLimited: number;
      let vg1Limited: number;
      let vmtWasLimited = false;
      let vg1WasLimited = false;
      if (ctx.cktMode & MODEINITJCT) {
        // Triac MODEINITJCT: seed junction voltages from vcrit â€” standard
        // thyristor initialization, avoids pnjlim on cold start.
        vmtLimited = vcritMain;
        vg1Limited = vcritGate;
        pnjlimLimited = false;
      } else {
        const vmtResult = pnjlim(vmtRaw, s0[base + SLOT_VAK], nVt, vcritMain);
        vmtLimited = vmtResult.value;
        vmtWasLimited = vmtResult.limited;
        const vg1Result = pnjlim(vg1Raw, s0[base + SLOT_VGK], nVt, vcritGate);
        vg1Limited = vg1Result.value;
        vg1WasLimited = vg1Result.limited;
        pnjlimLimited = vmtWasLimited || vg1WasLimited;
        if (pnjlimLimited) ctx.noncon.value++;
      }

      if (ctx.limitingCollector) {
        ctx.limitingCollector.push({
          elementIndex: (this as any).elementIndex ?? -1,
          label: (this as any).label ?? "",
          junction: "MT2-MT1",
          limitType: "pnjlim",
          vBefore: vmtRaw,
          vAfter: vmtLimited,
          wasLimited: vmtWasLimited,
        });
        ctx.limitingCollector.push({
          elementIndex: (this as any).elementIndex ?? -1,
          label: (this as any).label ?? "",
          junction: "G-MT1",
          limitType: "pnjlim",
          vBefore: vg1Raw,
          vAfter: vg1Limited,
          wasLimited: vg1WasLimited,
        });
      }

      s0[base + SLOT_VAK] = vmtLimited;
      s0[base + SLOT_VGK] = vg1Limited;

      computeOperatingPoint(s0, vmtLimited, vg1Limited);

      const solver = ctx.solver;
      const geq      = s0[base + SLOT_GEQ];
      const ieq      = s0[base + SLOT_IEQ];
      const gGateGeq = s0[base + SLOT_G_GATE_GEQ];
      const gGateIeq = s0[base + SLOT_G_GATE_IEQ];

      // MT1-MT2 main path
      stampG(solver, nodeMT2, nodeMT2, geq);
      stampG(solver, nodeMT2, nodeMT1, -geq);
      stampG(solver, nodeMT1, nodeMT2, -geq);
      stampG(solver, nodeMT1, nodeMT1, geq);
      stampRHS(ctx.rhs, nodeMT2, -ieq);
      stampRHS(ctx.rhs, nodeMT1, ieq);

      // Gate-MT1 path
      stampG(solver, nodeG,   nodeG,   gGateGeq);
      stampG(solver, nodeG,   nodeMT1, -gGateGeq);
      stampG(solver, nodeMT1, nodeG,   -gGateGeq);
      stampG(solver, nodeMT1, nodeMT1, gGateGeq);
      stampRHS(ctx.rhs, nodeG,   -gGateIeq);
      stampRHS(ctx.rhs, nodeMT1, gGateIeq);
    },

    checkConvergence(ctx: LoadContext): boolean {
      // If voltage was limited in load(), declare non-convergence immediately.
      if (pnjlimLimited) return false;

      const s0 = pool.states[0];
      const voltages = ctx.rhsOld;
      const v1 = voltages[nodeMT1];
      const v2 = voltages[nodeMT2];
      const vG = voltages[nodeG];

      // Current-prediction convergence test on MT2-MT1 junction
      const vmtRaw = v2 - v1;
      const delvmt = vmtRaw - s0[base + SLOT_VAK];
      const imt = s0[base + SLOT_IAK];
      const gmt = s0[base + SLOT_GEQ];
      const cmthat = imt + gmt * delvmt;
      const tolMT = ctx.reltol * Math.max(Math.abs(cmthat), Math.abs(imt)) + ctx.iabstol;

      // Current-prediction convergence test on gate-MT1 junction
      const vg1Raw = vG - v1;
      const delvg1 = vg1Raw - s0[base + SLOT_VGK];
      const ig1 = s0[base + SLOT_IGK];
      const gg1 = s0[base + SLOT_G_GATE_GEQ];
      const cg1hat = ig1 + gg1 * delvg1;
      const tolG1 = ctx.reltol * Math.max(Math.abs(cg1hat), Math.abs(ig1)) + ctx.iabstol;

      return Math.abs(cmthat - imt) <= tolMT && Math.abs(cg1hat - ig1) <= tolG1;
    },

    getPinCurrents(voltages: Float64Array): number[] {
      // pinLayout order: [MT2(0), MT1(1), G(2)]
      const s0 = pool.states[0];
      const v1 = voltages[nodeMT1];
      const v2 = voltages[nodeMT2];
      const vG = voltages[nodeG];

      const iMT = s0[base + SLOT_GEQ] * (v2 - v1) + s0[base + SLOT_IEQ];
      const iG  = s0[base + SLOT_G_GATE_GEQ] * (vG - v1) + s0[base + SLOT_G_GATE_IEQ];

      const iMT2 = iMT;
      const iMT1 = -(iMT2 + iG);

      // Return in pinLayout order [MT2, MT1, G]
      return [iMT2, iMT1, iG];
    },

    setParam(key: string, value: number): void {
      if (key in p) {
        (p as Record<string, number>)[key] = value;
        recomputeDerivedConstants();
      }
    },
  };
}

// ---------------------------------------------------------------------------
// TriacElement â€” CircuitElement implementation
// ---------------------------------------------------------------------------

export class TriacElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("Triac", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildTriacPinDeclarations(), []);
  }

  getBoundingBox(): Rect {
    return {
      x: this.position.x,
      y: this.position.y - 2,
      width: 4,
      height: 3,
    };
  }

  draw(ctx: RenderContext, signals?: PinVoltageAccess): void {
    const vMT2 = signals?.getPinVoltage("MT2");
    const vMT1 = signals?.getPinVoltage("MT1");
    const vG = signals?.getPinVoltage("G");

    ctx.save();
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);

    // Reference pixel coords divided by 16 for grid units
    // Component spans x=0..4, y=-2..0 (pin 2 at (4,-2))
    const bar1x = 24 / 16; // 1.5
    const bar2x = 40 / 16; // 2.5

    // Body: two vertical bars and bidirectional arrow triangles
    // Bar 1 at x=1.5, from y=-1 to y=+1
    ctx.drawLine(bar1x, -1,     bar1x, 1);
    // Bar 2 at x=2.5, from y=-1 to y=+1
    ctx.drawLine(bar2x, -1,     bar2x, 1);

    // Forward arrow triangle (pointing right): (bar1x, 0.5) â†’ (bar2x, 1.0) â†’ (bar2x, 0)
    ctx.drawPolygon([
      { x: bar1x, y:  8 / 16 },
      { x: bar2x, y: 16 / 16 },
      { x: bar2x, y: 0 },
    ], true);

    // Reverse arrow triangle (pointing left): (bar2x, -0.5) â†’ (bar1x, -1.0) â†’ (bar1x, 0)
    ctx.drawPolygon([
      { x: bar2x, y:  -8 / 16 },
      { x: bar1x, y: -16 / 16 },
      { x: bar1x, y: 0 },
    ], true);

    // MT2 lead: pin 0 at (0,0) â†’ bar1 at (1.5,0)
    drawColoredLead(ctx, signals, vMT2, 0, 0, bar1x, 0);

    // MT1 lead: bar2 at (2.5,0) â†’ pin 1 at (4,0)
    drawColoredLead(ctx, signals, vMT1, bar2x, 0, 4, 0);

    // Gate lead: (2.5,0) â†’ (4,-1.5) â†’ (4,-2) to pin 2
    drawColoredLead(ctx, signals, vG, bar2x, 0, 4, -24 / 16);
    ctx.drawLine(4, -24 / 16, 4, -2);

    ctx.restore();
  }

}

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

function buildTriacPinDeclarations(): PinDeclaration[] {
  return [
    {
      direction: PinDirection.INPUT,
      label: "MT2",
      defaultBitWidth: 1,
      position: { x: 0, y: 0 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.INPUT,
      label: "MT1",
      defaultBitWidth: 1,
      position: { x: 4, y: 0 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.INPUT,
      label: "G",
      defaultBitWidth: 1,
      position: { x: 4, y: -2 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
  ];
}

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const TRIAC_PROPERTY_DEFS: PropertyDefinition[] = [
  LABEL_PROPERTY_DEF,
];

// ---------------------------------------------------------------------------
// Attribute mappings
// ---------------------------------------------------------------------------

export const TRIAC_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  { xmlName: "Label", propertyKey: "label", convert: (v) => v },
  { xmlName: "model", propertyKey: "model", convert: (v) => v },
];

// ---------------------------------------------------------------------------
// TriacDefinition
// ---------------------------------------------------------------------------

function triacCircuitFactory(props: PropertyBag): TriacElement {
  return new TriacElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const TriacDefinition: ComponentDefinition = {
  name: "Triac",
  typeId: -1,
  factory: triacCircuitFactory,
  pinLayout: buildTriacPinDeclarations(),
  propertyDefs: TRIAC_PROPERTY_DEFS,
  attributeMap: TRIAC_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.SEMICONDUCTORS,
  helpText:
    "Triac â€” bidirectional thyristor.\n" +
    "Pins: MT1 (main terminal 1), MT2 (main terminal 2), G (gate).\n" +
    "Conducts in both directions when triggered. Turns off at current zero-crossing.",
  models: {},
  modelRegistry: {
    "behavioral": {
      kind: "inline",
      factory: (pinNodes, internalNodeIds, branchIdx, props, _getTime) =>
        createTriacElement(pinNodes, internalNodeIds, branchIdx, props),
      paramDefs: TRIAC_PARAM_DEFS,
      params: TRIAC_PARAM_DEFAULTS,
    },
  },
  defaultModel: "behavioral",
};
