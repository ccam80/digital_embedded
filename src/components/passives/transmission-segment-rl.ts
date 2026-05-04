/**
 * TransmissionSegmentRL- internal-only combined R+L segment for the lossy
 * transmission-line composite's final segment.
 *
 * Per Composite M6 (phase-composite-architecture.md), J-069
 * (contracts_group_05.md). Emitted by `buildTransmissionLineNetlist` in
 * `transmission-line.ts` for the last segment only (`seg{N-1}_RL`); earlier
 * segments use a separate `TransmissionSegmentR` + `TransmissionSegmentL`
 * pair joined at an `rlMid{k}` node. The combined element saves one
 * internal node by collapsing the series RL into a single branch row.
 *
 * Template C variant: companion-model state + branch + 2 pins, same shape as
 * the canonical Template C exemplar (`transmission-segment-l.ts`) with one
 * extra term. The branch KVL becomes
 *     V_pos - V_neg = R*I_b + L*dI_b/dt
 * which in companion form is
 *     V_pos - V_neg = (R + req)*I_b + veq
 * so the only change vs `TransmissionSegmentL` is the branch-diagonal stamp:
 * `-(R + req)` instead of `-req`. Every other entry (incidence stamps, RHS,
 * NIintegrate flux update) is identical.
 *
 * Stamp math is the same INDload port as `transmission-segment-l.ts` plus
 * the extra series-resistance contribution to the branch diagonal.
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

const MIN_RESISTANCE = 1e-9;
const MIN_INDUCTANCE = 1e-12;

const TRANSMISSION_SEGMENT_RL_PARAM_DEFS: ParamDef[] = [
  { key: "R", default: 1 },
  { key: "L", default: 1e-3 },
];

const TRANSMISSION_SEGMENT_RL_DEFAULTS: Record<string, number> = { R: 1, L: 1e-3 };

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

const TRANSMISSION_SEGMENT_RL_PIN_LAYOUT: PinDeclaration[] = [
  { direction: PinDirection.INPUT,  label: "pos", defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.OUTPUT, label: "neg", defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
];

// ---------------------------------------------------------------------------
// State schema- mirrors `TransmissionSegmentL` (and AnalogInductorElement).
// ---------------------------------------------------------------------------

const SCHEMA: StateSchema = defineStateSchema("TransmissionSegmentRL", [
  { name: "PHI",  doc: "Flux Phi = L*i  ngspice INDflux (INDstate+0)" },
  { name: "CCAP", doc: "NIintegrate companion current  ngspice INDvolt per niinteg.c:15" },
]);

const SLOT_PHI  = SCHEMA.indexOf.get("PHI")!;
const SLOT_CCAP = SCHEMA.indexOf.get("CCAP")!;

// ---------------------------------------------------------------------------
// TransmissionSegmentRLElement
// ---------------------------------------------------------------------------

export class TransmissionSegmentRLElement extends AbstractPoolBackedAnalogElement {
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.IND;
  readonly stateSchema = SCHEMA;
  readonly stateSize = SCHEMA.size;

  private _R: number;
  private _L: number;

  private _hPIbr   = -1;
  private _hNIbr   = -1;
  private _hIbrP   = -1;
  private _hIbrN   = -1;
  private _hIbrIbr = -1;

  constructor(pinNodes: ReadonlyMap<string, number>, props: PropertyBag) {
    super(pinNodes);
    this._R = Math.max(props.getModelParam<number>("R"), MIN_RESISTANCE);
    this._L = Math.max(props.getModelParam<number>("L"), MIN_INDUCTANCE);
  }

  setup(ctx: SetupContext): void {
    const solver = ctx.solver;
    const posNode = this._pinNodes.get("pos")!;
    const negNode = this._pinNodes.get("neg")!;

    this._stateBase = ctx.allocStates(this.stateSize);

    if (this.branchIndex === -1) {
      this.branchIndex = ctx.makeCur(this.label, "branch");
    }
    const b = this.branchIndex;

    // Same TSTALLOC sequence as `transmission-segment-l.ts` (indsetup.c:96-100).
    this._hPIbr   = solver.allocElement(posNode, b);
    this._hNIbr   = solver.allocElement(negNode, b);
    this._hIbrN   = solver.allocElement(b, negNode);
    this._hIbrP   = solver.allocElement(b, posNode);
    this._hIbrIbr = solver.allocElement(b, b);
  }

  setParam(key: string, value: number): void {
    if (key === "R") {
      this._R = Math.max(value, MIN_RESISTANCE);
    } else if (key === "L") {
      this._L = Math.max(value, MIN_INDUCTANCE);
    }
  }

  /**
   * load()- INDload port (see `transmission-segment-l.ts`) plus a series-R
   * contribution `-R` added to the branch-diagonal stamp.
   */
  load(ctx: LoadContext): void {
    const { solver, rhsOld, ag, cktMode: mode } = ctx;
    const b = this.branchIndex;
    const L = this._L;
    const R = this._R;
    const base = this._stateBase;
    const s0 = this._pool.states[0];
    const s1 = this._pool.states[1];
    const s2 = this._pool.states[2];
    const s3 = this._pool.states[3];

    if (!(mode & (MODEDC | MODEINITPRED))) {
      s0[base + SLOT_PHI] = L * rhsOld[b];
    }

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

    if (mode & MODEINITTRAN) {
      s1[base + SLOT_CCAP] = s0[base + SLOT_CCAP];
    }

    // Incidence stamps (identical to L). RHS gets veq alone- R is a pure
    // resistive drop in the KVL row, no source contribution.
    solver.stampElement(this._hPIbr, 1);
    solver.stampElement(this._hNIbr, -1);
    solver.stampElement(this._hIbrP, 1);
    solver.stampElement(this._hIbrN, -1);
    // Branch diagonal: -(R + req) instead of -req. R always present; req is
    // 0 in DC and the inductor companion conductance otherwise.
    solver.stampElement(this._hIbrIbr, -(R + req));
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

export const TransmissionSegmentRLDefinition: ComponentDefinition = {
  name: "TransmissionSegmentRL",
  typeId: -1,
  internalOnly: true,
  pinLayout: TRANSMISSION_SEGMENT_RL_PIN_LAYOUT,
  modelRegistry: {
    default: {
      kind: "inline",
      paramDefs: TRANSMISSION_SEGMENT_RL_PARAM_DEFS,
      params: TRANSMISSION_SEGMENT_RL_DEFAULTS,
      branchCount: 1,
      factory: (pinNodes: ReadonlyMap<string, number>, props: PropertyBag, _getTime: () => number): AnalogElement =>
        new TransmissionSegmentRLElement(pinNodes, props),
    },
  },
  defaultModel: "default",
};
