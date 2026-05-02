/**
 * TransformerCoupling — pairwise mutual-inductance off-diagonal stamper.
 *
 * **Canonical Template B reference (stateless sub-shape)** for behavioural
 * leaves that have ZERO MNA pins, resolve sibling-element branch indices via
 * `siblingBranch` refs, and stamp cross-branch coupling entries.
 *
 * Use this file as the worked example when authoring any new sibling-coupling
 * driver whose math is "look at sibling branches and stamp something between
 * them". For the stateful sub-shape (no pins, but reads sibling state and
 * writes own state for sibling consumption), see `relay-coupling.ts`.
 *
 * ## Strictly pairwise (matches ngspice MUT element decomposition)
 *
 * ngspice K elements are 1-to-1 with coupled pairs (mutsetup.c:66-67 allocates
 * exactly two stamp positions; mutload.c writes exactly two off-diagonals).
 * A 3-winding (tapped) transformer in ngspice is `K12 L1 L2`, `K13 L1 L3`,
 * `K23 L2 L3` — three K instances. We mirror that: ONE TransformerCoupling per
 * coupled pair. N-winding parents emit N*(N-1)/2 instances.
 *
 * ## Shape contract
 *
 *   - Parent composite emits the element with netlist row `[]` (no MNA pins);
 *     the compiler still constructs an empty `pinNodes` map and passes it in.
 *   - Branch labels arrive in the regular prop partition as global label
 *     strings, written by the compiler from `{ kind: "siblingBranch",
 *     subElementName }` refs (compiler.ts:381-394).
 *   - `setup()` calls `ctx.findBranch(label)` per sibling — lazy-allocates if
 *     the sibling's own setup() has not yet run, mirroring VSRCfindBr.
 *   - `setup()` allocates both off-diagonal solver handles unconditionally,
 *     even when M=0 — preserves structural nonzero so a runtime setParam
 *     can ramp M up without mutating the sparse-matrix structure (mirrors
 *     indsetup.c "stamp -req even at DC where req=0").
 *   - `load()` only calls `solver.stampElement` — no `allocElement` (TSTALLOC-
 *     in-setup, stamp-in-load, ngspice convention).
 *   - `branchIndex` stays -1 — this leaf does not own a branch.
 *   - No state schema, no `initState`, no `stateSize` — purely instantaneous
 *     off-diagonal stamps. The integration coefficient `ag[0]` carries the
 *     timestep-implicit history; per-winding `ceq` and `-req` stay in each
 *     sibling Inductor's `INDload`.
 *
 * ## Math (per pair)
 *
 *   D[b1, b2] += -M * ag[0]
 *   D[b2, b1] += -M * ag[0]
 *
 * No RHS contribution. Matches ngspice mutload.c verbatim — that file's
 * entire stamp body is two writes of `-MUTfactor * CKTag[0]` to MUTbr1Br2 and
 * MUTbr2Br1.
 *
 * ## Param contract (parent netlist row)
 *
 *   params: {
 *     M:         <number>,                                    // mutual inductance, hot-loadable via setParam
 *     L1_branch: { kind: "siblingBranch", subElementName: "<sibling-1>" },
 *     L2_branch: { kind: "siblingBranch", subElementName: "<sibling-2>" },
 *   }
 *
 * Per Composite M26 (phase-composite-architecture.md), J-063
 * (contracts_group_05.md). ngspice anchors: mutsetup.c:66-67, mutload.c.
 */

import type { AnalogElement } from "../../solver/analog/element.js";
import type { LoadContext } from "../../solver/analog/load-context.js";
import type { SetupContext } from "../../solver/analog/setup-context.js";
import { NGSPICE_LOAD_ORDER } from "../../solver/analog/ngspice-load-order.js";
import { PropertyBag } from "../../core/properties.js";
import type { ComponentDefinition } from "../../core/registry.js";

// ---------------------------------------------------------------------------
// TransformerCouplingElement
// ---------------------------------------------------------------------------

export class TransformerCouplingElement implements AnalogElement {
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.MUT;

  label = "";
  _pinNodes: Map<string, number>;
  _stateBase = -1;
  branchIndex = -1;

  /** Global label of sibling 1 (e.g. `parentLabel:L1`). Compiler-stamped. */
  private readonly _label1: string;
  /** Global label of sibling 2 (e.g. `parentLabel:L2`). Compiler-stamped. */
  private readonly _label2: string;
  /** Mutual inductance. Hot-loadable via setParam("M", v). */
  private _M: number;
  /** Resolved sibling branch indices (1-based MNA branch numbers). */
  private _b1 = -1;
  private _b2 = -1;
  /** Cached solver handles for the two off-diagonal stamps. */
  private _hBr1Br2 = -1;
  private _hBr2Br1 = -1;

  constructor(pinNodes: ReadonlyMap<string, number>, props: PropertyBag) {
    this._pinNodes = new Map(pinNodes);

    // siblingBranch resolution: compiler stamps "${parentLabel}:${subName}"
    // into the regular prop partition (compiler.ts:391-394). Empty string
    // sentinel means the parent didn't supply the ref.
    this._label1 = props.getOrDefault<string>("L1_branch", "");
    this._label2 = props.getOrDefault<string>("L2_branch", "");
    if (!this._label1 || !this._label2) {
      throw new Error(
        "TransformerCoupling: requires L1_branch and L2_branch siblingBranch params.",
      );
    }

    // Numeric element params route through the mparams partition
    // (compiler.ts:372-374). Default 0 means uncoupled — handles still get
    // allocated in setup() so a runtime setParam can ramp M up.
    this._M = props.hasModelParam("M") ? props.getModelParam<number>("M") : 0;
  }

  setup(ctx: SetupContext): void {
    // findBranch returns the 1-based MNA branch row for the named sibling,
    // lazy-allocating if the sibling's setup() has not yet run (VSRCfindBr
    // pattern). Returns 0 on failure → the sibling has no branchCount,
    // which is a parent-netlist authoring error.
    this._b1 = ctx.findBranch(this._label1);
    this._b2 = ctx.findBranch(this._label2);
    if (this._b1 === 0 || this._b2 === 0) {
      const bad = this._b1 === 0 ? this._label1 : this._label2;
      const subName = bad.split(":").pop() ?? bad;
      throw new Error(
        `TransformerCoupling: ctx.findBranch("${bad}") returned 0; ` +
          `sibling "${subName}" did not allocate a branch. Check parent ` +
          `netlist: the referenced Inductor sub-element must declare ` +
          `branchCount: 1.`,
      );
    }

    // mutsetup.c:66-67 — TSTALLOC at (b1, b2) and (b2, b1). Allocated even
    // when M=0 to preserve the structural nonzero across runtime setParam
    // changes; stamping 0 is harmless.
    this._hBr1Br2 = ctx.solver.allocElement(this._b1, this._b2);
    this._hBr2Br1 = ctx.solver.allocElement(this._b2, this._b1);
  }

  load(ctx: LoadContext): void {
    // mutload.c — entire stamp body is two writes of -mut*ag[0].
    const stamp = -this._M * ctx.ag[0]!;
    ctx.solver.stampElement(this._hBr1Br2, stamp);
    ctx.solver.stampElement(this._hBr2Br1, stamp);
  }

  getPinCurrents(_rhs: Float64Array): number[] {
    return [];
  }

  setParam(key: string, value: number): void {
    // Branch labels are structural and not setParam-able; runtime topology
    // changes require recompilation.
    if (key === "M") this._M = value;
  }
}

// ---------------------------------------------------------------------------
// ComponentDefinition
//
// `internalOnly: true` matches the d-flipflop canonical template and every
// other internal-only sub-element today (15 files). The `internalOnly?:
// boolean` flag is still live in registry.ts (`isStandalone()` depends on
// it). A project-wide cleanup that removes the flag in favour of pure type-
// system distinction is pending across all 15 sites; we move with the herd
// until that lands.
// ---------------------------------------------------------------------------

export const TransformerCouplingDefinition: ComponentDefinition = {
  name: "TransformerCoupling",
  typeId: -1,
  internalOnly: true,
  modelRegistry: {
    default: {
      kind: "inline",
      paramDefs: [],
      params: {},
      factory: (pinNodes: ReadonlyMap<string, number>, props: PropertyBag, _getTime: () => number) =>
        new TransformerCouplingElement(pinNodes, props),
    },
  },
  defaultModel: "default",
};
