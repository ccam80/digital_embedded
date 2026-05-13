/**
 * MutualInductorElement and MutualInductorDefinition — ngspice K element.
 *
 * Internal-only sub-element used by Transformer / TappedTransformer composites.
 * Resolves its two partner inductors by resolved-label string at setup() time
 * via ctx.findDevice (ngspice CKTfndDev pattern), reads their branch indices,
 * and stamps the two mutual-inductance off-diagonals.
 *
 * Sibling references arrive as `{ kind: "ref", name }` netlist params —
 * the compiler resolves L1_branch / L2_branch to "{parentLabel}:{name}"
 * strings and writes them into the property partition. Same path
 * CurrentControlledSwitch's ctrlBranch and InternalCccs's sense use.
 *
 * ngspice anchors:
 *   mutsetup.c:30-70  — MUT branch resolution + TSTALLOC sequence
 *   indload.c:64-76   — MUT coupling pass (flux augmentation + matrix stamps)
 *   muttemp.c:35-41   — MUTfactor = k · sqrt(INDinduct1 · INDinduct2)
 *   mutacld.c:27-30   — AC coupling stamp
 */

import { AnalogElement } from "../../solver/analog/element.js";
import { NGSPICE_LOAD_ORDER, type DeviceFamily } from "../../solver/analog/ngspice-load-order.js";
import type { LoadContext } from "../../solver/analog/load-context.js";
import type { SetupContext } from "../../solver/analog/setup-context.js";
import type { TempContext } from "../../solver/analog/temp-context.js";
import type { ComplexSparseSolverStamp } from "../../solver/analog/complex-sparse-solver.js";
import { MODEDC, MODEINITPRED } from "../../solver/analog/ckt-mode.js";
import { AnalogInductorElement, type MutSiblingNotifiable } from "./inductor.js";
import { PropertyBag } from "../../core/properties.js";
import type { ComponentDefinition } from "../../core/registry.js";

// ---------------------------------------------------------------------------
// MutualInductorElement
// ---------------------------------------------------------------------------

export class MutualInductorElement extends AnalogElement implements MutSiblingNotifiable {
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.MUT;
  readonly deviceFamily: DeviceFamily = "IND";

  private _coupling: number;
  private _mutFactor: number = 0;
  /** Resolved global labels of the two partner inductors, compiler-stamped. */
  private readonly _l1Label: string;
  private readonly _l2Label: string;
  // Live partner refs are resolved at setup() time via ctx.findDevice.
  private _partner1!: AnalogInductorElement;
  private _partner2!: AnalogInductorElement;
  private _hBr1Br2: number = -1;
  private _hBr2Br1: number = -1;

  get hBr1Br2(): number { return this._hBr1Br2; }
  get hBr2Br1(): number { return this._hBr2Br1; }
  get mutFactor(): number { return this._mutFactor; }

  constructor(_pinNodes: ReadonlyMap<string, number>, props: PropertyBag) {
    super(new Map());
    this._coupling = props.hasModelParam("K") ? props.getModelParam<number>("K") : 1;
    this._l1Label = props.has("L1_branch") ? props.get<string>("L1_branch") : "";
    this._l2Label = props.has("L2_branch") ? props.get<string>("L2_branch") : "";
    if (!this._l1Label || !this._l2Label) {
      throw new Error(
        "MutualInductorElement: requires L1_branch and L2_branch as " +
        "`{ kind: \"ref\", name }` params (resolved partner inductor labels).",
      );
    }
  }

  setup(ctx: SetupContext): void {
    // mutsetup.c:44-57 — resolve named inductors via CKTfndDev. Both partners'
    // setup() must have already run so their branchIndex is allocated; IND=27
    // < MUT=28 in static_devices[] guarantees this ordering.
    const l1 = ctx.findDevice(this._l1Label);
    const l2 = ctx.findDevice(this._l2Label);
    if (!(l1 instanceof AnalogInductorElement)) {
      throw new Error(
        `MutualInductorElement: ctx.findDevice("${this._l1Label}") did not return an AnalogInductorElement ` +
        `(got ${l1?.constructor.name ?? "null"}).`,
      );
    }
    if (!(l2 instanceof AnalogInductorElement)) {
      throw new Error(
        `MutualInductorElement: ctx.findDevice("${this._l2Label}") did not return an AnalogInductorElement ` +
        `(got ${l2?.constructor.name ?? "null"}).`,
      );
    }
    this._partner1 = l1;
    this._partner2 = l2;

    const b1 = this._partner1.branchIndex;
    const b2 = this._partner2.branchIndex;
    if (b1 === -1 || b2 === -1) {
      throw new Error(
        "MutualInductorElement.setup(): branchIndex not yet allocated on partner inductor " +
        `(${this._l1Label}.branchIndex=${b1}, ${this._l2Label}.branchIndex=${b2}). ` +
        "IND must run setup() before MUT — check ngspiceLoadOrder.",
      );
    }

    // mutsetup.c:66-67 — TSTALLOC sequence, 2 off-diagonal entries.
    this._hBr1Br2 = ctx.solver.allocElement(b1, b2);
    this._hBr2Br1 = ctx.solver.allocElement(b2, b1);

    this._partner1._mutSiblings.push(this);
    this._partner2._mutSiblings.push(this);

    this._mutFactor = this._coupling * Math.sqrt(
      this._partner1.inductance * this._partner2.inductance,
    );
  }

  /**
   * IND_FAMILY Pass 2 — MUT coupling per `indload.c:64-76`.
   */
  loadCouplingPass(ctx: LoadContext): void {
    const { ag, rhsOld, cktMode: mode } = ctx;

    if (!(mode & (MODEDC | MODEINITPRED))) {
      const i_p1 = rhsOld[this._partner1.branchIndex];
      const i_p2 = rhsOld[this._partner2.branchIndex];
      this._partner1.augmentFlux(this._mutFactor * i_p2);
      this._partner2.augmentFlux(this._mutFactor * i_p1);
    }

    const ag0 = ag[0] ?? 0;
    ctx.solver.stampElement(this._hBr1Br2, -this._mutFactor * ag0);
    ctx.solver.stampElement(this._hBr2Br1, -this._mutFactor * ag0);
  }

  load(_ctx: LoadContext): void {
    // intentional no-op — MUT contributions flow through loadCouplingPass()
    // driven by the IND_FAMILY load handler.
  }

  computeTemperature(_ctx: TempContext): void {
    this._mutFactor = this._coupling * Math.sqrt(
      this._partner1.inductance * this._partner2.inductance,
    );
  }

  recomputeMutFactor(): void {
    this._mutFactor = this._coupling * Math.sqrt(
      this._partner1.inductance * this._partner2.inductance,
    );
  }

  stampAcCoupling(solver: ComplexSparseSolverStamp, omega: number, _ctx: LoadContext): void {
    const wM = omega * this._mutFactor;
    solver.stampComplexElement(this._hBr1Br2, 0, -wM);
    solver.stampComplexElement(this._hBr2Br1, 0, -wM);
  }

  setParam(key: string, value: number): void {
    if (key === "K" || key === "k" || key === "coupling") {
      this._coupling = value;
      this.recomputeMutFactor();
    }
  }

  getPinCurrents(_rhs: Float64Array): number[] {
    return [];
  }
}

// ---------------------------------------------------------------------------
// MutualInductorDefinition (internal-only)
// ---------------------------------------------------------------------------

export const MutualInductorDefinition: ComponentDefinition = {
  name: "MutualInductor",
  typeId: -1,
  internalOnly: true,
  modelRegistry: {
    default: {
      kind: "inline",
      paramDefs: [
        { key: "K", default: 1 },
      ],
      params: { K: 1 },
      factory: (
        pinNodes: ReadonlyMap<string, number>,
        props: PropertyBag,
        _getTime: () => number,
      ): AnalogElement => new MutualInductorElement(pinNodes, props),
    },
  },
  defaultModel: "default",
};
