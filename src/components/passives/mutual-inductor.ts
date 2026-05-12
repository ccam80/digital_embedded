/**
 * MutualInductorElement, MutualInductorDefinition, and MutualInductorFactory —
 * the canonical MUT (K element) for coupled-inductor simulation.
 *
 * Transformer (`transformer.ts`) is `kind: "netlist"` and references
 * `Inductor` + `MutualInductor` by typeId for the compiled topology.
 *
 * ngspice anchors:
 *   mutsetup.c:30-70  - MUT branch resolution and TSTALLOC sequence
 *   indload.c:64-76   - MUT coupling pass (flux augmentation + matrix stamps)
 *   muttemp.c:35-41   - MUTfactor = k · sqrt(INDinduct1 * INDinduct2)
 *   mutacld.c:27-30   - AC coupling stamp (-ω·M into imaginary off-diagonals)
 */

import { AnalogElement } from "../../solver/analog/element.js";
import { NGSPICE_LOAD_ORDER, type DeviceFamily } from "../../solver/analog/ngspice-load-order.js";
import type { LoadContext } from "../../solver/analog/load-context.js";
import type { SetupContext } from "../../solver/analog/setup-context.js";
import type { TempContext } from "../../solver/analog/temp-context.js";
import type { ComplexSparseSolverStamp } from "../../solver/analog/complex-sparse-solver.js";
import { MODEDC, MODEINITPRED } from "../../solver/analog/ckt-mode.js";
import { AnalogInductorElement, type MutSiblingNotifiable } from "./inductor.js";
import type { ComponentDefinition, MutualInductorFactory } from "../../core/registry.js";

// ---------------------------------------------------------------------------
// MutualInductorElement
// ---------------------------------------------------------------------------

/**
 * Mutual inductor (K element) — the canonical MUT.
 *
 * Implements the 3-pass IND_FAMILY load contract verbatim from `indload.c:35-127`.
 * The IND_FAMILY load handler (loaders/ind-family-loader.ts) calls this element's
 * `loadCouplingPass(ctx)` between Pass 1 (IND.loadFluxInit) and Pass 3
 * (IND.load NIintegrate + 5-stamp). The MUT's `load(ctx)` itself is intentionally
 * a no-op — all MUT contributions land via `loadCouplingPass` driven by the
 * family handler.
 *
 * NOT pool-backed — MUT allocates no state slots (`mutsetup.c:28` NG_IGNORE(states)).
 * Implements `MutSiblingNotifiable` so partner inductors can notify it of L changes.
 *
 * ngspice anchors:
 *   indload.c:64-76  — coupling pass (flux augmentation + matrix stamps)
 *   muttemp.c:35-41  — MUTfactor = k · sqrt(INDinduct1 * INDinduct2)
 *   mutacld.c:27-30  — AC coupling stamp (-ω·M into imaginary off-diagonals)
 *   mutsetup.c:66-67 — TSTALLOC sequence (2 off-diagonal entries)
 */
export class MutualInductorElement extends AnalogElement implements MutSiblingNotifiable {
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.MUT;
  readonly deviceFamily: DeviceFamily = "IND";

  private _coupling: number;
  private _mutFactor: number = 0;
  private readonly _partner1: AnalogInductorElement;
  private readonly _partner2: AnalogInductorElement;
  private _hBr1Br2: number = -1;
  private _hBr2Br1: number = -1;

  get hBr1Br2(): number { return this._hBr1Br2; }
  get hBr2Br1(): number { return this._hBr2Br1; }
  get mutFactor(): number { return this._mutFactor; }

  constructor(
    coupling: number,
    partner1: AnalogInductorElement,
    partner2: AnalogInductorElement,
  ) {
    super(new Map());
    this._coupling = coupling;
    this._partner1 = partner1;
    this._partner2 = partner2;
  }

  setup(ctx: SetupContext): void {
    const solver = ctx.solver;

    // mutsetup.c:44-57 — resolve inductor refs. Pre-condition: both partners' setup()
    // MUST have already run so their branchIndex is allocated.
    const b1 = this._partner1.branchIndex;
    const b2 = this._partner2.branchIndex;
    if (b1 === -1 || b2 === -1) {
      throw new Error(
        "MutualInductorElement.setup(): branchIndex not yet allocated on partner inductor",
      );
    }

    // mutsetup.c:66-67 — TSTALLOC sequence, 2 off-diagonal entries.
    this._hBr1Br2 = solver.allocElement(b1, b2);
    this._hBr2Br1 = solver.allocElement(b2, b1);

    // Register as mutual-inductor sibling so each partner can notify on inductance
    // changes via setParam("inductance", ...) → recomputeMutFactor() cascade.
    this._partner1._mutSiblings.push(this);
    this._partner2._mutSiblings.push(this);

    // Seed _mutFactor from current partner inductances. IND_FAMILY temperature
    // handler will subsequently call computeTemperature() to refresh it from
    // temperature-corrected effective inductances.
    this._mutFactor = this._coupling * Math.sqrt(
      this._partner1.inductance * this._partner2.inductance,
    );
  }

  /**
   * IND_FAMILY Pass 2 — MUT coupling per `indload.c:64-76`.
   *
   *   if (!(ckt->CKTmode & (MODEDC | MODEINITPRED))) {
   *     CKTstate0[l1.INDflux] += MUTfactor * CKTrhsOld[l2.INDbrEq];   // line 67
   *     CKTstate0[l2.INDflux] += MUTfactor * CKTrhsOld[l1.INDbrEq];   // line 68
   *   }
   *   *(MUTbr1br2) -= MUTfactor * CKTag[0];                            // line 74 (unconditional)
   *   *(MUTbr2br1) -= MUTfactor * CKTag[0];                            // line 75 (unconditional)
   *
   * Pass 1 (each IND.loadFluxInit) has already initialized partner flux φ = L·i.
   * This pass augments partner flux with the mutual contribution, then stamps the
   * two off-diagonal matrix entries. Pass 3 (each IND.load NIintegrate) then reads
   * the augmented flux to produce the correct branch current.
   */
  loadCouplingPass(ctx: LoadContext): void {
    const { ag, rhsOld, cktMode: mode } = ctx;

    // indload.c:64-71 — gated flux augmentation (transient mode only).
    if (!(mode & (MODEDC | MODEINITPRED))) {
      const i_p1 = rhsOld[this._partner1.branchIndex];
      const i_p2 = rhsOld[this._partner2.branchIndex];
      this._partner1.augmentFlux(this._mutFactor * i_p2);
      this._partner2.augmentFlux(this._mutFactor * i_p1);
    }

    // indload.c:74-75 — unconditional off-diagonal matrix stamps.
    const ag0 = ag[0] ?? 0;
    ctx.solver.stampElement(this._hBr1Br2, -this._mutFactor * ag0);
    ctx.solver.stampElement(this._hBr2Br1, -this._mutFactor * ag0);
  }

  /**
   * IND_FAMILY load Pass 3 routes through `AnalogInductorElement.load()`.
   * MUT contributions are entirely handled by `loadCouplingPass()` driven by
   * the IND_FAMILY load handler. This `load(ctx)` is a no-op so MUT instances
   * do not double-stamp if the family handler erroneously dispatches them as
   * regular elements.
   */
  load(_ctx: LoadContext): void {
    // intentional no-op — see class JSDoc and loadCouplingPass()
  }

  /**
   * IND_FAMILY temperature Pass 2 per `muttemp.c:35-41`.
   *
   *   factor = sqrt(here->MUTind1->INDinduct * here->MUTind2->INDinduct);  // line 38
   *   here->MUTfactor = here->MUTcouple * factor;                          // line 41
   *
   * Pass 1 (each IND.computeTemperature) has already set effective INDinduct on
   * both partners. This pass reads those temperature-corrected inductances and
   * recomputes MUTfactor.
   */
  computeTemperature(_ctx: TempContext): void {
    this._mutFactor = this._coupling * Math.sqrt(
      this._partner1.inductance * this._partner2.inductance,
    );
  }

  /**
   * MutSiblingNotifiable contract — callable from partner inductor's
   * setParam("inductance", v) cascade. Identical formula to computeTemperature
   * but invoked at hot-load time rather than via the temperature pass.
   * cite: muttemp.c:38
   */
  recomputeMutFactor(): void {
    this._mutFactor = this._coupling * Math.sqrt(
      this._partner1.inductance * this._partner2.inductance,
    );
  }

  /**
   * IND_FAMILY AC stamp Pass 2 per `mutacld.c:27-30`.
   *
   *   *(here->MUTbr1br2 + 1) -= here->MUTfactor * omega;  // line 28 (imag at br1×br2)
   *   *(here->MUTbr2br1 + 1) -= here->MUTfactor * omega;  // line 29 (imag at br2×br1)
   *
   * Pure imaginary coupling: stamp -ω·M into the IMAGINARY half of the two
   * off-diagonal entries. Real part is zero (no resistive coupling at AC).
   */
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
// MutualInductorDefinition
//
// Internal-only sub-element registration. `MutualInductorElement` is
// constructed by the compiler via the `"mutual-inductor"` ModelEntry kind,
// which passes live `AnalogInductorElement` partner references rather than
// routing through a generic PropertyBag factory.
//
// `internalOnly: true` — excluded from the editor palette, SPICE-import
// primary matching, and surfaced under its parent composite in harness_describe.
// Registered in register-all.ts so the registry assigns a stable typeId.
//
// ngspice anchor: mutsetup.c:44-57 — partner inductors resolved after all IND
// branches allocated; `"mutual-inductor"` kind enforces the same ordering.
// ---------------------------------------------------------------------------

const mutualInductorFactory: MutualInductorFactory = (
  l1SubName: string,
  l2SubName: string,
  coupling: number,
  siblings: ReadonlyMap<string, import("../../solver/analog/element.js").AnalogElement>,
): MutualInductorElement => {
  const l1 = siblings.get(l1SubName);
  const l2 = siblings.get(l2SubName);
  if (!(l1 instanceof AnalogInductorElement)) {
    throw new Error(
      `MutualInductorDefinition: sibling "${l1SubName}" is not an AnalogInductorElement ` +
      `(got ${l1?.constructor.name ?? "undefined"}). ` +
      `Inductor leaves must appear before MutualInductor in netlist.elements.`,
    );
  }
  if (!(l2 instanceof AnalogInductorElement)) {
    throw new Error(
      `MutualInductorDefinition: sibling "${l2SubName}" is not an AnalogInductorElement ` +
      `(got ${l2?.constructor.name ?? "undefined"}). ` +
      `Inductor leaves must appear before MutualInductor in netlist.elements.`,
    );
  }
  return new MutualInductorElement(coupling, l1, l2);
};

export const MutualInductorDefinition: ComponentDefinition = {
  name: "MutualInductor",
  typeId: -1,
  internalOnly: true,
  modelRegistry: {
    default: {
      kind: "mutual-inductor",
      paramDefs: [
        { key: "K", default: 1 },
      ],
      params: { K: 1 },
      factory: mutualInductorFactory,
    },
  },
  defaultModel: "default",
};

