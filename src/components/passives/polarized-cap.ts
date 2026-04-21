/**
 * Polarized electrolytic capacitor analog component.
 *
 * Extends the standard capacitor companion model with three additional effects:
 *   - ESR (equivalent series resistance): a series conductance between an
 *     internal node and the positive terminal
 *   - Leakage current: a parallel conductance across the full component
 *   - Polarity enforcement: emits a diagnostic when the anode voltage falls
 *     below the cathode voltage beyond a configurable reverse threshold
 *
 * Topology (MNA):
 *   pos ─── ESR ─── capNode ─── capacitor+leakage ─── neg
 *
 * Three MNA nodes are used:
 *   pinNodeIds[0] = n_pos  (positive terminal / anode)
 *   pinNodeIds[1] = n_neg  (negative terminal / cathode)
 *   pinNodeIds[2] = n_cap  (internal node between ESR and capacitor body)
 *
 * Elements stamped inside load() every NR iteration:
 *   - ESR conductance between n_pos and n_cap
 *   - Leakage conductance between n_cap and n_neg
 *   - Capacitor companion model (geq + ieq) between n_cap and n_neg,
 *     computed inline with ctx.ag[] (NIintegrate)
 *   - Polarity check: emits a reverse-biased-cap diagnostic when
 *     V(pos) < V(neg) − reverseMax
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
import type { AnalogElementCore, ReactiveAnalogElement, IntegrationMethod, LoadContext } from "../../solver/analog/element.js";
import { MODETRAN, MODETRANOP, MODEINITPRED, MODEINITTRAN } from "../../solver/analog/ckt-mode.js";
import { stampG } from "../../solver/analog/stamp-helpers.js";
import type { Diagnostic } from "../../compile/types.js";
import { defineModelParams } from "../../core/model-params.js";
import {
  defineStateSchema,
  applyInitialValues,
  type StateSchema,
} from "../../solver/analog/state-schema.js";
import type { StatePoolRef } from "../../core/analog-types.js";
import { cktTerr } from "../../solver/analog/ckt-terr.js";
import { niIntegrate } from "../../solver/analog/ni-integrate.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MIN_RESISTANCE = 1e-9;

// ---------------------------------------------------------------------------
// State schema
// ---------------------------------------------------------------------------

// Slot layout — 5 slots total. Previous values are read from s1/s2/s3
// at the same offsets (pointer-rotation history).
const POLARIZED_CAP_SCHEMA: StateSchema = defineStateSchema("AnalogPolarizedCapElement", [
  { name: "GEQ",  doc: "Companion conductance",       init: { kind: "zero" } },
  { name: "IEQ",  doc: "Companion history current",   init: { kind: "zero" } },
  { name: "V",    doc: "Terminal voltage this step",  init: { kind: "zero" } },
  { name: "Q",    doc: "Charge Q=C*V this step",      init: { kind: "zero" } },
  { name: "CCAP", doc: "Companion current (NIintegrate)", init: { kind: "zero" } },
]);

const SLOT_GEQ  = 0;
const SLOT_IEQ  = 1;
const SLOT_V    = 2;
const SLOT_Q    = 3;
const SLOT_CCAP = 4;

// ---------------------------------------------------------------------------
// Model parameter declarations
// ---------------------------------------------------------------------------

export const { paramDefs: POLARIZED_CAP_PARAM_DEFS, defaults: POLARIZED_CAP_MODEL_DEFAULTS } = defineModelParams({
  primary: {
    capacitance:    { default: 100e-6, unit: "F", description: "Capacitance in farads", min: 1e-12 },
    esr:            { default: 0.1,    unit: "Ω", description: "Equivalent series resistance in ohms", min: 0 },
  },
  secondary: {
    leakageCurrent: { default: 1e-6,  unit: "A", description: "DC leakage current at rated voltage", min: 0 },
    voltageRating:  { default: 25,    unit: "V", description: "Maximum rated voltage", min: 1 },
    reverseMax:     { default: 1.0,   unit: "V", description: "Reverse voltage threshold that triggers a polarity warning", min: 0 },
  },
});

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

function buildPolarizedCapPinDeclarations(): PinDeclaration[] {
  return [
    {
      direction: PinDirection.INPUT,
      label: "pos",
      defaultBitWidth: 1,
      position: { x: 0, y: 0 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.OUTPUT,
      label: "neg",
      defaultBitWidth: 1,
      position: { x: 4, y: 0 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
  ];
}

// ---------------------------------------------------------------------------
// PolarizedCapElement — AbstractCircuitElement (editor/visual layer)
// ---------------------------------------------------------------------------

export class PolarizedCapElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("PolarizedCap", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildPolarizedCapPinDeclarations(), []);
  }

  getBoundingBox(): Rect {
    return {
      x: this.position.x,
      y: this.position.y - 0.75,
      width: 4,
      height: 1.5 + 1e-10,
    };
  }

  draw(ctx: RenderContext, signals?: PinVoltageAccess): void {
    const label = this._visibleLabel();

    ctx.save();
    ctx.setLineWidth(1);

    const vPos = signals?.getPinVoltage("pos");
    const vNeg = signals?.getPinVoltage("neg");
    const hasVoltage = vPos !== undefined && vNeg !== undefined;

    const PX = 1 / 16;
    const plateOffset = 28 * PX; // 1.75 — matches Falstad lead length (28px)

    // Left lead — colored by pos voltage
    drawColoredLead(ctx, hasVoltage ? signals : undefined, vPos, 0, 0, plateOffset, 0);

    // Right lead — colored by neg voltage
    drawColoredLead(ctx, hasVoltage ? signals : undefined, vNeg, 4, 0, 4 - plateOffset, 0);

    // Plate 1 — straight line (positive/anode plate)
    if (hasVoltage && ctx.setLinearGradient) {
      ctx.setLinearGradient(plateOffset, 0, 4 - plateOffset, 0, [
        { offset: 0, color: signals!.voltageColor(vPos) },
        { offset: 1, color: signals!.voltageColor(vNeg) },
      ]);
    } else {
      ctx.setColor("COMPONENT");
    }
    ctx.drawLine(plateOffset, -0.75, plateOffset, 0.75);

    // Plate 2 — curved (exact Falstad 7-segment polyline)
    // Falstad pixel coords: (41,-12),(37,-9),(36,-5),(36,-2),(36,2),(36,5),(37,9),(41,12)
    // Grid coords (÷16):   (2.5625,-0.75),(2.3125,-0.5625),(2.25,-0.3125),(2.25,-0.125),
    //                      (2.25,0.125),(2.25,0.3125),(2.3125,0.5625),(2.5625,0.75)
    if (hasVoltage && ctx.setLinearGradient) {
      ctx.setLinearGradient(plateOffset, 0, 4 - plateOffset, 0, [
        { offset: 0, color: signals!.voltageColor(vPos) },
        { offset: 1, color: signals!.voltageColor(vNeg) },
      ]);
    } else {
      ctx.setColor("COMPONENT");
    }
    const curvedPts: [number, number][] = [
      [2.5625, -0.75],
      [2.3125, -0.5625],
      [2.25, -0.3125],
      [2.25, -0.125],
      [2.25, 0.125],
      [2.25, 0.3125],
      [2.3125, 0.5625],
      [2.5625, 0.75],
    ];
    for (let i = 0; i < curvedPts.length - 1; i++) {
      ctx.drawLine(curvedPts[i][0], curvedPts[i][1], curvedPts[i + 1][0], curvedPts[i + 1][1]);
    }

    // Polarity marker "+" at anode side
    ctx.setColor("TEXT");
    ctx.setFont({ family: "sans-serif", size: 0.7 });
    ctx.drawText("+", 0.9375, 0.625, { horizontal: "center", vertical: "top" });

    if (label.length > 0) {
      ctx.setColor("TEXT");
      ctx.setFont({ family: "sans-serif", size: 0.7 });
      ctx.drawText(label, 1.6875, -0.875, { horizontal: "center", vertical: "top" });
    }

    ctx.restore();
  }

}


// ---------------------------------------------------------------------------
// AnalogPolarizedCapElement — MNA implementation
// ---------------------------------------------------------------------------

export class AnalogPolarizedCapElement implements ReactiveAnalogElement {
  readonly pinNodeIds: readonly number[];
  readonly allNodeIds: readonly number[];
  readonly branchIndex: number = -1;
  readonly isNonlinear: boolean = true;
  readonly isReactive = true;
  readonly poolBacked = true as const;
  setParam(_key: string, _value: number): void {}

  readonly stateSchema = POLARIZED_CAP_SCHEMA;
  readonly stateSize = POLARIZED_CAP_SCHEMA.size; // 5 slots
  stateBaseOffset = -1;

  private C: number;
  private G_esr: number;
  private G_leak: number;
  private reverseMax: number;
  s0!: Float64Array;
  s1!: Float64Array;
  s2!: Float64Array;
  s3!: Float64Array;
  s4!: Float64Array;
  s5!: Float64Array;
  s6!: Float64Array;
  s7!: Float64Array;
  private base!: number;

  private readonly _emitDiagnostic: (diag: Diagnostic) => void;
  private _reverseBiasDiagEmitted: boolean = false;

  /**
   * @param pinNodeIds    - [n_pos, n_neg, n_cap] — n_cap is the internal node
   * @param capacitance    - Capacitance in farads
   * @param esr            - Equivalent series resistance in ohms
   * @param rLeak          - Leakage resistance in ohms (V_rated / I_leak)
   * @param reverseMax     - Reverse voltage threshold in volts (positive value)
   * @param emitDiagnostic - Callback invoked when polarity violation is detected
   */
  constructor(
    pinNodeIds: number[],
    capacitance: number,
    esr: number,
    rLeak: number,
    reverseMax: number,
    emitDiagnostic?: (diag: Diagnostic) => void,
  ) {
    this.pinNodeIds = pinNodeIds;
    this.allNodeIds = pinNodeIds;
    this.C = capacitance;
    this.G_esr = 1 / Math.max(esr, MIN_RESISTANCE);
    this.G_leak = 1 / Math.max(rLeak, MIN_RESISTANCE);
    this.reverseMax = reverseMax;
    this._emitDiagnostic = emitDiagnostic ?? (() => {});
  }

  initState(pool: StatePoolRef): void {
    this.s0 = pool.states[0];
    this.s1 = pool.states[1];
    this.s2 = pool.states[2];
    this.s3 = pool.states[3];
    this.s4 = pool.states[4];
    this.s5 = pool.states[5];
    this.s6 = pool.states[6];
    this.s7 = pool.states[7];
    this.base = this.stateBaseOffset;
    applyInitialValues(POLARIZED_CAP_SCHEMA, pool, this.base, {});
  }

  /**
   * Unified load() — ESR + leakage stamps + capacitor companion + polarity check.
   *
   * Topology: pos ── ESR ── nCap ── (C || leakage) ── neg.
   * Stamps in one pass:
   *   - ESR conductance between nPos and nCap (topology-constant, stamped always).
   *   - Leakage conductance between nCap and nNeg (topology-constant).
   *   - Capacitor companion (geq, ceq) between nCap and nNeg using inline
   *     NIintegrate with ctx.ag[].
   *   - Polarity diagnostic when reverse-biased beyond reverseMax.
   */
  load(ctx: LoadContext): void {
    const { solver, voltages, ag } = ctx;
    const mode = ctx.cktMode;
    const nPos = this.pinNodeIds[0];
    const nNeg = this.pinNodeIds[1];
    const nCap = this.pinNodeIds[2];

    // ESR conductance (nPos ↔ nCap).
    stampG(solver, nPos, nPos, this.G_esr);
    stampG(solver, nPos, nCap, -this.G_esr);
    stampG(solver, nCap, nPos, -this.G_esr);
    stampG(solver, nCap, nCap, this.G_esr);

    // Leakage conductance (nCap ↔ nNeg).
    stampG(solver, nCap, nCap, this.G_leak);
    stampG(solver, nCap, nNeg, -this.G_leak);
    stampG(solver, nNeg, nCap, -this.G_leak);
    stampG(solver, nNeg, nNeg, this.G_leak);

    // Polarity detection — check anode vs cathode voltage.
    const vAnode = nPos > 0 ? voltages[nPos - 1] : 0;
    const vCathode = nNeg > 0 ? voltages[nNeg - 1] : 0;
    const vDiff = vAnode - vCathode;
    if (vDiff < -this.reverseMax) {
      if (!this._reverseBiasDiagEmitted) {
        this._reverseBiasDiagEmitted = true;
        this._emitDiagnostic({
          code: "reverse-biased-cap",
          severity: "warning",
          message: `Polarized capacitor reverse biased by ${(-vDiff).toFixed(2)} V (threshold: ${this.reverseMax} V)`,
          explanation:
            "Electrolytic capacitors are damaged by reverse bias. " +
            "Check circuit polarity and ensure the anode (positive terminal) " +
            "is at a higher potential than the cathode.",
          suggestions: [
            {
              text: "Reverse the capacitor polarity in the schematic.",
              automatable: false,
            },
          ],
        });
      }
    } else {
      this._reverseBiasDiagEmitted = false;
    }

    // Capacitor body (between nCap and nNeg).
    if (!(mode & (MODETRAN | MODETRANOP))) return;
    const C = this.C;

    const vCapNode = nCap > 0 ? voltages[nCap - 1] : 0;
    const vNegNode = nNeg > 0 ? voltages[nNeg - 1] : 0;
    const vNow = vCapNode - vNegNode;

    if (mode & MODETRAN) {
      // Charge update (capload.c pattern).
      if (mode & MODEINITPRED) {
        this.s0[this.base + SLOT_Q] = this.s1[this.base + SLOT_Q];
      } else {
        this.s0[this.base + SLOT_Q] = C * vNow;
        if (mode & MODEINITTRAN) {
          this.s1[this.base + SLOT_Q] = this.s0[this.base + SLOT_Q];
        }
      }

      const q0 = this.s0[this.base + SLOT_Q];
      const q1 = this.s1[this.base + SLOT_Q];
      const q2 = this.s2[this.base + SLOT_Q];
      const q3 = this.s3[this.base + SLOT_Q];
      const ccapPrev = this.s1[this.base + SLOT_CCAP];
      const { ccap, ceq, geq } = niIntegrate(
        ctx.method,
        ctx.order,
        C,
        ag,
        q0, q1,
        [q2, q3, 0, 0, 0],
        ccapPrev,
      );
      this.s0[this.base + SLOT_CCAP] = ccap;

      if (mode & MODEINITTRAN) {
        this.s1[this.base + SLOT_CCAP] = this.s0[this.base + SLOT_CCAP];
      }

      this.s0[this.base + SLOT_GEQ] = geq;
      this.s0[this.base + SLOT_IEQ] = ceq;
      this.s0[this.base + SLOT_V]   = vNow;

      // Stamp companion between nCap and nNeg.
      stampG(solver, nCap, nCap, geq);
      stampG(solver, nCap, nNeg, -geq);
      stampG(solver, nNeg, nCap, -geq);
      stampG(solver, nNeg, nNeg, geq);
      if (nCap !== 0) solver.stampRHS(nCap - 1, -ceq);
      if (nNeg !== 0) solver.stampRHS(nNeg - 1, ceq);
    } else {
      // DC operating point.
      this.s0[this.base + SLOT_Q] = C * vNow;
      this.s0[this.base + SLOT_V] = vNow;
      this.s0[this.base + SLOT_GEQ] = 0;
      this.s0[this.base + SLOT_IEQ] = 0;
    }
  }

  getPinCurrents(voltages: Float64Array): number[] {
    const nPos = this.pinNodeIds[0];
    const nCap = this.pinNodeIds[2];
    const vPos = nPos > 0 ? voltages[nPos - 1] : 0;
    const vCap = nCap > 0 ? voltages[nCap - 1] : 0;
    // Current into pos pin = current through ESR flowing into the element
    const I = this.G_esr * (vPos - vCap);
    return [I, -I];
  }

  updatePhysicalParams(C: number, G_esr: number, G_leak: number, reverseMax: number): void {
    this.C = C;
    this.G_esr = G_esr;
    this.G_leak = G_leak;
    this.reverseMax = reverseMax;
  }

  getLteTimestep(
    dt: number,
    deltaOld: readonly number[],
    order: number,
    method: IntegrationMethod,
    lteParams: import("../../solver/analog/ckt-terr.js").LteParams,
  ): number {
    const q0 = this.s0[this.base + SLOT_Q];
    const q1 = this.s1[this.base + SLOT_Q];
    const q2 = this.s2[this.base + SLOT_Q];
    const q3 = this.s3[this.base + SLOT_Q];
    const ccap0 = this.s0[this.base + SLOT_CCAP];
    const ccap1 = this.s1[this.base + SLOT_CCAP];
    return cktTerr(dt, deltaOld, order, method, q0, q1, q2, q3, ccap0, ccap1, lteParams);
  }
}

// ---------------------------------------------------------------------------
// analogFactory
// ---------------------------------------------------------------------------

function buildPolarizedCapFromParams(
  pinNodes: ReadonlyMap<string, number>,
  internalNodeIds: readonly number[],
  p: { capacitance: number; esr: number; leakageCurrent: number; voltageRating: number; reverseMax: number },
): AnalogElementCore {
  const rLeak = p.leakageCurrent > 0 ? p.voltageRating / p.leakageCurrent : 1e12;

  // nodeIds = [n_pos, n_neg, n_cap_internal] — compiler provides the internal node
  const el = new AnalogPolarizedCapElement(
    [pinNodes.get("pos")!, pinNodes.get("neg")!, internalNodeIds[0]],
    p.capacitance,
    p.esr,
    rLeak,
    p.reverseMax,
  );

  (el as AnalogElementCore).setParam = function(key: string, value: number): void {
    if (key in p) {
      (p as Record<string, number>)[key] = value;
      const newRLeak = p.leakageCurrent > 0 ? p.voltageRating / p.leakageCurrent : 1e12;
      el.updatePhysicalParams(
        p.capacitance,
        1 / Math.max(p.esr, MIN_RESISTANCE),
        1 / Math.max(newRLeak, MIN_RESISTANCE),
        p.reverseMax,
      );
    }
  };
  return el;
}

function createPolarizedCapElement(
  pinNodes: ReadonlyMap<string, number>,
  internalNodeIds: readonly number[],
  _branchIdx: number,
  props: PropertyBag,
): AnalogElementCore {
  const p = {
    capacitance:    props.getModelParam<number>("capacitance"),
    esr:            props.getModelParam<number>("esr"),
    leakageCurrent: props.getModelParam<number>("leakageCurrent"),
    voltageRating:  props.getModelParam<number>("voltageRating"),
    reverseMax:     props.getModelParam<number>("reverseMax"),
  };
  return buildPolarizedCapFromParams(pinNodes, internalNodeIds, p);
}

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const POLARIZED_CAP_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "leakageCurrent",
    type: PropertyType.FLOAT,
    label: "Leakage Current (A)",
    unit: "A",
    defaultValue: 1e-6,
    min: 0,
    description: "DC leakage current at rated voltage",
  },
  {
    key: "voltageRating",
    type: PropertyType.FLOAT,
    label: "Voltage Rating (V)",
    unit: "V",
    defaultValue: 25,
    min: 1,
    description: "Maximum rated voltage",
  },
  {
    key: "reverseMax",
    type: PropertyType.FLOAT,
    label: "Reverse Threshold (V)",
    unit: "V",
    defaultValue: 1.0,
    min: 0,
    description: "Reverse voltage threshold that triggers a polarity warning",
  },
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

export const POLARIZED_CAP_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  {
    xmlName: "capacitance",
    propertyKey: "capacitance",
    modelParam: true,
    convert: (v) => parseFloat(v),
  },
  {
    xmlName: "esr",
    propertyKey: "esr",
    modelParam: true,
    convert: (v) => parseFloat(v),
  },
  {
    xmlName: "leakageCurrent",
    propertyKey: "leakageCurrent",
    convert: (v) => parseFloat(v),
  },
  {
    xmlName: "voltageRating",
    propertyKey: "voltageRating",
    convert: (v) => parseFloat(v),
  },
  {
    xmlName: "reverseMax",
    propertyKey: "reverseMax",
    convert: (v) => parseFloat(v),
  },
  {
    xmlName: "Label",
    propertyKey: "label",
    convert: (v) => v,
  },
];

// ---------------------------------------------------------------------------
// PolarizedCapDefinition
// ---------------------------------------------------------------------------

function polarizedCapCircuitFactory(props: PropertyBag): PolarizedCapElement {
  return new PolarizedCapElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const PolarizedCapDefinition: ComponentDefinition = {
  name: "PolarizedCap",
  typeId: -1,
  factory: polarizedCapCircuitFactory,
  pinLayout: buildPolarizedCapPinDeclarations(),
  propertyDefs: POLARIZED_CAP_PROPERTY_DEFS,
  attributeMap: POLARIZED_CAP_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.PASSIVES,
  helpText:
    "Polarized electrolytic capacitor — extends the standard capacitor with ESR,\n" +
    "leakage current, and reverse-bias polarity enforcement.",
  models: {},
  modelRegistry: {
    "behavioral": {
      kind: "inline",
      factory: createPolarizedCapElement,
      paramDefs: POLARIZED_CAP_PARAM_DEFS,
      params: POLARIZED_CAP_MODEL_DEFAULTS,
    },
  },
  defaultModel: "behavioral",
};
