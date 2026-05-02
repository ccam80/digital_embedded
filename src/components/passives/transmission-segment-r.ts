/**
 * TransmissionSegmentR- internal-only resistor segment for the lossy
 * transmission-line composite.
 *
 * Per Composite M6 (phase-composite-architecture.md), J-068
 * (contracts_group_05.md). Emitted by `buildTransmissionLineNetlist` in
 * `transmission-line.ts` as the series-R portion of each non-final RLCG
 * segment (`seg{k}_R`, k = 0..N-2).
 *
 * Template C variant: stateless, no branch, 2 pins. Subset of the canonical
 * Template C exemplar (`transmission-segment-l.ts`)- delete state schema,
 * delete branch alloc, keep 2 pins. Stamps four conductance entries
 * (G = 1/R) on each load() pass.
 *
 * Stamp math is a verbatim port of ngspice RESload (resload.c:34-37) via
 * the same handle pattern the user-facing `Resistor` uses
 * (`src/components/passives/resistor.ts`). Stripped of the temperature /
 * tolerance / ACtemp scaling that segments never receive.
 */

import type { AnalogElement } from "../../solver/analog/element.js";
import type { LoadContext } from "../../solver/analog/load-context.js";
import type { SetupContext } from "../../solver/analog/setup-context.js";
import { NGSPICE_LOAD_ORDER } from "../../solver/analog/ngspice-load-order.js";
import { PinDirection, type PinDeclaration } from "../../core/pin.js";
import { PropertyBag } from "../../core/properties.js";
import type { ComponentDefinition, ParamDef } from "../../core/registry.js";

// ---------------------------------------------------------------------------
// Model parameter declarations
// ---------------------------------------------------------------------------

const MIN_RESISTANCE = 1e-9;

const TRANSMISSION_SEGMENT_R_PARAM_DEFS: ParamDef[] = [
  { key: "R", default: 1 },
];

const TRANSMISSION_SEGMENT_R_DEFAULTS: Record<string, number> = { R: 1 };

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

const TRANSMISSION_SEGMENT_R_PIN_LAYOUT: PinDeclaration[] = [
  { direction: PinDirection.INPUT,  label: "pos", defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.OUTPUT, label: "neg", defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
];

// ---------------------------------------------------------------------------
// TransmissionSegmentRElement
// ---------------------------------------------------------------------------

export class TransmissionSegmentRElement implements AnalogElement {
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.RES;

  label = "";
  _pinNodes: Map<string, number>;
  _stateBase = -1;
  branchIndex = -1;

  private _R: number;
  private _G: number;

  // Cached matrix-entry handles- mirror ngspice RESposPosptr / RESnegNegptr /
  // RESposNegptr / RESnegPosptr (ressetup.c:46-49).
  private _hPP = -1;
  private _hNN = -1;
  private _hPN = -1;
  private _hNP = -1;

  constructor(pinNodes: ReadonlyMap<string, number>, props: PropertyBag) {
    this._pinNodes = new Map(pinNodes);
    this._R = Math.max(props.getModelParam<number>("R"), MIN_RESISTANCE);
    this._G = 1 / this._R;
  }

  setup(ctx: SetupContext): void {
    const solver = ctx.solver;
    const posNode = this._pinNodes.get("pos")!;
    const negNode = this._pinNodes.get("neg")!;

    // ressetup.c:46-49- TSTALLOC sequence, line-for-line.
    this._hPP = solver.allocElement(posNode, posNode);
    this._hNN = solver.allocElement(negNode, negNode);
    this._hPN = solver.allocElement(posNode, negNode);
    this._hNP = solver.allocElement(negNode, posNode);
  }

  setParam(key: string, value: number): void {
    if (key === "R") {
      this._R = Math.max(value, MIN_RESISTANCE);
      this._G = 1 / this._R;
    }
  }

  load(ctx: LoadContext): void {
    const solver = ctx.solver;
    // resload.c:34-37- value-side stamps through cached handles.
    solver.stampElement(this._hPP, this._G);
    solver.stampElement(this._hNN, this._G);
    solver.stampElement(this._hPN, -this._G);
    solver.stampElement(this._hNP, -this._G);
  }

  getPinCurrents(rhs: Float64Array): number[] {
    const vP = rhs[this._pinNodes.get("pos")!];
    const vN = rhs[this._pinNodes.get("neg")!];
    const I = this._G * (vP - vN);
    return [I, -I];
  }
}

// ---------------------------------------------------------------------------
// ComponentDefinition
// ---------------------------------------------------------------------------

export const TransmissionSegmentRDefinition: ComponentDefinition = {
  name: "TransmissionSegmentR",
  typeId: -1,
  internalOnly: true,
  pinLayout: TRANSMISSION_SEGMENT_R_PIN_LAYOUT,
  modelRegistry: {
    default: {
      kind: "inline",
      paramDefs: TRANSMISSION_SEGMENT_R_PARAM_DEFS,
      params: TRANSMISSION_SEGMENT_R_DEFAULTS,
      factory: (pinNodes: ReadonlyMap<string, number>, props: PropertyBag, _getTime: () => number): AnalogElement =>
        new TransmissionSegmentRElement(pinNodes, props),
    },
  },
  defaultModel: "default",
};
