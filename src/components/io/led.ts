/**
 * LED component â€” single-color indicator.
 *
 * Circle shape, configurable color, lights up when input is non-zero.
 * 1-bit input: on when input = 1, off when input = 0.
 */

import { AbstractCircuitElement } from "../../core/element.js";
import type { RenderContext } from "../../core/renderer-interface.js";
import type { Rect } from "../../core/renderer-interface.js";
import type { Pin, PinDeclaration, Rotation } from "../../core/pin.js";
import {
  PinDirection,
} from "../../core/pin.js";
import { PropertyBag, PropertyType } from "../../core/properties.js";
import type { PropertyDefinition } from "../../core/properties.js";
import {
  ComponentCategory,
  type AttributeMapping,
  type ComponentDefinition,
  type ComponentLayout,
} from "../../core/registry.js";
import type { AnalogElementCore, PoolBackedAnalogElementCore, LoadContext } from "../../solver/analog/element.js";
import type { IntegrationMethod } from "../../solver/analog/element.js";
import { MODETRAN, MODEAC, MODEINITJCT } from "../../solver/analog/ckt-mode.js";
import { stampG, stampRHS } from "../../solver/analog/stamp-helpers.js";
import { pnjlim } from "../../solver/analog/newton-raphson.js";
import {
  computeJunctionCapacitance,
  computeJunctionCharge,
} from "../semiconductors/diode.js";
import { cktTerr } from "../../solver/analog/ckt-terr.js";
import { niIntegrate } from "../../solver/analog/ni-integrate.js";
import type { LteParams } from "../../solver/analog/ckt-terr.js";
import { defineModelParams } from "../../core/model-params.js";
import type { StatePoolRef } from "../../core/analog-types.js";
import { defineStateSchema, applyInitialValues } from "../../solver/analog/state-schema.js";

// ---------------------------------------------------------------------------
// Physical constants (ngspice const.h values)
// ---------------------------------------------------------------------------
const CONSTboltz = 1.3806226e-23;
const CHARGE = 1.6021918e-19;

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

function buildLedPinDeclarations(): PinDeclaration[] {
  return [
    {
      direction: PinDirection.INPUT,
      label: "in",
      defaultBitWidth: 1,
      position: { x: 0, y: 0 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
  ];
}

// ---------------------------------------------------------------------------
// LedElement â€” CircuitElement implementation
// ---------------------------------------------------------------------------

export class LedElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("LED", instanceId, position, rotation, mirror, props);
  }

  get color(): string {
    return this._properties.getOrDefault<string>("color", "red");
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildLedPinDeclarations(), []);
  }

  getBoundingBox(): Rect {
    // Circle at cx=0.8 r=0.75: minX = 0.8-0.75, maxX = 0.8+0.75, minY = -0.75, maxY = 0.75.
    // Use cx-r arithmetic to match ellipseSegments cardinal sentinel values exactly.
    const cx = 0.8, r = 0.75;
    return {
      x: this.position.x + (cx - r),
      y: this.position.y - r,
      width: 2 * r,
      height: 2 * r,
    };
  }

  draw(ctx: RenderContext): void {
    const label = this._visibleLabel();

    ctx.save();

    // Outer filled circle (body) at (0.8, 0) r=0.75
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);
    ctx.drawCircle(0.8, 0, 0.75, true);

    // Inner color zone circle at (0.8, 0) r=0.65 (OTHER/filled)
    ctx.drawCircle(0.8, 0, 0.65, true);

    // Label to the right
    ctx.setColor("TEXT");
    ctx.setFont({ family: "sans-serif", size: 0.7 });
    ctx.drawText(label, 2.25, 0, {
      horizontal: "left",
      vertical: "middle",
    });

    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// executeLed â€” reads input, writes to output slot for display state
// ---------------------------------------------------------------------------

export function executeLed(
  index: number,
  state: Uint32Array,
  _highZs: Uint32Array,
  layout: ComponentLayout,
): void {
  const wt = layout.wiringTable;
  const inputVal = state[wt[layout.inputOffset(index)]];
  state[wt[layout.outputOffset(index)]] = inputVal !== 0 ? 1 : 0;
}

// ---------------------------------------------------------------------------
// LED model parameter declarations
// ---------------------------------------------------------------------------

export const { paramDefs: LED_PARAM_DEFS, defaults: LED_DEFAULTS } = defineModelParams({
  primary: {
    IS: { default: 3.17e-19, unit: "A", description: "Saturation current" },
    N:  { default: 1.8,      unit: "",  description: "Ideality factor" },
  },
  secondary: {
    CJO:  { default: 0,      unit: "F", description: "Zero-bias junction capacitance" },
    VJ:   { default: 1,      unit: "V", description: "Junction built-in potential" },
    M:    { default: 0.5,               description: "Grading coefficient" },
    TT:   { default: 0,      unit: "s", description: "Transit time" },
    FC:   { default: 0.5,               description: "Forward-bias capacitance coefficient" },
    TEMP: { default: 300.15, unit: "K", description: "Per-instance operating temperature" },
    OFF:  { default: 0,                 description: "Initial condition: device off (0=false, 1=true)" },
  },
});

/** Minimum conductance for numerical stability. */
const LED_GMIN = 1e-12;

// ---------------------------------------------------------------------------
// State schema declarations
// ---------------------------------------------------------------------------

// Slot index constants â€” shared between both schema variants.
const SLOT_VD = 0, SLOT_GEQ = 1, SLOT_IEQ = 2, SLOT_ID = 3;
const SLOT_Q = 4, SLOT_CCAP = 5;

/** Schema for resistive LED (no junction capacitance): 4 slots. */
const LED_STATE_SCHEMA = defineStateSchema("LedAnalogElement", [
  { name: "VD",      doc: "LED junction voltage (V)",                           init: { kind: "zero" } },
  { name: "GEQ",     doc: "Linearized junction conductance (S)",                init: { kind: "constant", value: 1e-12 } },
  { name: "IEQ",     doc: "Linearized current source (A)",                      init: { kind: "zero" } },
  { name: "ID",      doc: "LED current (A)",                                    init: { kind: "zero" } },
]);

/** Schema for capacitive LED (CJO > 0 or TT > 0): 6 slots. */
export const LED_CAP_STATE_SCHEMA = defineStateSchema("LedAnalogElement_cap", [
  { name: "VD",   doc: "LED junction voltage (V)",                           init: { kind: "zero" } },
  { name: "GEQ",  doc: "Linearized junction conductance (S)",                init: { kind: "constant", value: 1e-12 } },
  { name: "IEQ",  doc: "Linearized current source (A)",                      init: { kind: "zero" } },
  { name: "ID",   doc: "LED current (A)",                                    init: { kind: "zero" } },
  { name: "Q",    doc: "Junction charge (NIintegrate history from s1/s2/s3)", init: { kind: "zero" } },
  { name: "CCAP", doc: "Companion current (NIintegrate history)",            init: { kind: "zero" } },
]);

// ---------------------------------------------------------------------------
// createLedAnalogElement â€” AnalogElement factory
// ---------------------------------------------------------------------------

function createLedAnalogElement(
  pinNodes: ReadonlyMap<string, number>,
  _internalNodeIds: readonly number[],
  _branchIdx: number,
  props: PropertyBag,
): AnalogElementCore {
  const nodeAnode = pinNodes.get("in")!;
  // Single-pin LED: cathode is implicitly ground (node 0)
  const nodeCathode = 0;

  const params: Record<string, number> = {
    IS:   props.getModelParam<number>("IS"),
    N:    props.getModelParam<number>("N"),
    CJO:  props.getModelParam<number>("CJO"),
    VJ:   props.getModelParam<number>("VJ"),
    M:    props.getModelParam<number>("M"),
    TT:   props.getModelParam<number>("TT"),
    FC:   props.getModelParam<number>("FC"),
    TEMP: props.getModelParam<number>("TEMP"),
    OFF:  props.getModelParam<number>("OFF"),
  };

  const hasCapacitance = params.CJO > 0 || params.TT > 0;

  // cite: dioload.c / diotemp.c â€” per-instance TEMP (maps to ngspice DIOtemp)
  let ledTp = { vt: params.TEMP * CONSTboltz / CHARGE };
  function recomputeLedTp(): void {
    ledTp = { vt: params.TEMP * CONSTboltz / CHARGE };
  }

  // Pool reference â€” set by initState. State arrays accessed via pool.states[N]
  // at call time. No cached Float64Array refs.
  let pool: StatePoolRef;
  let base: number;

  // Ephemeral per-iteration pnjlim limiting flag
  let pnjlimLimited = false;

  const element: PoolBackedAnalogElementCore = {
    branchIndex: -1,
    isNonlinear: true,
    isReactive: hasCapacitance,
    poolBacked: true as const,
    stateSize: hasCapacitance ? 6 : 4,
    stateSchema: hasCapacitance ? LED_CAP_STATE_SCHEMA : LED_STATE_SCHEMA,
    stateBaseOffset: -1,

    initState(poolRef: StatePoolRef): void {
      pool = poolRef;
      base = this.stateBaseOffset;
      applyInitialValues(this.stateSchema, pool, base, params);
    },

    load(this: PoolBackedAnalogElementCore, ctx: LoadContext): void {
      // Access state arrays at call time â€” no cached Float64Array refs.
      const s0 = pool.states[0];
      const s1 = pool.states[1];
      const s2 = pool.states[2];
      const s3 = pool.states[3];

      const voltages = ctx.rhsOld;
      const nVt = params.N * ledTp.vt;
      const vcrit = nVt * Math.log(nVt / (params.IS * Math.SQRT2));

      let vdRaw: number;
      let vdLimited: number;

      if (ctx.cktMode & MODEINITJCT) {
        // LED MODEINITJCT: seed junction from vcrit (or 0 if device is OFF).
        vdRaw = params.OFF ? 0 : vcrit;
        vdLimited = vdRaw;
        pnjlimLimited = false;
      } else {
        const va = voltages[nodeAnode];
        const vc = voltages[nodeCathode];
        vdRaw = va - vc;
        const vdOld = s0[base + SLOT_VD];
        const vdResult = pnjlim(vdRaw, vdOld, nVt, vcrit);
        vdLimited = vdResult.value;
        pnjlimLimited = vdResult.limited;
        if (pnjlimLimited) ctx.noncon.value++;
      }

      s0[base + SLOT_VD] = vdLimited;

      if (ctx.limitingCollector) {
        ctx.limitingCollector.push({
          elementIndex: this.elementIndex ?? -1,
          label: this.label ?? "",
          junction: "AK",
          limitType: "pnjlim",
          vBefore: vdRaw,
          vAfter: vdLimited,
          wasLimited: pnjlimLimited,
        });
      }

      const expVal = Math.exp(vdLimited / nVt);
      const idRaw = params.IS * (expVal - 1);
      const gdRaw = (params.IS * expVal) / nVt;
      const gd = gdRaw + LED_GMIN;
      const id = idRaw + LED_GMIN * vdLimited;
      s0[base + SLOT_ID] = id;
      s0[base + SLOT_GEQ] = gd;
      const ieq = id - gd * vdLimited;
      s0[base + SLOT_IEQ] = ieq;

      const solver = ctx.solver;
      stampG(solver, nodeAnode, nodeAnode, gd);
      stampG(solver, nodeAnode, nodeCathode, -gd);
      stampG(solver, nodeCathode, nodeAnode, -gd);
      stampG(solver, nodeCathode, nodeCathode, gd);
      stampRHS(solver, nodeAnode, -ieq);
      stampRHS(solver, nodeCathode, ieq);

      if (hasCapacitance && (ctx.cktMode & (MODETRAN | MODEAC))) {
        const order = ctx.order;
        const method = ctx.method;

        // Depletion + transit-time capacitance at current operating point
        const Cj = computeJunctionCapacitance(vdLimited, params.CJO, params.VJ, params.M, params.FC);
        const Ct = params.TT * gdRaw;
        const Ctotal = Cj + Ct;

        const q0 = computeJunctionCharge(vdLimited, params.CJO, params.VJ, params.M, params.FC, params.TT, idRaw);
        const q1 = s1[base + SLOT_Q];
        const q2 = s2[base + SLOT_Q];
        const q3 = s3[base + SLOT_Q];
        const ag = ctx.ag;
        const ccapPrev = s1[base + SLOT_CCAP];
        const { ccap, geq: capGeq } = niIntegrate(
          method,
          order,
          Ctotal,
          ag,
          q0, q1,
          [q2, q3, 0, 0, 0],
          ccapPrev,
        );
        const capIeq = ccap - capGeq * vdLimited;
        s0[base + SLOT_Q] = q0;
        s0[base + SLOT_CCAP] = ccap;

        if (capGeq !== 0 || capIeq !== 0) {
          stampG(solver, nodeAnode, nodeAnode, capGeq);
          stampG(solver, nodeAnode, nodeCathode, -capGeq);
          stampG(solver, nodeCathode, nodeAnode, -capGeq);
          stampG(solver, nodeCathode, nodeCathode, capGeq);
          stampRHS(solver, nodeAnode, -capIeq);
          stampRHS(solver, nodeCathode, capIeq);
        }
      }
    },

    getPinCurrents(_voltages: Readonly<Float64Array>): number[] {
      // pinLayout order: [in (anode)]. Cathode is implicit ground.
      // Positive = current flowing INTO element at that pin.
      const id = pool.states[0][base + SLOT_ID];
      return [id];
    },

    checkConvergence(ctx: LoadContext): boolean {
      // If voltage was limited in load(), declare non-convergence immediately.
      if (pnjlimLimited) return false;

      const s0 = pool.states[0];
      const voltages = ctx.rhsOld;
      const va = voltages[nodeAnode];
      const vc = voltages[nodeCathode];
      const vdRaw = va - vc;

      // Current-prediction convergence test
      const delvd = vdRaw - s0[base + SLOT_VD];
      const id = s0[base + SLOT_ID];
      const gd = s0[base + SLOT_GEQ];
      const cdhat = id + gd * delvd;
      const tol = ctx.reltol * Math.max(Math.abs(cdhat), Math.abs(id)) + ctx.iabstol;
      return Math.abs(cdhat - id) <= tol;
    },

    setParam(key: string, value: number): void {
      if (key in params) {
        params[key] = value;
        if (key === "TEMP") recomputeLedTp();
      }
    },
  };

  // Attach getLteTimestep only when junction capacitance is present
  if (hasCapacitance) {
    (element as unknown as { getLteTimestep: (dt: number, deltaOld: readonly number[], order: number, method: IntegrationMethod, lteParams: LteParams) => number }).getLteTimestep = function (
      dt: number,
      deltaOld: readonly number[],
      order: number,
      method: IntegrationMethod,
      lteParams: LteParams,
    ): number {
      const _q0 = pool.states[0][base + SLOT_Q];
      const _q1 = pool.states[1][base + SLOT_Q];
      const _q2 = pool.states[2][base + SLOT_Q];
      const _q3 = pool.states[3][base + SLOT_Q];
      const ccap0 = pool.states[0][base + SLOT_CCAP];
      const ccap1 = pool.states[1][base + SLOT_CCAP];
      return cktTerr(dt, deltaOld, order, method, _q0, _q1, _q2, _q3, ccap0, ccap1, lteParams);
    };
  }

  return element;
}

// ---------------------------------------------------------------------------
// LED_ATTRIBUTE_MAPPINGS
// ---------------------------------------------------------------------------

export const LED_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  {
    xmlName: "Label",
    propertyKey: "label",
    convert: (v) => v,
  },
  {
    xmlName: "Color",
    propertyKey: "color",
    convert: (v) => v,
  },
  {
    xmlName: "Color",
    propertyKey: "model",
    convert: (v) => v.toLowerCase(),
  },
];

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const LED_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "label",
    type: PropertyType.STRING,
    label: "Label",
    defaultValue: "",
    description: "Label shown above the LED",
  },
  {
    key: "color",
    type: PropertyType.COLOR,
    label: "Color",
    defaultValue: "red",
    description: "LED color when lit",
  },
];

// ---------------------------------------------------------------------------
// LedDefinition
// ---------------------------------------------------------------------------

function ledFactory(props: PropertyBag): LedElement {
  return new LedElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const LedDefinition: ComponentDefinition = {
  name: "LED",
  typeId: -1,
  factory: ledFactory,
  pinLayout: buildLedPinDeclarations(),
  propertyDefs: LED_PROPERTY_DEFS,
  attributeMap: LED_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.IO,
  helpText:
    "LED â€” single-color light-emitting diode indicator.\n" +
    "Lights up (filled circle) when the input is non-zero.\n" +
    "Color is configurable. Label is shown above the component.",
  models: {
    digital: { executeFn: executeLed, inputSchema: ["in"], outputSchema: [] },
  },
  modelRegistry: {
    red:    { kind: "inline", factory: createLedAnalogElement, paramDefs: LED_PARAM_DEFS, params: { IS: 3.17e-19, N: 1.8 } },
    green:  { kind: "inline", factory: createLedAnalogElement, paramDefs: LED_PARAM_DEFS, params: { IS: 1e-21,    N: 2.0 } },
    blue:   { kind: "inline", factory: createLedAnalogElement, paramDefs: LED_PARAM_DEFS, params: { IS: 6.26e-24, N: 2.5 } },
    yellow: { kind: "inline", factory: createLedAnalogElement, paramDefs: LED_PARAM_DEFS, params: { IS: 1e-20,    N: 1.9 } },
    white:  { kind: "inline", factory: createLedAnalogElement, paramDefs: LED_PARAM_DEFS, params: { IS: 6.26e-24, N: 2.5 } },
  },
  defaultModel: "digital",
};
