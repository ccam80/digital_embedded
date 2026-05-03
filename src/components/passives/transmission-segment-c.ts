/**
 * TransmissionSegmentC- internal-only shunt-capacitance segment for the
 * lossy transmission-line composite.
 *
 * Per Composite M6 (phase-composite-architecture.md), J-065
 * (contracts_group_05.md). Emitted by `buildTransmissionLineNetlist` in
 * `transmission-line.ts` as the shunt capacitance at each segment junction
 * (`seg{k}_C`, k = 0..N-2).
 *
 * Template C variant: companion-model state + no branch + 1 pin. The
 * capacitor's other terminal is implicit GND (node 0); only the
 * (junc, junc) diagonal handle is allocated. See
 * `transmission-segment-l.ts` for the canonical Template C exemplar
 * (companion + branch + 2 pins) and `transmission-segment-g.ts` for the
 * stateless 1-pin variant.
 *
 * Stamp math is a verbatim port of ngspice CAPload (capload.c) reduced to
 * the single-pin-to-GND case- equivalent to the user-facing `Capacitor`
 * (`src/components/passives/capacitor.ts`) with `negNode === 0`. Stripped
 * of TC1/TC2/TNOM/SCALE/M and IC handling that the segment never receives.
 */

import type { AnalogElement, PoolBackedAnalogElement } from "../../solver/analog/element.js";
import type { IntegrationMethod } from "../../solver/analog/integration.js";
import type { LoadContext } from "../../solver/analog/load-context.js";
import type { SetupContext } from "../../solver/analog/setup-context.js";
import type { StatePoolRef } from "../../solver/analog/state-pool.js";
import { NGSPICE_LOAD_ORDER } from "../../solver/analog/ngspice-load-order.js";
import { cktTerr } from "../../solver/analog/ckt-terr.js";
import { niIntegrate } from "../../solver/analog/ni-integrate.js";
import { stampRHS } from "../../solver/analog/stamp-helpers.js";
import {
  MODETRAN, MODEAC, MODETRANOP, MODEDC,
  MODEINITJCT, MODEINITTRAN, MODEINITPRED,
} from "../../solver/analog/ckt-mode.js";
import {
  defineStateSchema,
  type StateSchema,
} from "../../solver/analog/state-schema.js";
import { PinDirection, type PinDeclaration } from "../../core/pin.js";
import { PropertyBag } from "../../core/properties.js";
import type { ComponentDefinition, ParamDef } from "../../core/registry.js";

// ---------------------------------------------------------------------------
// Model parameter declarations
// ---------------------------------------------------------------------------

const MIN_CAPACITANCE = 1e-15;

const TRANSMISSION_SEGMENT_C_PARAM_DEFS: ParamDef[] = [
  { key: "C", default: 1e-12 },
];

const TRANSMISSION_SEGMENT_C_DEFAULTS: Record<string, number> = { C: 1e-12 };

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

const TRANSMISSION_SEGMENT_C_PIN_LAYOUT: PinDeclaration[] = [
  { direction: PinDirection.INPUT, label: "junc", defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
];

// ---------------------------------------------------------------------------
// State schema- mirrors AnalogCapacitorElement (capacitor.ts), 5 slots.
// Matches ngspice CAPstate semantics; ngspice itself uses 2 (q, ccap) and
// derives the rest, but digiTS allocates the full set so load() can write
// every cached field for diagnostic readout.
// ---------------------------------------------------------------------------

const SCHEMA: StateSchema = defineStateSchema("TransmissionSegmentC", [
  { name: "GEQ",  doc: "Companion conductance" },
  { name: "IEQ",  doc: "Companion history current" },
  { name: "V",    doc: "Terminal voltage this step" },
  { name: "Q",    doc: "Charge Q = C*V this step" },
  { name: "CCAP", doc: "Companion current (NIintegrate)" },
]);

const SLOT_GEQ  = SCHEMA.indexOf.get("GEQ")!;
const SLOT_IEQ  = SCHEMA.indexOf.get("IEQ")!;
const SLOT_V    = SCHEMA.indexOf.get("V")!;
const SLOT_Q    = SCHEMA.indexOf.get("Q")!;
const SLOT_CCAP = SCHEMA.indexOf.get("CCAP")!;

// ---------------------------------------------------------------------------
// TransmissionSegmentCElement
// ---------------------------------------------------------------------------

export class TransmissionSegmentCElement implements PoolBackedAnalogElement {
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.CAP;
  readonly poolBacked = true as const;
  readonly stateSchema = SCHEMA;
  readonly stateSize = SCHEMA.size;

  label = "";
  _pinNodes: Map<string, number>;
  _stateBase = -1;
  branchIndex = -1;

  private _C: number;
  private _pool!: StatePoolRef;

  // Single diagonal handle- ngspice CAPposPosptr reduced for the GND-side
  // implicit reference (capsetup.c:114-117 with negNode === 0).
  private _hJJ = -1;

  constructor(pinNodes: ReadonlyMap<string, number>, props: PropertyBag) {
    this._pinNodes = new Map(pinNodes);
    this._C = Math.max(props.getModelParam<number>("C"), MIN_CAPACITANCE);
  }

  setup(ctx: SetupContext): void {
    const juncNode = this._pinNodes.get("junc")!;

    // capsetup.c:102-103- *states += stateSize.
    this._stateBase = ctx.allocStates(this.stateSize);

    if (juncNode !== 0) {
      this._hJJ = ctx.solver.allocElement(juncNode, juncNode);
    }
  }

  initState(pool: StatePoolRef): void {
    this._pool = pool;
  }

  setParam(key: string, value: number): void {
    if (key === "C") {
      this._C = Math.max(value, MIN_CAPACITANCE);
    }
  }

  /**
   * load()- 1:1 port of ngspice capload.c CAPload, reduced for negNode === 0
   * (single-pin-to-GND). See `capacitor.ts` AnalogCapacitorElement.load() for
   * the full-fidelity two-pin version with structural commentary.
   */
  load(ctx: LoadContext): void {
    const { solver, rhsOld: voltages, ag, cktMode: mode } = ctx;
    const n = this._pinNodes.get("junc")!;
    const C = this._C;
    const base = this._stateBase;
    const s0 = this._pool.states[0];
    const s1 = this._pool.states[1];
    const s2 = this._pool.states[2];
    const s3 = this._pool.states[3];

    // capload.c:30- participate only in MODETRAN | MODEAC | MODETRANOP.
    if (!(mode & (MODETRAN | MODEAC | MODETRANOP))) return;

    // capload.c:32-36- IC gate. The segment never receives UIC, so this
    // simplifies to the DC | INITJCT branch only.
    const cond1 = (mode & MODEDC) && (mode & MODEINITJCT);
    const vcap = cond1 ? 0 : voltages[n];

    if (mode & (MODETRAN | MODEAC)) {
      // capload.c:53-65 (#ifndef PREDICTOR).
      if (mode & MODEINITPRED) {
        s0[base + SLOT_Q] = s1[base + SLOT_Q];
      } else {
        s0[base + SLOT_Q] = C * vcap;
        if (mode & MODEINITTRAN) {
          s1[base + SLOT_Q] = s0[base + SLOT_Q];
        }
      }

      // capload.c:67-68- NIintegrate via shared helper.
      const q0 = s0[base + SLOT_Q];
      const q1 = s1[base + SLOT_Q];
      const q2 = s2[base + SLOT_Q];
      const q3 = s3[base + SLOT_Q];
      const ccapPrev = s1[base + SLOT_CCAP];
      const { ccap, ceq, geq } = niIntegrate(
        ctx.method,
        ctx.order,
        C,
        ag,
        q0, q1,
        [q2, q3, 0, 0, 0],
        ccapPrev,
      );
      s0[base + SLOT_CCAP] = ccap;

      // capload.c:70-72- seed first transient step.
      if (mode & MODEINITTRAN) {
        s1[base + SLOT_CCAP] = s0[base + SLOT_CCAP];
      }

      // Cache companion state for diagnostic / getPinCurrents.
      s0[base + SLOT_GEQ] = geq;
      s0[base + SLOT_IEQ] = ceq;
      s0[base + SLOT_V] = vcap;

      // capload.c:74-79- companion stamp reduced for negNode === 0.
      if (n !== 0) {
        solver.stampElement(this._hJJ, geq);
        stampRHS(ctx.rhs, n, -ceq);
      }
    } else {
      // capload.c:84- DC operating point: store charge, no matrix stamp.
      s0[base + SLOT_Q] = C * vcap;
      s0[base + SLOT_V] = vcap;
      s0[base + SLOT_GEQ] = 0;
      s0[base + SLOT_IEQ] = 0;
    }
  }

  getPinCurrents(rhs: Float64Array): number[] {
    const v = rhs[this._pinNodes.get("junc")!];
    const s0 = this._pool.states[0];
    const base = this._stateBase;
    const geq = s0[base + SLOT_GEQ];
    const ieq = s0[base + SLOT_IEQ];
    return [geq * v + ieq];
  }

  getLteTimestep(
    dt: number,
    deltaOld: readonly number[],
    order: number,
    method: IntegrationMethod,
    lteParams: import("../../solver/analog/ckt-terr.js").LteParams,
  ): number {
    const base = this._stateBase;
    const s0 = this._pool.states[0];
    const s1 = this._pool.states[1];
    const s2 = this._pool.states[2];
    const s3 = this._pool.states[3];
    return cktTerr(
      dt, deltaOld, order, method,
      s0[base + SLOT_Q], s1[base + SLOT_Q],
      s2[base + SLOT_Q], s3[base + SLOT_Q],
      s0[base + SLOT_CCAP], s1[base + SLOT_CCAP],
      lteParams,
    );
  }
}

// ---------------------------------------------------------------------------
// ComponentDefinition
// ---------------------------------------------------------------------------

export const TransmissionSegmentCDefinition: ComponentDefinition = {
  name: "TransmissionSegmentC",
  typeId: -1,
  internalOnly: true,
  pinLayout: TRANSMISSION_SEGMENT_C_PIN_LAYOUT,
  modelRegistry: {
    default: {
      kind: "inline",
      paramDefs: TRANSMISSION_SEGMENT_C_PARAM_DEFS,
      params: TRANSMISSION_SEGMENT_C_DEFAULTS,
      factory: (pinNodes: ReadonlyMap<string, number>, props: PropertyBag, _getTime: () => number): AnalogElement =>
        new TransmissionSegmentCElement(pinNodes, props),
    },
  },
  defaultModel: "default",
};
