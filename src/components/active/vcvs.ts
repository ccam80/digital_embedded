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
 *   `_stampLinear()` places the B/C incidence for the output port:
 *     B[nOutP, k] += 1   C[k, nOutP] += 1
 *     B[nOutN, k] -= 1   C[k, nOutN] -= 1
 *
 *   `load()` (via base class) binds the control voltage, calls `_stampLinear`,
 *   evaluates f(Vctrl) and f'(Vctrl), then calls `stampOutput()` which stamps
 *   the Jacobian and NR-linearized RHS:
 *     C[k, nCtrlP] -= f'(Vctrl)   (Jacobian)
 *     C[k, nCtrlN] += f'(Vctrl)   (Jacobian)
 *     RHS[k]        = f(Vctrl) - f'(Vctrl) * Vctrl
 *
 * The RHS formula `f(Vctrl0) - f'(Vctrl0) * Vctrl0` is the constant term
 * after linearizing around the current operating point. Combined with the
 * Jacobian entries, the branch equation becomes:
 *   V_out+ - V_out- - f'(Vctrl0)*V_ctrl = f(Vctrl0) - f'(Vctrl0)*Vctrl0
 * which at convergence (V_ctrl = Vctrl0) gives V_out = f(Vctrl0). â"
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
  type ComponentDefinition,
} from "../../core/registry.js";
import type { SparseSolver } from "../../solver/analog/sparse-solver.js";
import { parseExpression } from "../../solver/analog/expression.js";
import { differentiate, simplify } from "../../solver/analog/expression-differentiate.js";
import { ControlledSourceElement } from "../../solver/analog/controlled-source-base.js";
import { NGSPICE_LOAD_ORDER } from "../../solver/analog/element.js";
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
 * Node layout in nodeIds (from analogFactory):
 *   [0] = nCtrlP  (ctrl+ node)
 *   [1] = nCtrlN  (ctrl- node)
 *   [2] = nOutP   (out+ node)
 *   [3] = nOutN   (out- node)
 *
 * branchIdx: absolute 0-based row in the MNA matrix for the output branch.
 */
class VCVSAnalogElement extends ControlledSourceElement {
  branchIndex: number;
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.VCVS;
  _stateBase: number = -1;
  _pinNodes: Map<string, number> = new Map();

  private readonly _nCtrlP: number;
  private readonly _nCtrlN: number;
  private readonly _nOutP: number;
  private readonly _nOutN: number;
  private readonly _k: number; // branch row (absolute 0-based)

  constructor(
    nCtrlP: number,
    nCtrlN: number,
    nOutP: number,
    nOutN: number,
    branchIdx: number,
    expressionStr: string,
    gain: number,
  ) {
    // Build expression: if default "V(ctrl)", apply gain multiplier
    const rawExpr = parseExpression(expressionStr === "V(ctrl)"
      ? `${gain} * V(ctrl)`
      : expressionStr);
    const deriv = simplify(differentiate(rawExpr, "V(ctrl)"));

    super(rawExpr, deriv, "V(ctrl)", "voltage");

    this._nCtrlP = nCtrlP;
    this._nCtrlN = nCtrlN;
    this._nOutP = nOutP;
    this._nOutN = nOutN;
    this._k = branchIdx;
    this.branchIndex = branchIdx;
  }

  setup(_ctx: SetupContext): void {
    throw new Error(`PB-VCVS not yet migrated`);
  }

  setParam(_key: string, _value: number): void {
  }

  /** Stamp the linear B/C incidence for the output voltage source branch. */
  protected override _stampLinear(solver: SparseSolver): void {
    const k = this._k;
    if (this._nOutP !== 0) {
      solver.stampElement(solver.allocElement(this._nOutP, k), 1);   // B[nOutP, k]
      solver.stampElement(solver.allocElement(k, this._nOutP), 1);   // C[k, nOutP]
    }
    if (this._nOutN !== 0) {
      solver.stampElement(solver.allocElement(this._nOutN, k), -1);  // B[nOutN, k]
      solver.stampElement(solver.allocElement(k, this._nOutN), -1);  // C[k, nOutN]
    }
  }

  protected override _bindContext(rhsOld: Float64Array): void {
    const vCtrlP = this._nCtrlP > 0 ? rhsOld[this._nCtrlP] : 0;
    const vCtrlN = this._nCtrlN > 0 ? rhsOld[this._nCtrlN] : 0;
    const vCtrl = vCtrlP - vCtrlN;

    this._ctx.setNodeVoltage("ctrl", vCtrl);
    this._ctrlValue = vCtrl;
  }

  /**
   * Stamp the Jacobian and NR-linearized RHS for the output branch.
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
    const k = this._k;

    // Jacobian: C[k, ctrl] entries
    if (this._nCtrlP !== 0) {
      solver.stampElement(solver.allocElement(k, this._nCtrlP), -derivative);
    }
    if (this._nCtrlN !== 0) {
      solver.stampElement(solver.allocElement(k, this._nCtrlN), derivative);
    }

    // NR-linearized RHS: constant term after factoring out Jacobian
    rhs[k] += value - derivative * ctrlValue;
  }

  /**
   * Per-pin currents in pinLayout order: [ctrl+, ctrl-, out+, out-].
   *
   * The control port is an ideal voltage sensor (infinite impedance), so it
   * draws zero current. The output port current is the branch variable at row
   * `_k` in the MNA solution vector. Positive = current flowing INTO the pin.
   * KCL: 0 + 0 + I_out - I_out = 0. â"
   */
  getPinCurrents(rhs: Float64Array): number[] {
    const iOut = rhs[this._k];
    return [0, 0, iOut, -iOut];
  }
}

// ---------------------------------------------------------------------------
// VCVSElement  CircuitElement
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

    // Body  open polyline box (1,-1)(5,-1)(5,3)(1,3) (no left edge)
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
    ctx.drawText("ctrl\u2212", 1.2, 2, { horizontal: "left", vertical: "middle" });
    ctx.drawText("out+",  4.8, 0, { horizontal: "right", vertical: "middle" });
    ctx.drawText("out\u2212",  4.8, 2, { horizontal: "right", vertical: "middle" });

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

export const VCVSDefinition: ComponentDefinition = {
  name: "VCVS",
  typeId: -1,
  category: ComponentCategory.ACTIVE,

  pinLayout: buildVCVSPinDeclarations(),
  propertyDefs: VCVS_PROPERTY_DEFS,
  attributeMap: VCVS_ATTRIBUTE_MAPPINGS,

  helpText:
    "Voltage-Controlled Voltage Source  output voltage is an expression of " +
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
        const el = new VCVSAnalogElement(
          pinNodes.get("ctrl+")!,
          pinNodes.get("ctrl-")!,
          pinNodes.get("out+")!,
          pinNodes.get("out-")!,
          -1,
          expression,
          gain,
        );
        el._pinNodes = new Map(pinNodes);
        return el;
      },
      paramDefs: VCVS_PARAM_DEFS,
      params: VCVS_DEFAULTS,
      branchCount: 1,
      ngspiceNodeMap: { "out+": "pos", "out-": "neg", "ctrl+": "contPos", "ctrl-": "contNeg" },
    },
  },
  defaultModel: "behavioral",
};
