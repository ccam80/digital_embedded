/**
 * TransmissionSegmentG- internal-only shunt-conductance segment for the
 * lossy transmission-line composite.
 *
 * Per Composite M6 (phase-composite-architecture.md), J-066
 * (contracts_group_05.md). Emitted by `buildTransmissionLineNetlist` in
 * `transmission-line.ts` as the dielectric-loss shunt at each segment
 * junction (`seg{k}_G`, k = 0..N-2), but only when `gSeg > 0` (zero-loss
 * lines omit it entirely).
 *
 * Template C variant: stateless, no branch, 1 pin. The conductance is
 * referenced to ground- only the (junc, junc) diagonal entry needs a
 * matrix handle; the three GND-side entries are unstamped because GND is
 * the implicit reference row (node 0).
 *
 * Stamp math is the value-side of ngspice RESload (resload.c:34-37) reduced
 * to the single diagonal stamp- equivalent to the user-facing `Resistor`
 * with `negNode === 0`. See `transmission-segment-l.ts` for the canonical
 * Template C exemplar.
 */

import { AbstractAnalogElement, type AnalogElement } from "../../solver/analog/element.js";
import type { LoadContext } from "../../solver/analog/load-context.js";
import type { SetupContext } from "../../solver/analog/setup-context.js";
import { NGSPICE_LOAD_ORDER } from "../../solver/analog/ngspice-load-order.js";
import { PinDirection, type PinDeclaration } from "../../core/pin.js";
import { PropertyBag } from "../../core/properties.js";
import type { ComponentDefinition, ParamDef } from "../../core/registry.js";

// ---------------------------------------------------------------------------
// Model parameter declarations
// ---------------------------------------------------------------------------

const TRANSMISSION_SEGMENT_G_PARAM_DEFS: ParamDef[] = [
  { key: "G", default: 0 },
];

const TRANSMISSION_SEGMENT_G_DEFAULTS: Record<string, number> = { G: 0 };

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

const TRANSMISSION_SEGMENT_G_PIN_LAYOUT: PinDeclaration[] = [
  { direction: PinDirection.INPUT, label: "junc", defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
];

// ---------------------------------------------------------------------------
// TransmissionSegmentGElement
// ---------------------------------------------------------------------------

export class TransmissionSegmentGElement extends AbstractAnalogElement {
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.RES;

  private _G: number;

  // Single diagonal handle- the GND-side entries (negNode === 0) are not
  // stamped because GND is the implicit reference row.
  private _hJJ = -1;

  constructor(pinNodes: ReadonlyMap<string, number>, props: PropertyBag) {
    super(pinNodes);
    this._G = props.getModelParam<number>("G");
  }

  setup(ctx: SetupContext): void {
    const juncNode = this._pinNodes.get("junc")!;
    if (juncNode !== 0) {
      this._hJJ = ctx.solver.allocElement(juncNode, juncNode);
    }
  }

  setParam(key: string, value: number): void {
    if (key === "G") {
      this._G = value;
    }
  }

  load(ctx: LoadContext): void {
    if (this._hJJ !== -1) {
      ctx.solver.stampElement(this._hJJ, this._G);
    }
  }

  getPinCurrents(rhs: Float64Array): number[] {
    const v = rhs[this._pinNodes.get("junc")!];
    return [this._G * v];
  }
}

// ---------------------------------------------------------------------------
// ComponentDefinition
// ---------------------------------------------------------------------------

export const TransmissionSegmentGDefinition: ComponentDefinition = {
  name: "TransmissionSegmentG",
  typeId: -1,
  internalOnly: true,
  pinLayout: TRANSMISSION_SEGMENT_G_PIN_LAYOUT,
  modelRegistry: {
    default: {
      kind: "inline",
      paramDefs: TRANSMISSION_SEGMENT_G_PARAM_DEFS,
      params: TRANSMISSION_SEGMENT_G_DEFAULTS,
      factory: (pinNodes: ReadonlyMap<string, number>, props: PropertyBag, _getTime: () => number): AnalogElement =>
        new TransmissionSegmentGElement(pinNodes, props),
    },
  },
  defaultModel: "default",
};
