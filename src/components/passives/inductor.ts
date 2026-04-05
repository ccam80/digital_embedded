/**
 * Inductor analog component.
 *
 * Reactive two-terminal element that requires a branch variable (extra MNA row)
 * to track branch current. Uses companion model (equivalent conductance + history
 * current source) recomputed at each timestep with one of three integration methods:
 * BDF-1, trapezoidal, or BDF-2.
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
import { formatSI } from "../../editor/si-format.js";
import type { AnalogElementCore, IntegrationMethod } from "../../solver/analog/element.js";
import type { SparseSolver } from "../../solver/analog/sparse-solver.js";
import {
  inductorConductance,
  inductorHistoryCurrent,
} from "../../solver/analog/integration.js";
import { defineModelParams } from "../../core/model-params.js";
import type { StatePoolRef } from "../../core/analog-types.js";

// ---------------------------------------------------------------------------
// Model parameter declarations
// ---------------------------------------------------------------------------

export const { paramDefs: INDUCTOR_PARAM_DEFS, defaults: INDUCTOR_DEFAULTS } = defineModelParams({
  primary: {
    inductance: { default: 1e-3, unit: "H", description: "Inductance in henries", min: 1e-12 },
  },
});

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

function buildInductorPinDeclarations(): PinDeclaration[] {
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
      direction: PinDirection.OUTPUT,
      label: "B",
      defaultBitWidth: 1,
      position: { x: 4, y: 0 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
  ];
}

// ---------------------------------------------------------------------------
// InductorElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class InductorElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("Inductor", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildInductorPinDeclarations(), []);
  }

  getBoundingBox(): Rect {
    const r = 2 / (2 * 3); // segLen / (2 * loopCt) = 1/3
    // Add tiny epsilon to height: sin(PI) ≈ 1.22e-16, not exactly 0,
    // so arc endpoint y is ~4e-17 above 0; bbox must cover that.
    return {
      x: this.position.x,
      y: this.position.y - r,
      width: 4,
      height: r + 1e-10,
    };
  }

  draw(ctx: RenderContext, signals?: PinVoltageAccess): void {
    const inductance = this._properties.getModelParam<number>("inductance");
    const label = this._visibleLabel();

    ctx.save();
    ctx.setLineWidth(1);

    const vA = signals?.getPinVoltage("A");
    const vB = signals?.getPinVoltage("B");
    const hasVoltage = vA !== undefined && vB !== undefined;

    // Left lead — colored by pin A voltage
    drawColoredLead(ctx, hasVoltage ? signals : undefined, vA, 0, 0, 1, 0);

    // Right lead — colored by pin B voltage
    drawColoredLead(ctx, hasVoltage ? signals : undefined, vB, 3, 0, 4, 0);

    // Coil body: 3 semicircular arcs from PI to 2*PI — gradient from vA to vB
    const loopCt = 3;
    const segLen = 2;
    const r = segLen / (2 * loopCt); // arc radius = 1/3 grid unit
    if (hasVoltage && ctx.setLinearGradient) {
      ctx.setLinearGradient(1, 0, 3, 0, [
        { offset: 0, color: signals!.voltageColor(vA) },
        { offset: 1, color: signals!.voltageColor(vB) },
      ]);
    } else {
      ctx.setColor("COMPONENT");
    }
    for (let loop = 0; loop < loopCt; loop++) {
      const cx = 1 + (segLen * (loop + 0.5)) / loopCt;
      ctx.drawArc(cx, 0, r, Math.PI, 2 * Math.PI);
    }

    // Value label above body (matching Falstad reference: pixel (27,-10) = grid (1.6875,-0.625))
    const displayLabel = label.length > 0 ? label : (this._shouldShowValue() ? formatSI(inductance, "H") : "");
    ctx.setColor("TEXT");
    ctx.setFont({ family: "sans-serif", size: 0.7 });
    ctx.drawText(displayLabel, 1.6875, -0.625, { horizontal: "center", vertical: "bottom" });

    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// AnalogInductorElement — MNA implementation
// ---------------------------------------------------------------------------

// Slot indices within the state pool
// Slot indices within the state pool.
//
// GEQ, IEQ, I_PREV hold the Norton companion coefficients and the branch
// current at the previous accepted step (used by the history update in
// `stampCompanion`). I_PREV_PREV holds the branch current two steps ago,
// used only by `getLteEstimate` for a dt-scaled truncation error estimate.
const SLOT_GEQ = 0;
const SLOT_IEQ = 1;
const SLOT_I_PREV = 2;
const SLOT_I_PREV_PREV = 3;

class AnalogInductorElement implements AnalogElementCore {
  pinNodeIds!: readonly number[];  // set by compiler via Object.assign after factory returns
  readonly branchIndex: number;
  readonly isNonlinear: boolean = false;
  readonly isReactive: boolean = true;
  readonly stateSize: number = 4;
  stateBaseOffset: number = -1;

  private L: number;
  private s0!: Float64Array;
  private base!: number;

  constructor(branchIdx: number, inductance: number) {
    this.branchIndex = branchIdx;
    this.L = inductance;
  }

  initState(pool: StatePoolRef): void {
    this.s0 = pool.state0;
    this.base = this.stateBaseOffset;
  }

  setParam(key: string, value: number): void {
    if (key === "inductance") {
      this.L = value;
    }
  }

  stamp(solver: SparseSolver): void {
    const n0 = this.pinNodeIds[0];
    const n1 = this.pinNodeIds[1];
    const b = this.branchIndex;
    const geq = this.s0[this.base + SLOT_GEQ];
    const ieq = this.s0[this.base + SLOT_IEQ];
    // @ts-ignore DEBUG instrumentation
    if (globalThis.__INDUCTOR_DEBUG && globalThis.__INDUCTOR_DEBUG_COUNT < 40) {
      // @ts-ignore
      globalThis.__INDUCTOR_DEBUG_COUNT++;
      // @ts-ignore
      console.log(`[L.stamp] base=${this.base} b=${b} n0=${n0} n1=${n1} geq=${geq} ieq=${ieq} L=${this.L} sameRef=${this.s0 === (globalThis.__POOL_REF ?? this.s0)}`);
    }

    // B sub-matrix: branch current incidence in node KCL equations.
    // I_branch flows from n0 through the inductor to n1.
    if (n0 !== 0) solver.stamp(n0 - 1, b, 1);
    if (n1 !== 0) solver.stamp(n1 - 1, b, -1);

    // C sub-matrix: branch equation  V_n0 - V_n1 - geq * I_branch = ieq
    // Before first stampCompanion, geq=0 and ieq=0 → V_n0 - V_n1 = 0
    // (short circuit — correct DC operating point for an inductor).
    if (n0 !== 0) solver.stamp(b, n0 - 1, 1);
    if (n1 !== 0) solver.stamp(b, n1 - 1, -1);
    solver.stamp(b, b, -geq);

    // RHS: branch equation source
    solver.stampRHS(b, ieq);
  }

  getPinCurrents(voltages: Float64Array): number[] {
    const I = voltages[this.branchIndex];
    return [I, -I];
  }

  stampCompanion(dt: number, method: IntegrationMethod, voltages: Float64Array): void {
    const iNow = voltages[this.branchIndex];
    const v0 = this.pinNodeIds[0] > 0 ? voltages[this.pinNodeIds[0] - 1] : 0;
    const v1 = this.pinNodeIds[1] > 0 ? voltages[this.pinNodeIds[1] - 1] : 0;
    const vNow = v0 - v1;
    const iPrev = this.s0[this.base + SLOT_I_PREV];

    const newGeq = inductorConductance(this.L, dt, method);
    const newIeq = inductorHistoryCurrent(this.L, dt, method, iNow, iPrev, vNow);
    this.s0[this.base + SLOT_GEQ] = newGeq;
    this.s0[this.base + SLOT_IEQ] = newIeq;
    // @ts-ignore DEBUG instrumentation
    if (globalThis.__INDUCTOR_DEBUG && globalThis.__INDUCTOR_DEBUG_COUNT < 40) {
      // @ts-ignore
      console.log(`[L.stampComp] base=${this.base} dt=${dt} method=${method} iNow=${iNow} iPrev=${iPrev} vNow=${vNow} newGeq=${newGeq} newIeq=${newIeq}`);
      // @ts-ignore
      globalThis.__POOL_REF = this.s0;
    }
    // Shift LTE history: the prior iPrev (= current at end of step N-2)
    // moves to prev-prev, and iNow (= current at end of step N-1) becomes
    // the new prev. getLteEstimate compares these two points to produce a
    // dt-scaled truncation error — see capacitor.ts for derivation.
    this.s0[this.base + SLOT_I_PREV_PREV] = iPrev;
    this.s0[this.base + SLOT_I_PREV] = iNow;
  }

  getLteEstimate(dt: number): { truncationError: number; toleranceReference: number } {
    // LTE estimate for trapezoidal integration of an inductor.
    //
    // Parallels the capacitor derivation in `capacitor.ts`. The first-
    // difference of stored branch currents across the previous two step
    // boundaries, scaled by dt/12, produces an error that scales linearly
    // with dt.
    //
    // `toleranceReference` is the inductor flux φ = L · i_prev, the natural
    // stored quantity used by ngspice's relative LTE tolerance formula. The
    // engine composes the rejection threshold as
    //   local_tol = trtol · (reltol · |φ| + chargeTol)
    // keeping the per-step tolerance proportional to the flux the inductor
    // is actually storing.
    //
    // Retrospective by one step — zero on the first two calls, valid
    // thereafter.
    if (dt <= 0) return { truncationError: 0, toleranceReference: 0 };
    const iPrev = this.s0[this.base + SLOT_I_PREV];
    const iPrevPrev = this.s0[this.base + SLOT_I_PREV_PREV];
    const deltaI = Math.abs(iPrev - iPrevPrev);
    const fluxRef = this.L * Math.max(Math.abs(iPrev), Math.abs(iPrevPrev));
    return {
      truncationError: (dt / 12) * deltaI,
      toleranceReference: fluxRef,
    };
  }
}

function createInductorElement(
  _pinNodes: ReadonlyMap<string, number>,
  _internalNodeIds: readonly number[],
  branchIdx: number,
  props: PropertyBag,
): AnalogElementCore {
  const L = props.getModelParam<number>("inductance");
  return new AnalogInductorElement(branchIdx, L);
}

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const INDUCTOR_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "label",
    type: PropertyType.STRING,
    label: "Label",
    defaultValue: "",
    description: "Optional label shown below the component",
  },
];

// ---------------------------------------------------------------------------
// Attribute mappings
// ---------------------------------------------------------------------------

export const INDUCTOR_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  {
    xmlName: "inductance",
    propertyKey: "inductance",
    convert: (v) => parseFloat(v),
    modelParam: true,
  },
  {
    xmlName: "Label",
    propertyKey: "label",
    convert: (v) => v,
  },
];

// ---------------------------------------------------------------------------
// InductorDefinition
// ---------------------------------------------------------------------------

function inductorCircuitFactory(props: PropertyBag): InductorElement {
  return new InductorElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const InductorDefinition: ComponentDefinition = {
  name: "Inductor",
  typeId: -1,
  factory: inductorCircuitFactory,
  pinLayout: buildInductorPinDeclarations(),
  propertyDefs: INDUCTOR_PROPERTY_DEFS,
  attributeMap: INDUCTOR_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.PASSIVES,
  helpText:
    "Inductor — reactive element with companion model and branch current.\n" +
    "Stamps equivalent conductance, history current, and branch incidence entries.",
  models: {},
  modelRegistry: {
    "behavioral": {
      kind: "inline",
      factory: createInductorElement,
      paramDefs: INDUCTOR_PARAM_DEFS,
      params: INDUCTOR_DEFAULTS,
      branchCount: 1,
    },
  },
  defaultModel: "behavioral",
};
