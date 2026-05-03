/**
 * Voltage-Controlled Voltage Source (VCVS) analog component.
 *
 * Four-terminal element: ctrl+ and ctrl- sense the control voltage;
 * out+ and out- are the output voltage source terminals.
 *
 * The output voltage equals an expression of the control voltage:
 *   V_out = f(V_ctrl)  where  V_ctrl = V(ctrl+) - V(ctrl-)
 *
 * A linear shortcut is provided via the `gain` property: when `expression`
 * is the default ("V(ctrl)"), the effective expression is `gain * V(ctrl)`.
 *
 * MNA formulation:
 *   The VCVS introduces one branch variable (the output current) via a
 *   dedicated branch row in the MNA matrix.
 *
 *   setup() allocates the branch row via ctx.makeCur (vcvsset.c:41-44 port)
 *   and 6 matrix handles (vcvsset.c:53-58 port).
 *
 *   load() (via base class) stamps the B/C incidence for the output port and
 *   evaluates f(Vctrl)/f'(Vctrl), then calls stampOutput():
 *     B[nOutP, k] += 1   C[k, nOutP] += 1
 *     B[nOutN, k] -= 1   C[k, nOutN] -= 1
 *     C[k, nCtrlP] -= f'(Vctrl)   (Jacobian)
 *     C[k, nCtrlN] += f'(Vctrl)   (Jacobian)
 *     RHS[k] = f(Vctrl) - f'(Vctrl) * Vctrl
 *
 * The RHS formula `f(Vctrl0) - f'(Vctrl0) * Vctrl0` is the constant term
 * after linearizing around the current operating point. Combined with the
 * Jacobian entries, the branch equation becomes:
 *   V_out+ - V_out- - f'(Vctrl0)*V_ctrl = f(Vctrl0) - f'(Vctrl0)*Vctrl0
 * which at convergence (V_ctrl = Vctrl0) gives V_out = f(Vctrl0). âˆŽ
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
  type StandaloneComponentDefinition,
} from "../../core/registry.js";
import type { SparseSolver } from "../../solver/analog/sparse-solver.js";
import { parseExpression } from "../../solver/analog/expression.js";
import { differentiate, simplify } from "../../solver/analog/expression-differentiate.js";
import { ControlledSourceElement } from "../../solver/analog/controlled-source-base.js";
import { NGSPICE_LOAD_ORDER } from "../../solver/analog/ngspice-load-order.js";
import type { SetupContext } from "../../solver/analog/setup-context.js";
import { defineModelParams } from "../../core/model-params.js";

// ---------------------------------------------------------------------------
// Model parameter declarations
// ---------------------------------------------------------------------------

export const { paramDefs: VCVS_PARAM_DEFS, defaults: VCVS_DEFAULTS } = defineModelParams({
  primary: {
    gain: { default: 1.0, description: "Linear voltage gain" },
  },
});

export const { paramDefs: COMPARATOR_PARAM_DEFS, defaults: COMPARATOR_PARAM_DEFAULTS } =
  defineModelParams({ primary: {} });

/** High-gain VCVS comparator gain (1e6). */
const VCVS_COMP_GAIN = 1e6;

export function makeVcvsComparatorExpression(): {
  expr: ReturnType<typeof parseExpression>;
  deriv: ReturnType<typeof parseExpression>;
} {
  const raw = parseExpression(`${VCVS_COMP_GAIN} * V(ctrl)`);
  const d = simplify(differentiate(raw, "V(ctrl)"));
  return { expr: raw, deriv: d };
}

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

function buildVCVSPinDeclarations(): PinDeclaration[] {
  return [
    {
      direction: PinDirection.INPUT,
      label: "ctrl+",
      defaultBitWidth: 1,
      position: { x: 0, y: 0 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.INPUT,
      label: "ctrl-",
      defaultBitWidth: 1,
      position: { x: 0, y: 2 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.OUTPUT,
      label: "out+",
      defaultBitWidth: 1,
      position: { x: 6, y: 0 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.OUTPUT,
      label: "out-",
      defaultBitWidth: 1,
      position: { x: 6, y: 2 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
  ];
}

// ---------------------------------------------------------------------------
// VCVSAnalogElement
// ---------------------------------------------------------------------------

/**
 * MNA analog element for a Voltage-Controlled Voltage Source.
 *
 * ctrl+ and ctrl- sense the control voltage; out+ and out- are the output
 * voltage source terminals.
 * branchIndex: set during setup() via ctx.makeCur; -1 before setup().
 */
export class VCVSAnalogElement extends ControlledSourceElement {
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.VCVS;

  // TSTALLOC handles- allocated in setup(), written in load()
  // vcvsset.c:53-58 line-for-line
  private _hPIbr:   number = -1; // B[posNode, branch]      :53
  private _hNIbr:   number = -1; // B[negNode, branch]      :54
  private _hIbrP:   number = -1; // C[branch,  posNode]     :55
  private _hIbrN:   number = -1; // C[branch,  negNode]     :56
  private _hIbrCtP: number = -1; // C[branch,  ctrlPosNode] :57
  private _hIbrCtN: number = -1; // C[branch,  ctrlNegNode] :58

  setup(ctx: SetupContext): void {
    const solver = ctx.solver;
    const posNode     = this._pinNodes.get("out+")!;   // VCVSposNode
    const negNode     = this._pinNodes.get("out-")!;   // VCVSnegNode
    const ctrlPosNode = this._pinNodes.get("ctrl+")!;  // VCVScontPosNode
    const ctrlNegNode = this._pinNodes.get("ctrl-")!;  // VCVScontNegNode

    // Branch row allocation: vcvsset.c:41-44 (idempotent guard)
    if (this.branchIndex === -1) {
      this.branchIndex = ctx.makeCur(this.label ?? "vcvs", "branch");
    }
    const branch = this.branchIndex;

    // TSTALLOC sequence: vcvsset.c:53-58, line-for-line
    this._hPIbr   = solver.allocElement(posNode,     branch);      // :53
    this._hNIbr   = solver.allocElement(negNode,     branch);      // :54
    this._hIbrP   = solver.allocElement(branch,      posNode);     // :55
    this._hIbrN   = solver.allocElement(branch,      negNode);     // :56
    this._hIbrCtP = solver.allocElement(branch,      ctrlPosNode); // :57
    this._hIbrCtN = solver.allocElement(branch,      ctrlNegNode); // :58
  }

  setParam(_key: string, _value: number): void {
  }

  /** Stamp the linear B/C incidence for the output voltage source branch. */
  protected override _stampLinear(solver: SparseSolver): void {
    solver.stampElement(this._hPIbr,  1);  // B[posNode, branch]
    solver.stampElement(this._hNIbr, -1);  // B[negNode, branch]
    solver.stampElement(this._hIbrP,  1);  // C[branch,  posNode]
    solver.stampElement(this._hIbrN, -1);  // C[branch,  negNode]
  }

  protected override _bindContext(rhsOld: Float64Array): void {
    const ctrlPosNode = this._pinNodes.get("ctrl+")!;
    const ctrlNegNode = this._pinNodes.get("ctrl-")!;
    const vCtrlP = ctrlPosNode > 0 ? rhsOld[ctrlPosNode] : 0;
    const vCtrlN = ctrlNegNode > 0 ? rhsOld[ctrlNegNode] : 0;
    const vCtrl = vCtrlP - vCtrlN;

    this._ctx.setNodeVoltage("ctrl", vCtrl);
    this._ctrlValue = vCtrl;
  }

  /**
   * Stamp the Jacobian and NR-linearized RHS for the output branch.
   * Port of vcvsload.c, value-side only- no allocElement calls.
   *
   * Branch equation: V_out+ - V_out- - f'(Vctrl)*V_ctrl = f(Vctrl0) - f'*Vctrl0
   *
   * C sub-matrix Jacobian entries (control node columns in branch row k):
   *   C[k, nCtrlP] -= f'     âˆ‚(branch_eq)/âˆ‚V_ctrlP = -f'
   *   C[k, nCtrlN] += f'     âˆ‚(branch_eq)/âˆ‚V_ctrlN = +f'
   *
   * RHS[k] = f(Vctrl0) - f'(Vctrl0) * Vctrl0
   */
  override stampOutput(
    solver: SparseSolver,
    rhs: Float64Array,
    value: number,
    derivative: number,
    ctrlValue: number,
  ): void {
    solver.stampElement(this._hIbrCtP, -derivative); // C[branch, ctrlPosNode]
    solver.stampElement(this._hIbrCtN,  derivative); // C[branch, ctrlNegNode]

    const branch = this.branchIndex;
    rhs[branch] += value - derivative * ctrlValue;
  }

  /**
   * Per-pin currents in pinLayout order: [ctrl+, ctrl-, out+, out-].
   *
   * The control port is an ideal voltage sensor (infinite impedance), so it
   * draws zero current. The output port current is the branch variable.
   * Positive = current flowing INTO the pin.
   * KCL: 0 + 0 + I_out - I_out = 0. âˆŽ
   */
  getPinCurrents(rhs: Float64Array): number[] {
    const iOut = rhs[this.branchIndex];
    return [0, 0, iOut, -iOut];
  }
}

// ---------------------------------------------------------------------------
// VCVSElement- CircuitElement
// ---------------------------------------------------------------------------

export class VCVSElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("VCVS", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildVCVSPinDeclarations(), []);
  }

  getBoundingBox(): Rect {
    return {
      x: this.position.x,
      y: this.position.y - 1,
      width: 6,
      height: 4,
    };
  }

  draw(ctx: RenderContext, signals?: PinVoltageAccess): void {
    const vCtrlP = signals?.getPinVoltage("ctrl+");
    const vCtrlN = signals?.getPinVoltage("ctrl-");
    const vOutP  = signals?.getPinVoltage("out+");
    const vOutN  = signals?.getPinVoltage("out-");

    ctx.save();
    ctx.setLineWidth(1);

    // Body- open polyline box (1,-1)(5,-1)(5,3)(1,3) (no left edge)
    ctx.setColor("COMPONENT");
    ctx.drawLine(1, -1, 5, -1);
    ctx.drawLine(5, -1, 5, 3);
    ctx.drawLine(5, 3, 1, 3);

    // ctrl+ lead
    drawColoredLead(ctx, signals, vCtrlP, 0, 0, 1, 0);

    // ctrl- lead
    drawColoredLead(ctx, signals, vCtrlN, 0, 2, 1, 2);

    // out+ lead
    drawColoredLead(ctx, signals, vOutP, 5, 0, 6, 0);

    // out- lead
    drawColoredLead(ctx, signals, vOutN, 5, 2, 6, 2);

    // Pin labels inside body
    ctx.setColor("TEXT");
    ctx.setFont({ family: "sans-serif", size: 0.6 });
    ctx.drawText("ctrl+", 1.2, 0, { horizontal: "left", vertical: "middle" });
    ctx.drawText("ctrlâˆ’", 1.2, 2, { horizontal: "left", vertical: "middle" });
    ctx.drawText("out+",  4.8, 0, { horizontal: "right", vertical: "middle" });
    ctx.drawText("outâˆ’",  4.8, 2, { horizontal: "right", vertical: "middle" });

    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const VCVS_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "expression",
    type: PropertyType.STRING,
    label: "Transfer function",
    defaultValue: "V(ctrl)",
    description: "Expression defining output voltage as function of V(ctrl). Default: V(ctrl) (unity gain).",
  },
  {
    key: "label",
    type: PropertyType.STRING,
    label: "Label",
    defaultValue: "",
    description: "Optional display label.",
  },
];

// ---------------------------------------------------------------------------
// Attribute mappings
// ---------------------------------------------------------------------------

const VCVS_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  { xmlName: "expression", propertyKey: "expression", convert: (v) => v },
  { xmlName: "gain",       propertyKey: "gain",       convert: (v) => parseFloat(v), modelParam: true },
  { xmlName: "Label",      propertyKey: "label",      convert: (v) => v },
];

// ---------------------------------------------------------------------------
// VCVSDefinition
// ---------------------------------------------------------------------------

export const VCVSDefinition: StandaloneComponentDefinition = {
  name: "VCVS",
  typeId: -1,
  category: ComponentCategory.ACTIVE,

  pinLayout: buildVCVSPinDeclarations(),
  propertyDefs: VCVS_PROPERTY_DEFS,
  attributeMap: VCVS_ATTRIBUTE_MAPPINGS,

  helpText:
    "Voltage-Controlled Voltage Source- output voltage is an expression of " +
    "the control port voltage V(ctrl+ - ctrl-).",

  factory(props: PropertyBag): VCVSElement {
    return new VCVSElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
  },

  models: {},
  modelRegistry: {
    "behavioral": {
      kind: "inline",
      factory: (pinNodes, props, _getTime) => {
        const expression = props.getOrDefault<string>("expression", "V(ctrl)");
        const gain = props.getModelParam<number>("gain");
        const rawExpr = parseExpression(expression === "V(ctrl)"
          ? `${gain} * V(ctrl)`
          : expression);
        const deriv = simplify(differentiate(rawExpr, "V(ctrl)"));
        const el = new VCVSAnalogElement(rawExpr, deriv, "V(ctrl)", "voltage");
        el._pinNodes = new Map(pinNodes);
        return el;
      },
      paramDefs: VCVS_PARAM_DEFS,
      params: VCVS_DEFAULTS,
    },
    "comparator": {
      kind: "inline",
      factory: (pinNodes, _props, _getTime) => {
        const { expr, deriv } = makeVcvsComparatorExpression();
        const el = new VCVSAnalogElement(expr, deriv, "V(ctrl)", "voltage");
        el._pinNodes = new Map(pinNodes);
        return el;
      },
      paramDefs: COMPARATOR_PARAM_DEFS,
      params: COMPARATOR_PARAM_DEFAULTS,
    },
  },
  defaultModel: "behavioral",
};
