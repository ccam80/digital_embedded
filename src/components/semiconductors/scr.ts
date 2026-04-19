/**
 * SCR (Silicon Controlled Rectifier) analog component.
 *
 * Implements a thyristor using the two-transistor alpha-dependent model.
 * The device blocks forward and reverse conduction until triggered by
 * gate current, at which point it latches into a low-resistance on-state.
 *
 * Model summary:
 *   - Forward blocking: I = IS * (exp(V_AK/(N*VT)) - 1) / (1 - α₁ - α₂)
 *     (amplified leakage — small current, both alphas clamped ≤ 0.95)
 *   - Forward conduction (latched): diode in series with R_on, clamping V_AK ≈ V_on
 *   - Reverse blocking: standard reverse-biased diode leakage
 *   - Triggering: when α₁ + α₂ > 0.95
 *   - Unlatching: when I_AK < I_hold
 *   - Breakover: when V_AK > V_breakover (triggers without gate)
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
import { stampG, stampRHS } from "../../solver/analog/stamp-helpers.js";
import { pnjlim } from "../../solver/analog/newton-raphson.js";
import { defineModelParams } from "../../core/model-params.js";
import type { StatePoolRef } from "../../core/analog-types.js";
import { VT } from "../../core/constants.js";
import { defineStateSchema, applyInitialValues } from "../../solver/analog/state-schema.js";

// ---------------------------------------------------------------------------
// Physical constants
// ---------------------------------------------------------------------------

// VT (thermal voltage) imported from ../../core/constants.js

/** Minimum conductance for numerical stability (GMIN). */
const GMIN = 1e-12;

/** Maximum alpha value — prevents division-by-zero in blocking formula. */
const ALPHA_MAX = 0.95;

// ---------------------------------------------------------------------------
// State pool slot indices
// ---------------------------------------------------------------------------

const SLOT_VAK       = 0;
const SLOT_VGK       = 1;
const SLOT_GEQ       = 2;
const SLOT_IEQ       = 3;
const SLOT_G_GATE_GEQ = 4;
const SLOT_G_GATE_IEQ = 5;
const SLOT_LATCHED   = 6;
const SLOT_IAK       = 7;
const SLOT_IGK       = 8;

// ---------------------------------------------------------------------------
// Model parameter declarations
// ---------------------------------------------------------------------------

export const { paramDefs: SCR_PARAM_DEFS, defaults: SCR_PARAM_DEFAULTS } = defineModelParams({
  primary: {
    vOn:        { default: 1.5,   unit: "V", description: "On-state forward voltage drop" },
    iH:         { default: 5e-3,  unit: "A", description: "Holding current — minimum anode current to stay on" },
    rOn:        { default: 0.01,  unit: "Ω", description: "On-state series resistance" },
    vBreakover: { default: 100,   unit: "V", description: "Forward breakover voltage (triggers without gate)" },
  },
  secondary: {
    iS:      { default: 1e-12, unit: "A", description: "Reverse saturation current" },
    alpha1:  { default: 0.5,              description: "PNP transistor current gain (fixed)" },
    alpha2_0:{ default: 0.3,              description: "NPN off-state current gain" },
    i_ref:   { default: 1e-3,  unit: "A", description: "Gate current scale factor for α₂ modulation" },
    n:       { default: 1,                description: "Emission coefficient" },
  },
});

// ---------------------------------------------------------------------------
// Stamp helpers — node 0 is ground (skipped)
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// State schema declaration
// ---------------------------------------------------------------------------

const SCR_STATE_SCHEMA = defineStateSchema("ScrElement", [
  { name: "VAK", doc: "Anode-cathode voltage, pnjlim-limited (V)", init: { kind: "zero" } },
  { name: "VGK", doc: "Gate-cathode voltage, pnjlim-limited (V)", init: { kind: "zero" } },
  { name: "GEQ", doc: "Linearized anode-cathode conductance (S)", init: { kind: "constant", value: 1e-12 } },
  { name: "IEQ", doc: "Linearized anode-cathode current source (A)", init: { kind: "zero" } },
  { name: "G_GATE_GEQ", doc: "Gate junction conductance (S)", init: { kind: "constant", value: 1e-12 } },
  { name: "G_GATE_IEQ", doc: "Gate junction current source (A)", init: { kind: "zero" } },
  { name: "LATCHED", doc: "Latch state flag (0=off, 1=on)", init: { kind: "zero" } },
  { name: "IAK", doc: "Anode current (A)", init: { kind: "zero" } },
  { name: "IGK", doc: "Gate current (A)", init: { kind: "zero" } },
]);

// ---------------------------------------------------------------------------
// createScrElement — AnalogElement factory
// ---------------------------------------------------------------------------

export function createScrElement(
  pinNodes: ReadonlyMap<string, number>,
  _internalNodeIds: readonly number[],
  _branchIdx: number,
  props: PropertyBag,
): PoolBackedAnalogElementCore {
  const nodeA = pinNodes.get("A")!; // anode
  const nodeK = pinNodes.get("K")!; // cathode
  const nodeG = pinNodes.get("G")!; // gate

  const p = {
    vOn:        props.getModelParam<number>("vOn"),
    iH:         props.getModelParam<number>("iH"),
    rOn:        props.getModelParam<number>("rOn"),
    vBreakover: props.getModelParam<number>("vBreakover"),
    iS:         props.getModelParam<number>("iS"),
    alpha1:     props.getModelParam<number>("alpha1"),
    alpha2_0:   props.getModelParam<number>("alpha2_0"),
    i_ref:      props.getModelParam<number>("i_ref"),
    n:          props.getModelParam<number>("n"),
  };

  let nVt = p.n * VT;
  let vcrit = nVt * Math.log(nVt / (p.iS * Math.SQRT2));
  let vcritGate = nVt * Math.log(nVt / (p.iS * Math.SQRT2));

  // Pool binding — set by initState
  let s0: Float64Array;
  let base: number;
  let pool: StatePoolRef;

  // Ephemeral per-iteration pnjlim limiting flag (ngspice icheck, SCRload sets CKTnoncon++)
  let pnjlimLimited = false;

  // One-shot cold-start seeds from dcopInitJct. Non-null only between
  // primeJunctions() and the next updateOperatingPoint() call.
  let primedVak: number | null = null;
  let primedVgk: number | null = null;

  function recomputeDerivedConstants(): void {
    nVt = p.n * VT;
    vcrit = nVt * Math.log(nVt / (p.iS * Math.SQRT2));
    vcritGate = nVt * Math.log(nVt / (p.iS * Math.SQRT2));
  }

  function computeAlpha2(iGate: number): number {
    const raw = 1 - (1 - p.alpha2_0) * Math.exp(-Math.abs(iGate) / p.i_ref);
    return Math.min(raw, ALPHA_MAX);
  }

  function computeOperatingPoint(vak: number, vgk: number): void {
    // Gate current through a small forward-biased junction (simplified model)
    const iGate = p.iS * (Math.exp(Math.min(vgk / nVt, 700)) - 1) + GMIN * vgk;

    const a2 = computeAlpha2(iGate);
    const a1clamped = Math.min(p.alpha1, ALPHA_MAX);
    const a2clamped = Math.min(a2, ALPHA_MAX);
    const alphaSum = a1clamped + a2clamped;

    // Check triggering: alpha sum > 0.95
    if (s0[base + SLOT_LATCHED] === 0.0 && alphaSum > 0.95) {
      s0[base + SLOT_LATCHED] = 1.0;
    }

    if (s0[base + SLOT_LATCHED] !== 0.0) {
      // On-state: model as diode (V_on forward voltage) in series with R_on
      const gOn = 1.0 / p.rOn;
      const iOn = (vak - p.vOn) / p.rOn;
      s0[base + SLOT_GEQ] = gOn + GMIN;
      s0[base + SLOT_IEQ] = iOn - s0[base + SLOT_GEQ] * vak;

      // Check if current has dropped below holding current → unlatch
      const iAk = s0[base + SLOT_GEQ] * vak + s0[base + SLOT_IEQ];
      s0[base + SLOT_IAK] = iAk;
      if (iAk < p.iH && vak >= 0) {
        s0[base + SLOT_LATCHED] = 0.0;
        // Re-compute in blocking mode
        computeBlockingMode(vak, alphaSum);
      }
    } else {
      computeBlockingMode(vak, alphaSum);
    }

    // Gate junction model: forward-biased diode linearized at the (already
    // pnjlim-limited) vgk operating point.
    const expVgk = Math.exp(Math.min(vgk / nVt, 700));
    const gGate = (p.iS * expVgk) / nVt + GMIN;
    const iGateCurrent = p.iS * (expVgk - 1);
    s0[base + SLOT_G_GATE_GEQ] = gGate;
    s0[base + SLOT_G_GATE_IEQ] = iGateCurrent - gGate * vgk;
    s0[base + SLOT_IGK] = iGateCurrent;
  }

  function computeBlockingMode(vak: number, _alphaSum: number): void {
    if (vak >= 0) {
      // Forward blocking: high-resistance path
      s0[base + SLOT_GEQ] = GMIN;
      s0[base + SLOT_IEQ] = 0;
      s0[base + SLOT_IAK] = GMIN * vak;
    } else {
      // Reverse blocking — reverse-biased diode (J1 junction)
      const expArg = Math.min(vak / nVt, 0);
      const expVal = Math.exp(expArg);
      const iRev = p.iS * (expVal - 1);
      const gRev = (p.iS * expVal) / nVt + GMIN;
      s0[base + SLOT_GEQ] = gRev;
      s0[base + SLOT_IEQ] = iRev - gRev * vak;
      s0[base + SLOT_IAK] = iRev;
    }
  }

  return {
    branchIndex: -1,
    isNonlinear: true,
    isReactive: false,
    poolBacked: true as const,
    stateSize: 9,
    stateSchema: SCR_STATE_SCHEMA,
    stateBaseOffset: -1,

    initState(poolRef: StatePoolRef): void {
      pool = poolRef;
      s0 = pool.state0;
      base = this.stateBaseOffset;
      applyInitialValues(SCR_STATE_SCHEMA, pool, base, {});
    },

    refreshSubElementRefs(newS0: Float64Array, _newS1: Float64Array, _newS2: Float64Array, _newS3: Float64Array, _newS4: Float64Array, _newS5: Float64Array, _newS6: Float64Array, _newS7: Float64Array): void {
      s0 = newS0;
    },

    load(ctx: LoadContext): void {
      const voltages = ctx.voltages;
      let vakRaw: number;
      let vgkRaw: number;
      if (primedVak !== null) {
        vakRaw = primedVak;
        vgkRaw = primedVgk!;
        primedVak = null;
        primedVgk = null;
      } else {
        const vA = nodeA > 0 ? voltages[nodeA - 1] : 0;
        const vK = nodeK > 0 ? voltages[nodeK - 1] : 0;
        const vGateNode = nodeG > 0 ? voltages[nodeG - 1] : 0;
        vakRaw = vA - vK;
        vgkRaw = vGateNode - vK;
      }

      // Check breakover using raw voltage before pnjlim.
      if (s0[base + SLOT_LATCHED] === 0.0 && vakRaw > p.vBreakover) {
        s0[base + SLOT_LATCHED] = 1.0;
      }

      let vakLimited: number;
      let vgkLimited: number;
      if (pool.initMode === "initJct") {
        // dioload.c:130-136: MODEINITJCT sets vd directly — no pnjlim
        vakLimited = vakRaw;
        vgkLimited = vgkRaw;
        pnjlimLimited = false;
      } else {
        // Apply pnjlim to anode-cathode junction voltage for NR stability
        const vakResult = pnjlim(vakRaw, s0[base + SLOT_VAK], nVt, vcrit);
        vakLimited = vakResult.value;

        // Apply pnjlim to gate-cathode junction voltage for NR stability
        const vgkResult = pnjlim(vgkRaw, s0[base + SLOT_VGK], nVt, vcritGate);
        vgkLimited = vgkResult.value;
        pnjlimLimited = vakResult.limited || vgkResult.limited;

        if (ctx.limitingCollector) {
          ctx.limitingCollector.push({
            elementIndex: (this as any).elementIndex ?? -1,
            label: (this as any).label ?? "",
            junction: "AK",
            limitType: "pnjlim",
            vBefore: vakRaw,
            vAfter: vakLimited,
            wasLimited: vakResult.limited,
          });
          ctx.limitingCollector.push({
            elementIndex: (this as any).elementIndex ?? -1,
            label: (this as any).label ?? "",
            junction: "GK",
            limitType: "pnjlim",
            vBefore: vgkRaw,
            vAfter: vgkLimited,
            wasLimited: vgkResult.limited,
          });
        }
      }

      if (pnjlimLimited) ctx.noncon.value++;

      s0[base + SLOT_VAK] = vakLimited;
      s0[base + SLOT_VGK] = vgkLimited;

      computeOperatingPoint(vakLimited, vgkLimited);

      const solver = ctx.solver;
      const geq      = s0[base + SLOT_GEQ];
      const ieq      = s0[base + SLOT_IEQ];
      const gGateGeq = s0[base + SLOT_G_GATE_GEQ];
      const gGateIeq = s0[base + SLOT_G_GATE_IEQ];

      // Anode-cathode path
      stampG(solver, nodeA, nodeA, geq);
      stampG(solver, nodeA, nodeK, -geq);
      stampG(solver, nodeK, nodeA, -geq);
      stampG(solver, nodeK, nodeK, geq);
      stampRHS(solver, nodeA, -ieq);
      stampRHS(solver, nodeK, ieq);

      // Gate-cathode path (gate junction)
      stampG(solver, nodeG, nodeG, gGateGeq);
      stampG(solver, nodeG, nodeK, -gGateGeq);
      stampG(solver, nodeK, nodeG, -gGateGeq);
      stampG(solver, nodeK, nodeK, gGateGeq);
      stampRHS(solver, nodeG, -gGateIeq);
      stampRHS(solver, nodeK, gGateIeq);
    },

    checkConvergence(ctx: LoadContext): boolean {
      // ngspice icheck gate: if voltage was limited in load(),
      // declare non-convergence immediately (SCRload sets CKTnoncon++)
      if (pnjlimLimited) return false;

      const voltages = ctx.voltages;
      const vA = nodeA > 0 ? voltages[nodeA - 1] : 0;
      const vK = nodeK > 0 ? voltages[nodeK - 1] : 0;
      const vG = nodeG > 0 ? voltages[nodeG - 1] : 0;

      // ngspice DIOconvTest on J1 (anode-cathode)
      const vakRaw = vA - vK;
      const delvak = vakRaw - s0[base + SLOT_VAK];
      const iak = s0[base + SLOT_IAK];
      const gak = s0[base + SLOT_GEQ];
      const cakhat = iak + gak * delvak;
      const tolAK = ctx.reltol * Math.max(Math.abs(cakhat), Math.abs(iak)) + ctx.iabstol;

      // ngspice DIOconvTest on J2 (gate-cathode)
      const vgkRaw = vG - vK;
      const delvgk = vgkRaw - s0[base + SLOT_VGK];
      const igk = s0[base + SLOT_IGK];
      const ggk = s0[base + SLOT_G_GATE_GEQ];
      const cgkhat = igk + ggk * delvgk;
      const tolGK = ctx.reltol * Math.max(Math.abs(cgkhat), Math.abs(igk)) + ctx.iabstol;

      return Math.abs(cakhat - iak) <= tolAK && Math.abs(cgkhat - igk) <= tolGK;
    },

    getPinCurrents(voltages: Float64Array): number[] {
      // pinLayout order: [A(0), K(1), G(2)]
      const vA = nodeA > 0 ? voltages[nodeA - 1] : 0;
      const vK = nodeK > 0 ? voltages[nodeK - 1] : 0;
      const vG = nodeG > 0 ? voltages[nodeG - 1] : 0;

      const iAK = s0[base + SLOT_GEQ] * (vA - vK) + s0[base + SLOT_IEQ];
      const iGK = s0[base + SLOT_G_GATE_GEQ] * (vG - vK) + s0[base + SLOT_G_GATE_IEQ];

      const iA = iAK;
      const iG = iGK;
      const iK = -(iA + iG);

      // Return in pinLayout order [A, K, G]
      return [iA, iK, iG];
    },

    primeJunctions(): void {
      // dioload.c:135-136: MODEINITJCT sets vd = tVcrit
      primedVak = vcrit;   // forward junction seed
      primedVgk = 0;       // gate initially unbiased
    },

    setParam(key: string, value: number): void {
      if (key in p) {
        (p as Record<string, number>)[key] = value;
        recomputeDerivedConstants();
      }
    },

    get label(): string | undefined {
      return props.getOrDefault<string>("label", "");
    },

    // Expose latch state for testing
    get _latchedState(): boolean {
      return s0[base + SLOT_LATCHED] !== 0.0;
    },
  } as PoolBackedAnalogElementCore & { _latchedState: boolean };
}

// ---------------------------------------------------------------------------
// ScrElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class ScrElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("SCR", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildScrPinDeclarations(), []);
  }

  getBoundingBox(): Rect {
    return {
      x: this.position.x,
      y: this.position.y - 2,
      width: 4,
      height: 2.5,
    };
  }

  draw(ctx: RenderContext, signals?: PinVoltageAccess): void {
    const vA = signals?.getPinVoltage("A");
    const vK = signals?.getPinVoltage("K");
    const vG = signals?.getPinVoltage("G");

    ctx.save();
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);

    // Body (triangle and cathode bar) stays COMPONENT color
    ctx.drawPolygon([
      { x: 1.5, y: -0.5 },
      { x: 1.5, y: 0.5 },
      { x: 2.5, y: 0 },
    ], true);
    ctx.drawLine(2.5, -0.5, 2.5, 0.5);

    // Anode lead
    drawColoredLead(ctx, signals, vA, 0, 0, 1.5, 0);

    // Cathode lead
    drawColoredLead(ctx, signals, vK, 2.5, 0, 4, 0);

    // Gate lead: diagonal from cathode bar to pin G at (3,1)
    drawColoredLead(ctx, signals, vG, 2.5, 0, 3, 1);

    ctx.restore();
  }

}

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

function buildScrPinDeclarations(): PinDeclaration[] {
  return [
    {
      direction: PinDirection.INPUT,
      label: "A",
      defaultBitWidth: 1,
      position: { x: 0, y: 0 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.INPUT,
      label: "K",
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
      position: { x: 3, y: 1 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
  ];
}

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const SCR_PROPERTY_DEFS: PropertyDefinition[] = [
  LABEL_PROPERTY_DEF,
];

// ---------------------------------------------------------------------------
// Attribute mappings
// ---------------------------------------------------------------------------

export const SCR_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  { xmlName: "Label", propertyKey: "label", convert: (v) => v },
  { xmlName: "model", propertyKey: "model", convert: (v) => v },
];

// ---------------------------------------------------------------------------
// ScrDefinition
// ---------------------------------------------------------------------------

function scrCircuitFactory(props: PropertyBag): ScrElement {
  return new ScrElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const ScrDefinition: ComponentDefinition = {
  name: "SCR",
  typeId: -1,
  factory: scrCircuitFactory,
  pinLayout: buildScrPinDeclarations(),
  propertyDefs: SCR_PROPERTY_DEFS,
  attributeMap: SCR_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.SEMICONDUCTORS,
  helpText:
    "SCR — Silicon Controlled Rectifier.\n" +
    "Pins: A (anode), K (cathode), G (gate).\n" +
    "Triggers when gate current raises α₁+α₂ above 0.95. Latches until I_AK < I_hold.",
  models: {},
  modelRegistry: {
    "behavioral": {
      kind: "inline",
      factory: (pinNodes, internalNodeIds, branchIdx, props, _getTime) =>
        createScrElement(pinNodes, internalNodeIds, branchIdx, props),
      paramDefs: SCR_PARAM_DEFS,
      params: SCR_PARAM_DEFAULTS,
    },
  },
  defaultModel: "behavioral",
};
