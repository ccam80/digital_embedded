/**
 * TransmissionSegmentL- internal-only inductor segment for the lossy
 * transmission-line composite.
 *
 * Per Composite M6 (phase-composite-architecture.md), J-067
 * (contracts_group_05.md). Emitted by `buildTransmissionLineNetlist` in
 * `transmission-line.ts` as the series-L portion of each non-final RLCG
 * segment (`seg{k}_L`, k = 0..N-2). The final segment uses
 * `TransmissionSegmentRL` instead, combining R and L into one branch row.
 *
 * Canonical Template C exemplar- companion-model + branch + 2 pins, the
 * fullest stamp-leaf shape. Stateless / no-branch / 1-pin variants of
 * Template C subset this file by deleting state schema, branch alloc,
 * or one pin respectively.
 *
 * Stamp math is a verbatim port of ngspice INDload (indload.c:35-124) via
 * the same `niIntegrate` helper the user-facing `Inductor` uses
 * (`src/components/passives/inductor.ts`). Stripped of TC1/TC2/TNOM/SCALE/M
 * and IC handling- the parent passes a single pre-computed `L` value per
 * segment and never uses UIC/temperature scaling.
 */

import { AbstractPoolBackedAnalogElement, type AnalogElement } from "../../solver/analog/element.js";
import type { IntegrationMethod } from "../../solver/analog/integration.js";
import type { LoadContext } from "../../solver/analog/load-context.js";
import type { SetupContext } from "../../solver/analog/setup-context.js";
import { NGSPICE_LOAD_ORDER } from "../../solver/analog/ngspice-load-order.js";
import { cktTerr } from "../../solver/analog/ckt-terr.js";
import { niIntegrate } from "../../solver/analog/ni-integrate.js";
import { stampRHS } from "../../solver/analog/stamp-helpers.js";
import { MODEDC, MODEINITTRAN, MODEINITPRED } from "../../solver/analog/ckt-mode.js";
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

const MIN_INDUCTANCE = 1e-12;

const TRANSMISSION_SEGMENT_L_PARAM_DEFS: ParamDef[] = [
  { key: "L", default: 1e-3 },
];

const TRANSMISSION_SEGMENT_L_DEFAULTS: Record<string, number> = { L: 1e-3 };

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

const TRANSMISSION_SEGMENT_L_PIN_LAYOUT: PinDeclaration[] = [
  { direction: PinDirection.INPUT,  label: "pos", defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.OUTPUT, label: "neg", defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
];

// ---------------------------------------------------------------------------
// State schema- mirrors AnalogInductorElement (inductor.ts) which mirrors
// ngspice INDinstance (inddefs.h:68-69).
//   PHI  = INDflux  (INDstate+0): flux Phi = L*i, fed to NIintegrate.
//   CCAP = INDvolt  (INDstate+1): NIintegrate companion-current cache,
//                                  per niinteg.c:15 `#define ccap qcap+1`.
// ---------------------------------------------------------------------------

const SCHEMA: StateSchema = defineStateSchema("TransmissionSegmentL", [
  { name: "PHI",  doc: "Flux Phi = L*i  ngspice INDflux (INDstate+0)" },
  { name: "CCAP", doc: "NIintegrate companion current  ngspice INDvolt per niinteg.c:15" },
]);

const SLOT_PHI  = SCHEMA.indexOf.get("PHI")!;
const SLOT_CCAP = SCHEMA.indexOf.get("CCAP")!;

// ---------------------------------------------------------------------------
// TransmissionSegmentLElement
// ---------------------------------------------------------------------------

export class TransmissionSegmentLElement extends AbstractPoolBackedAnalogElement {
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.IND;
  readonly stateSchema = SCHEMA;
  readonly stateSize = SCHEMA.size;

  private _L: number;

  // Cached matrix-entry handles- mirror ngspice INDposIbrptr / INDnegIbrptr /
  // INDibrPosptr / INDibrNegptr / INDibrIbrptr (indsetup.c:96-100).
  private _hPIbr   = -1;
  private _hNIbr   = -1;
  private _hIbrP   = -1;
  private _hIbrN   = -1;
  private _hIbrIbr = -1;

  constructor(pinNodes: ReadonlyMap<string, number>, props: PropertyBag) {
    super(pinNodes);
    this._L = Math.max(props.getModelParam<number>("L"), MIN_INDUCTANCE);
  }

  setup(ctx: SetupContext): void {
    const solver = ctx.solver;
    const posNode = this._pinNodes.get("pos")!;
    const negNode = this._pinNodes.get("neg")!;

    // indsetup.c:78-79- *states += 2.
    this._stateBase = ctx.allocStates(this.stateSize);

    // indsetup.c:84-88- CKTmkCur (idempotent guard).
    if (this.branchIndex === -1) {
      this.branchIndex = ctx.makeCur(this.label, "branch");
    }
    const b = this.branchIndex;

    // indsetup.c:96-100- TSTALLOC sequence, line-for-line.
    this._hPIbr   = solver.allocElement(posNode, b);
    this._hNIbr   = solver.allocElement(negNode, b);
    this._hIbrN   = solver.allocElement(b, negNode);
    this._hIbrP   = solver.allocElement(b, posNode);
    this._hIbrIbr = solver.allocElement(b, b);
  }

  setParam(key: string, value: number): void {
    if (key === "L") {
      this._L = Math.max(value, MIN_INDUCTANCE);
    }
  }

  /**
   * load()- 1:1 port of ngspice indload.c INDload (lines 35-124). Stripped of
   * TC/IC/SCALE/M handling that the segment never receives. See
   * `inductor.ts` AnalogInductorElement.load() for the full-fidelity
   * version with structural commentary.
   */
  load(ctx: LoadContext): void {
    const { solver, rhsOld, ag, cktMode: mode } = ctx;
    const b = this.branchIndex;
    const L = this._L;
    const base = this._stateBase;
    const s0 = this._pool.states[0];
    const s1 = this._pool.states[1];
    const s2 = this._pool.states[2];
    const s3 = this._pool.states[3];

    // indload.c:43-51- flux from prior NR iterate branch current.
    if (!(mode & (MODEDC | MODEINITPRED))) {
      s0[base + SLOT_PHI] = L * rhsOld[b];
    }

    // indload.c:88-110- req/veq.
    let req = 0;
    let veq = 0;
    if (mode & MODEDC) {
      req = 0;
      veq = 0;
    } else {
      if (mode & MODEINITPRED) {
        s0[base + SLOT_PHI] = s1[base + SLOT_PHI];
      } else if (mode & MODEINITTRAN) {
        s1[base + SLOT_PHI] = s0[base + SLOT_PHI];
      }
      const phi0 = s0[base + SLOT_PHI];
      const phi1 = s1[base + SLOT_PHI];
      const phi2 = s2[base + SLOT_PHI];
      const phi3 = s3[base + SLOT_PHI];
      const ccapPrev = s1[base + SLOT_CCAP];
      const ni = niIntegrate(
        ctx.method,
        ctx.order,
        L,
        ag,
        phi0, phi1,
        [phi2, phi3, 0, 0, 0],
        ccapPrev,
      );
      req = ni.geq;
      veq = ni.ceq;
      s0[base + SLOT_CCAP] = ni.ccap;
    }

    // indload.c:114-117- seed the trap-order-2 recursion buffer on first
    // transient step.
    if (mode & MODEINITTRAN) {
      s1[base + SLOT_CCAP] = s0[base + SLOT_CCAP];
    }

    // indload.c:119-123- unconditional 5-stamp + RHS.
    solver.stampElement(this._hPIbr, 1);
    solver.stampElement(this._hNIbr, -1);
    solver.stampElement(this._hIbrP, 1);
    solver.stampElement(this._hIbrN, -1);
    solver.stampElement(this._hIbrIbr, -req);
    stampRHS(ctx.rhs, b, veq);
  }

  getPinCurrents(rhs: Float64Array): number[] {
    const I = rhs[this.branchIndex];
    return [I, -I];
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
      s0[base + SLOT_PHI], s1[base + SLOT_PHI],
      s2[base + SLOT_PHI], s3[base + SLOT_PHI],
      s0[base + SLOT_CCAP], s1[base + SLOT_CCAP],
      lteParams,
    );
  }
}

// ---------------------------------------------------------------------------
// ComponentDefinition
// ---------------------------------------------------------------------------

export const TransmissionSegmentLDefinition: ComponentDefinition = {
  name: "TransmissionSegmentL",
  typeId: -1,
  internalOnly: true,
  pinLayout: TRANSMISSION_SEGMENT_L_PIN_LAYOUT,
  modelRegistry: {
    default: {
      kind: "inline",
      paramDefs: TRANSMISSION_SEGMENT_L_PARAM_DEFS,
      params: TRANSMISSION_SEGMENT_L_DEFAULTS,
      branchCount: 1,
      factory: (pinNodes: ReadonlyMap<string, number>, props: PropertyBag, _getTime: () => number): AnalogElement =>
        new TransmissionSegmentLElement(pinNodes, props),
    },
  },
  defaultModel: "default",
};
