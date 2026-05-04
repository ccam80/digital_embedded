/**
 * InternalCccs — internal-only current-controlled current source.
 *
 * Per Composite M4 (phase-composite-architecture.md), J-024
 * (contracts_group_02.md). Promoted from CccsSubElement in optocoupler.ts.
 *
 * Used as the coupling element in the Optocoupler netlist. Reads the branch
 * current of a sibling InternalZeroVoltSense via siblingBranch resolution
 * and injects I_out = gain * I_sense into the output (pos/neg) nodes.
 *
 * Template: hybrid of TransformerCoupling (siblingBranch reader pattern,
 * transformer-coupling.ts) and TransmissionSegmentR (2-pin stamp via cached
 * handles, transmission-segment-r.ts).
 *
 * Stamp math: CCCS (ccsload.c). Two off-diagonal matrix entries on the
 * b_sense column; no branch row of its own:
 *   G[pos, b_sense] += gain
 *   G[neg, b_sense] -= gain
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

const INTERNAL_CCCS_PARAM_DEFS: ParamDef[] = [
  { key: "gain", default: 1 },
];

const INTERNAL_CCCS_DEFAULTS: Record<string, number> = { gain: 1 };

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

const INTERNAL_CCCS_PIN_LAYOUT: PinDeclaration[] = [
  { direction: PinDirection.INPUT,  label: "pos", defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.OUTPUT, label: "neg", defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
];

// ---------------------------------------------------------------------------
// InternalCccsElement
// ---------------------------------------------------------------------------

export class InternalCccsElement extends AbstractAnalogElement implements AnalogElement {
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.CCCS;

  /** Gain (CTR). Hot-loadable via setParam("gain", v). */
  private _gain: number;
  /** Global label of the sense branch sibling. Compiler-stamped. */
  private readonly _senseLabel: string;
  /** Resolved sense branch index (1-based MNA branch number). */
  private _senseBranch = -1;

  // Cached matrix-entry handles — ccssetup.c TSTALLOC at (pos, b_sense)
  // and (neg, b_sense).
  private _hPosSense = -1;
  private _hNegSense = -1;

  constructor(pinNodes: ReadonlyMap<string, number>, props: PropertyBag) {
    super(pinNodes);
    this._gain = props.hasModelParam("gain") ? props.getModelParam<number>("gain") : 1;
    // siblingBranch resolution: compiler stamps "${parentLabel}:${subName}"
    // into the regular prop partition (compiler.ts:391-394).
    this._senseLabel = props.getOrDefault<string>("sense", "");
    if (!this._senseLabel) {
      throw new Error(
        "InternalCccs: requires sense siblingBranch param.",
      );
    }
  }

  setup(ctx: SetupContext): void {
    const solver = ctx.solver;
    const posNode = this._pinNodes.get("pos")!;
    const negNode = this._pinNodes.get("neg")!;

    // findBranch returns the 1-based MNA branch row for the named sibling,
    // lazy-allocating if the sibling's setup() has not yet run (VSRCfindBr
    // pattern). Returns 0 on failure.
    this._senseBranch = ctx.findBranch(this._senseLabel);
    if (this._senseBranch === 0) {
      const subName = this._senseLabel.split(":").pop() ?? this._senseLabel;
      throw new Error(
        `InternalCccs: ctx.findBranch("${this._senseLabel}") returned 0; ` +
          `sibling "${subName}" did not allocate a branch. Check parent ` +
          `netlist: the referenced sense sub-element must declare branchCount: 1.`,
      );
    }
    const b = this._senseBranch;

    // ccssetup.c — TSTALLOC at (pos, b_sense) and (neg, b_sense).
    this._hPosSense = solver.allocElement(posNode, b);
    this._hNegSense = solver.allocElement(negNode, b);
  }

  load(ctx: LoadContext): void {
    const solver = ctx.solver;
    // ccsload.c — stamp gain and -gain on the sense-branch column.
    solver.stampElement(this._hPosSense, this._gain);
    solver.stampElement(this._hNegSense, -this._gain);
  }

  getPinCurrents(rhs: Float64Array): number[] {
    const I = this._gain * rhs[this._senseBranch];
    return [I, -I];
  }

  setParam(key: string, value: number): void {
    if (key === "gain") this._gain = value;
  }
}

// ---------------------------------------------------------------------------
// ComponentDefinition
// ---------------------------------------------------------------------------

export const InternalCccsDefinition: ComponentDefinition = {
  name: "InternalCccs",
  typeId: -1,
  internalOnly: true,
  pinLayout: INTERNAL_CCCS_PIN_LAYOUT,
  modelRegistry: {
    default: {
      kind: "inline",
      paramDefs: INTERNAL_CCCS_PARAM_DEFS,
      params: INTERNAL_CCCS_DEFAULTS,
      factory: (pinNodes: ReadonlyMap<string, number>, props: PropertyBag, _getTime: () => number): AnalogElement =>
        new InternalCccsElement(pinNodes, props),
    },
  },
  defaultModel: "default",
};
