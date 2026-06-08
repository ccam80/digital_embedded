/**
 * Voltage-Controlled Current Source (VCCS) analog component.
 *
 * Four-terminal element: ctrl+ and ctrl- sense the control voltage;
 * out+ and out- are the output current source terminals.
 *
 * Per the SPICE G-element convention (ngspice user manual, vccsload.c:34-37):
 * current flows FROM out+, through the source, TO out-. The output magnitude
 * is an expression of the control voltage:
 *   I_out = f(V_ctrl)  where  V_ctrl = V(ctrl+) - V(ctrl-)
 * Positive `transconductance` therefore PULLS current out of out+ and pushes
 * it into out- (not "injects into out+" - that is the textbook MNA convention
 * but is NOT what SPICE G-elements implement).
 *
 * A linear shortcut is provided via the `transconductance` property: when
 * `expression` is the default ("V(ctrl)"), the effective expression is
 * `transconductance * V(ctrl)`.
 *
 * MNA formulation (Norton stamp- no branch variable):
 *   setup() allocates 4 off-diagonal matrix handles (vccsset.c:43-46 port).
 *   load() stamps the NR-linearized Norton equivalent using cached handles
 *   line-for-line with ngspice vccsload.c:34-37:
 *
 *     G[nOutP, nCtrlP] += f'    G[nOutP, nCtrlN] -= f'
 *     G[nOutN, nCtrlP] -= f'    G[nOutN, nCtrlN] += f'
 *     RHS[nOutP] -= f(Vctrl0) - f'(Vctrl0) * Vctrl0
 *     RHS[nOutN] += f(Vctrl0) - f'(Vctrl0) * Vctrl0
 *
 *   NR linearization around Vctrl0 (current op point):
 *     I_out(Vctrl) = f(Vctrl0) + f'(Vctrl0) * (Vctrl - Vctrl0)
 *                  = f'(Vctrl0) * Vctrl + [f(Vctrl0) - f'(Vctrl0)*Vctrl0]
 *
 * At convergence (Vctrl = Vctrl0) the current leaving out+ equals f(Vctrl0).
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
import { NGSPICE_LOAD_ORDER, type DeviceFamily } from "../../solver/analog/ngspice-load-order.js";
import type { SetupContext } from "../../solver/analog/setup-context.js";
import { defineModelParams } from "../../core/model-params.js";

// ---------------------------------------------------------------------------
// Model parameter declarations
// ---------------------------------------------------------------------------

export const { paramDefs: VCCS_PARAM_DEFS, defaults: VCCS_DEFAULTS } = defineModelParams({
  primary: {
    transconductance: { default: 0.001, unit: "S", description: "Linear transconductance gm" },
    // VCCSmValue, vccs.c:14 IOP("m", VCCS_M, ...) — parallel multiplier, default 1
    M: { default: 1, description: "Parallel multiplier" },
  },
});

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

function buildVCCSPinDeclarations(): PinDeclaration[] {
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
// VCCSAnalogElement
// ---------------------------------------------------------------------------

/**
 * MNA analog element for a Voltage-Controlled Current Source.
 *
 * ctrl+ and ctrl- sense the control voltage; out+ and out- are the output
 * current source terminals. No branch variable (Norton stamp only).
 */
export class VCCSAnalogElement extends ControlledSourceElement {
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.VCCS;
  readonly deviceFamily: DeviceFamily = "VCCS";

  // TSTALLOC handles- allocated in setup(), written in load()
  // vccsset.c:43-46 line-for-line
  private _hPCtP: number = -1; // G[posNode, ctrlPosNode]  :43
  private _hPCtN: number = -1; // G[posNode, ctrlNegNode]  :44
  private _hNCtP: number = -1; // G[negNode, ctrlPosNode]  :45
  private _hNCtN: number = -1; // G[negNode, ctrlNegNode]  :46

  setup(ctx: SetupContext): void {
    const solver = ctx.solver;
    const posNode     = this.pinNodes.get("out+")!;   // VCCSposNode
    const negNode     = this.pinNodes.get("out-")!;   // VCCSnegNode
    const ctrlPosNode = this.pinNodes.get("ctrl+")!;  // VCCScontPosNode
    const ctrlNegNode = this.pinNodes.get("ctrl-")!;  // VCCScontNegNode

    // TSTALLOC sequence: vccsset.c:43-46, line-for-line
    this._hPCtP = solver.allocElement(posNode, ctrlPosNode); // :43
    this._hPCtN = solver.allocElement(posNode, ctrlNegNode); // :44
    this._hNCtP = solver.allocElement(negNode, ctrlPosNode); // :45
    this._hNCtN = solver.allocElement(negNode, ctrlNegNode); // :46
  }

  /**
   * Readonly accessor for composites (PB-TRIODE) that stamp
   * through the VCCS without owning the handle fields directly.
   */
  get stamps(): { pCtP: number; pCtN: number; nCtP: number; nCtN: number } {
    return {
      pCtP: this._hPCtP,
      pCtN: this._hPCtN,
      nCtP: this._hNCtP,
      nCtN: this._hNCtN,
    };
  }

  setParam(_key: string, _value: number): void {
  }

  protected override _bindContext(rhsOld: Float64Array): void {
    const ctrlPosNode = this.pinNodes.get("ctrl+")!;
    const ctrlNegNode = this.pinNodes.get("ctrl-")!;
    const vCtrlP = ctrlPosNode > 0 ? rhsOld[ctrlPosNode] : 0;
    const vCtrlN = ctrlNegNode > 0 ? rhsOld[ctrlNegNode] : 0;
    const vCtrl = vCtrlP - vCtrlN;

    this._ctx.setNodeVoltage("ctrl", vCtrl);
    this._ctrlValue = vCtrl;
  }

  /**
   * Stamp the Norton transconductance matrix using cached handles.
   * Port of vccsload.c:34-37, value-side only- no allocElement calls.
   *
   * SPICE G-element convention: current flows FROM out+ TO out-, so a
   * positive value f(Vctrl) appears as +gm at G[posNode, ctrlPosNode]
   * and the constant term subtracts from RHS[posNode] / adds to RHS[negNode].
   */
  override stampOutput(
    solver: SparseSolver,
    rhs: Float64Array,
    value: number,
    derivative: number,
    ctrlValue: number,
  ): void {
    const gm  = derivative;
    const iNR = value - derivative * ctrlValue; // NR constant term

    solver.stampElement(this._hPCtP,  gm); // G[posNode, ctrlPosNode]   vccsload.c:34
    solver.stampElement(this._hPCtN, -gm); // G[posNode, ctrlNegNode]   vccsload.c:35
    solver.stampElement(this._hNCtP, -gm); // G[negNode, ctrlPosNode]   vccsload.c:36
    solver.stampElement(this._hNCtN,  gm); // G[negNode, ctrlNegNode]   vccsload.c:37

    const posNode = this.pinNodes.get("out+")!;
    const negNode = this.pinNodes.get("out-")!;
    // Unconditional - ground rows land in rhs[0], cleared post-solve.
    rhs[posNode] -= iNR;
    rhs[negNode] += iNR;
  }

  /**
   * Per-pin currents in pinLayout order: [ctrl+, ctrl-, out+, out-].
   *
   * The control port is an ideal voltage sensor (infinite impedance), so it
   * draws zero current. The output current is f(V_ctrl) evaluated at the
   * current operating point. Positive = current flowing INTO the pin.
   *
   * Per the SPICE G-element convention (matches matrix stamps), positive
   * f(V_ctrl) means current LEAVES out+ and ARRIVES at out-: into-pin
   * current at out+ is -I_out, at out- is +I_out.
   */
  getPinCurrents(_rhs: Float64Array): number[] {
    const iOut = this._compiledExpr(this._ctx);
    return [0, 0, -iOut, iOut];
  }
}

// ---------------------------------------------------------------------------
// VCCSElement- CircuitElement
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
      y: this.position.y,
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

    // Body- rect and port lines stay COMPONENT
    ctx.setColor("COMPONENT");
    ctx.drawRect(1, -2, 4, 4, false);

    // ctrl+ lead
    drawColoredLead(ctx, signals, vCtrlP, 0, -1, 1, -1);

    // ctrl- lead
    drawColoredLead(ctx, signals, vCtrlN, 0, 1, 1, 1);

    // out+ lead
    drawColoredLead(ctx, signals, vOutP, 6, -1, 5, -1);

    // out- lead
    drawColoredLead(ctx, signals, vOutN, 6, 1, 5, 1);

    // Pin labels inside body
    ctx.setColor("TEXT");
    ctx.setFont({ family: "sans-serif", size: 0.6 });
    ctx.drawText("ctrl+", 1.2, -1, { horizontal: "left", vertical: "middle" });
    ctx.drawText("ctrlâˆ’", 1.2, 1, { horizontal: "left", vertical: "middle" });
    ctx.drawText("out+",  4.8, -1, { horizontal: "right", vertical: "middle" });
    ctx.drawText("outâˆ’",  4.8, 1, { horizontal: "right", vertical: "middle" });

    ctx.restore();
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
  { xmlName: "transconductance", propertyKey: "transconductance", convert: (v) => parseFloat(v), modelParam: true },
  { xmlName: "m",                propertyKey: "M",                convert: (v) => parseFloat(v), modelParam: true },
  { xmlName: "Label",            propertyKey: "label",            convert: (v) => v },
];

// ---------------------------------------------------------------------------
// VCCSDefinition
// ---------------------------------------------------------------------------

export const VCCSDefinition: StandaloneComponentDefinition = {
  name: "VCCS",
  typeId: -1,
  category: ComponentCategory.ACTIVE,

  pinLayout: buildVCCSPinDeclarations(),
  voltageProbes: [
    { name: "Vctrl", pos: "ctrl+", neg: "ctrl-" },
    { name: "Vout", pos: "out+", neg: "out-" },
  ],
  propertyDefs: VCCS_PROPERTY_DEFS,
  attributeMap: VCCS_ATTRIBUTE_MAPPINGS,

  helpText:
    "Voltage-Controlled Current Source- output current is an expression of " +
    "the control port voltage V(ctrl+ - ctrl-).",

  factory(props: PropertyBag): VCCSElement {
    return new VCCSElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
  },

  models: {},
  modelRegistry: {
    "behavioral": {
      kind: "inline",
      factory: (pinNodes, props, _getTime) => {
        const expression = props.getOrDefault<string>("expression", "V(ctrl)");
        const transconductance = props.getModelParam<number>("transconductance");
        const m = props.getModelParam<number>("M"); // VCCSmValue, default 1
        // vccspar.c:27-28 — VCCScoeff *= VCCSmValue (m defaults to 1, so the
        // product is the bare transconductance when m is not netlisted).
        const effectiveGm = transconductance * m;
        const rawExpr = parseExpression(expression === "V(ctrl)"
          ? `${effectiveGm} * V(ctrl)`
          : `(${m}) * (${expression})`);
        const deriv = simplify(differentiate(rawExpr, "V(ctrl)"));
        return new VCCSAnalogElement(pinNodes, rawExpr, deriv, "V(ctrl)", "voltage");
      },
      paramDefs: VCCS_PARAM_DEFS,
      params: VCCS_DEFAULTS,
    },
  },
  defaultModel: "behavioral",
};
