/**
 * Voltage-Controlled Current Source (VCCS) analog component.
 *
 * Four-terminal element: ctrl+ and ctrl- sense the control voltage;
 * out+ and out- are the output current source terminals.
 *
 * The output current equals an expression of the control voltage:
 *   I_out = f(V_ctrl)  where  V_ctrl = V(ctrl+) - V(ctrl-)
 *
 * A linear shortcut is provided via the `transconductance` property: when
 * `expression` is the default ("V(ctrl)"), the effective expression is
 * `transconductance * V(ctrl)`.
 *
 * MNA formulation (Norton stamp — no branch variable):
 *   `stamp()`: no-op (no linear topology-constant entries).
 *   `stampNonlinear()` (via base class) evaluates f(Vctrl) and f'(Vctrl),
 *   then `stampOutput()` stamps the NR-linearized Norton equivalent:
 *
 *   Norton current source (NR linearized around Vctrl0 = current op point):
 *     I_out(Vctrl) ≈ f(Vctrl0) + f'(Vctrl0) * (Vctrl - Vctrl0)
 *                  = f'(Vctrl0) * Vctrl + [f(Vctrl0) - f'(Vctrl0)*Vctrl0]
 *
 *   MNA off-diagonal stamp for controlled source injecting gm*V_ctrl INTO nOutP:
 *   The KCL row at nOutP has: G_load*V_outP - gm*V_ctrlP = 0
 *   so the off-diagonal entry G[nOutP, nCtrlP] = -gm (negative), not +gm.
 *
 *     G[nOutP, nCtrlP] -= f'    G[nOutP, nCtrlN] += f'
 *     G[nOutN, nCtrlP] += f'    G[nOutN, nCtrlN] -= f'
 *     RHS[nOutP] += f(Vctrl0) - f'(Vctrl0) * Vctrl0
 *     RHS[nOutN] -= f(Vctrl0) - f'(Vctrl0) * Vctrl0
 *
 * At convergence (Vctrl = Vctrl0) the current injected into out+ equals
 * f(Vctrl0), which is the desired output current. ✓
 */

import { AbstractCircuitElement } from "../../core/element.js";
import type { RenderContext, Rect } from "../../core/renderer-interface.js";
import type { Pin, PinDeclaration, Rotation } from "../../core/pin.js";
import { PinDirection } from "../../core/pin.js";
import { PropertyBag, PropertyType } from "../../core/properties.js";
import type { PropertyDefinition } from "../../core/properties.js";
import {
  ComponentCategory,
  noOpAnalogExecuteFn,
  type AttributeMapping,
  type ComponentDefinition,
} from "../../core/registry.js";
import type { AnalogElement } from "../../analog/element.js";
import type { SparseSolver } from "../../analog/sparse-solver.js";
import { parseExpression } from "../../analog/expression.js";
import { differentiate, simplify } from "../../analog/expression-differentiate.js";
import { ControlledSourceElement } from "../../analog/controlled-source-base.js";

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

function buildVCCSPinDeclarations(): PinDeclaration[] {
  return [
    {
      direction: PinDirection.INPUT,
      label: "ctrl+",
      defaultBitWidth: 1,
      position: { x: 0, y: -1 },
      isNegatable: false,
      isClockCapable: false,
    },
    {
      direction: PinDirection.INPUT,
      label: "ctrl-",
      defaultBitWidth: 1,
      position: { x: 0, y: 1 },
      isNegatable: false,
      isClockCapable: false,
    },
    {
      direction: PinDirection.OUTPUT,
      label: "out+",
      defaultBitWidth: 1,
      position: { x: 4, y: -1 },
      isNegatable: false,
      isClockCapable: false,
    },
    {
      direction: PinDirection.OUTPUT,
      label: "out-",
      defaultBitWidth: 1,
      position: { x: 4, y: 1 },
      isNegatable: false,
      isClockCapable: false,
    },
  ];
}

// ---------------------------------------------------------------------------
// VCCSAnalogElement
// ---------------------------------------------------------------------------

/**
 * MNA analog element for a Voltage-Controlled Current Source.
 *
 * Node layout in nodeIds (from analogFactory):
 *   [0] = nCtrlP  (ctrl+ node)
 *   [1] = nCtrlN  (ctrl- node)
 *   [2] = nOutP   (out+ node)
 *   [3] = nOutN   (out- node)
 *
 * No branch variable (Norton stamp only).
 */
class VCCSAnalogElement extends ControlledSourceElement {
  readonly nodeIndices: readonly number[];
  readonly branchIndex = -1;

  private readonly _nCtrlP: number;
  private readonly _nCtrlN: number;
  private readonly _nOutP: number;
  private readonly _nOutN: number;

  constructor(
    nCtrlP: number,
    nCtrlN: number,
    nOutP: number,
    nOutN: number,
    expressionStr: string,
    transconductance: number,
  ) {
    // Build expression: if default "V(ctrl)", apply transconductance multiplier
    const rawExpr = parseExpression(expressionStr === "V(ctrl)"
      ? `${transconductance} * V(ctrl)`
      : expressionStr);
    const deriv = simplify(differentiate(rawExpr, "V(ctrl)"));

    super(rawExpr, deriv, "V(ctrl)", "voltage");

    this._nCtrlP = nCtrlP;
    this._nCtrlN = nCtrlN;
    this._nOutP = nOutP;
    this._nOutN = nOutN;

    this.nodeIndices = [nCtrlP, nCtrlN, nOutP, nOutN];
  }

  protected override _bindContext(voltages: Float64Array): void {
    const vCtrlP = this._nCtrlP > 0 ? voltages[this._nCtrlP - 1] : 0;
    const vCtrlN = this._nCtrlN > 0 ? voltages[this._nCtrlN - 1] : 0;
    const vCtrl = vCtrlP - vCtrlN;

    this._ctx.setNodeVoltage("ctrl", vCtrl);
    this._ctrlValue = vCtrl;
  }

  /**
   * Stamp the Norton equivalent for the controlled current source.
   *
   * Linearized around Vctrl0:
   *   I_out = f'(Vctrl0) * Vctrl + [f(Vctrl0) - f'(Vctrl0) * Vctrl0]
   *
   * G sub-matrix (transconductance Jacobian from ctrl to out):
   *   G[nOutP, nCtrlP] += f'    G[nOutP, nCtrlN] -= f'
   *   G[nOutN, nCtrlP] -= f'    G[nOutN, nCtrlN] += f'
   *
   * RHS (independent current source — NR constant term):
   *   RHS[nOutP] += f(Vctrl0) - f'(Vctrl0) * Vctrl0
   *   RHS[nOutN] -= f(Vctrl0) - f'(Vctrl0) * Vctrl0
   */
  override stampOutput(
    solver: SparseSolver,
    value: number,
    derivative: number,
    ctrlValue: number,
  ): void {
    const gm = derivative;
    const iNR = value - derivative * ctrlValue; // NR constant term

    // G sub-matrix: transconductance Jacobian.
    //
    // In MNA the KCL equation at nOutP is:
    //   G_load * V_out - gm * V_ctrl = 0  (for positive current into nOutP)
    //
    // Off-diagonal conductance stamp convention: G[outP, ctrlP] = -gm so that
    // the term appears as -gm * V_ctrlP in the KCL row, i.e. current gm*V_ctrl
    // is injected INTO nOutP (enters the node).
    if (this._nOutP !== 0 && this._nCtrlP !== 0) {
      solver.stamp(this._nOutP - 1, this._nCtrlP - 1, -gm);
    }
    if (this._nOutP !== 0 && this._nCtrlN !== 0) {
      solver.stamp(this._nOutP - 1, this._nCtrlN - 1, gm);
    }
    if (this._nOutN !== 0 && this._nCtrlP !== 0) {
      solver.stamp(this._nOutN - 1, this._nCtrlP - 1, gm);
    }
    if (this._nOutN !== 0 && this._nCtrlN !== 0) {
      solver.stamp(this._nOutN - 1, this._nCtrlN - 1, -gm);
    }

    // RHS: NR-linearized independent current source (constant term).
    // Positive iNR injected INTO nOutP (current enters node → positive RHS).
    if (this._nOutP !== 0) {
      solver.stampRHS(this._nOutP - 1, iNR);
    }
    if (this._nOutN !== 0) {
      solver.stampRHS(this._nOutN - 1, -iNR);
    }
  }
}

// ---------------------------------------------------------------------------
// VCCSElement — CircuitElement
// ---------------------------------------------------------------------------

export class VCCSElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("VCCS", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildVCCSPinDeclarations(), []);
  }

  getBoundingBox(): Rect {
    return {
      x: this.position.x,
      y: this.position.y - 2,
      width: 4,
      height: 4,
    };
  }

  draw(ctx: RenderContext): void {
    const label = this._properties.getOrDefault<string>("label", "");

    ctx.save();
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);

    // Circle body
    ctx.drawCircle(2, 0, 1.5);

    // Arrow indicating current source
    ctx.drawLine(2, -1, 2, 1);
    ctx.drawLine(2, -0.5, 1.5, 0);
    ctx.drawLine(2, -0.5, 2.5, 0);

    // Control port label
    ctx.setFont({ family: "sans-serif", size: 0.5 });
    ctx.drawText("ctrl", 0.5, 0, { horizontal: "center", vertical: "center" });

    if (label.length > 0) {
      ctx.setFont({ family: "sans-serif", size: 0.8 });
      ctx.drawText(label, 2, -2.3, { horizontal: "center", vertical: "bottom" });
    }

    ctx.restore();
  }

  getHelpText(): string {
    return (
      "Voltage-Controlled Current Source — 4-terminal element. " +
      "Output current = expression(V_ctrl). " +
      "Pins: ctrl+, ctrl- (control sense), out+, out- (output)."
    );
  }
}

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const VCCS_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "expression",
    type: PropertyType.STRING,
    label: "Transfer function",
    defaultValue: "V(ctrl)",
    description: "Expression defining output current as function of V(ctrl). Default: V(ctrl) (unity transconductance).",
  },
  {
    key: "transconductance",
    type: PropertyType.FLOAT,
    label: "Transconductance gm (S)",
    defaultValue: 0.001,
    description: "Linear transconductance in siemens. Used when expression is the default 'V(ctrl)'. Default: 1mS.",
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

const VCCS_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  { xmlName: "expression",       propertyKey: "expression",       convert: (v) => v },
  { xmlName: "transconductance", propertyKey: "transconductance", convert: (v) => parseFloat(v) },
  { xmlName: "Label",            propertyKey: "label",            convert: (v) => v },
];

// ---------------------------------------------------------------------------
// VCCSDefinition
// ---------------------------------------------------------------------------

export const VCCSDefinition: ComponentDefinition = {
  name: "VCCS",
  typeId: -1,
  engineType: "analog",
  category: ComponentCategory.ACTIVE,
  executeFn: noOpAnalogExecuteFn,

  pinLayout: buildVCCSPinDeclarations(),
  propertyDefs: VCCS_PROPERTY_DEFS,
  attributeMap: VCCS_ATTRIBUTE_MAPPINGS,

  helpText:
    "Voltage-Controlled Current Source — output current is an expression of " +
    "the control port voltage V(ctrl+ - ctrl-).",

  factory(props: PropertyBag): VCCSElement {
    return new VCCSElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
  },

  analogFactory(
    nodeIds: number[],
    _branchIdx: number,
    props: PropertyBag,
  ): AnalogElement {
    const expression = props.getOrDefault<string>("expression", "V(ctrl)");
    const transconductance = props.getOrDefault<number>("transconductance", 0.001);
    return new VCCSAnalogElement(
      nodeIds[0], // ctrl+
      nodeIds[1], // ctrl-
      nodeIds[2], // out+
      nodeIds[3], // out-
      expression,
      transconductance,
    );
  },
};
