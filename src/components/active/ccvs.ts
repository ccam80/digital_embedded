/**
 * Current-Controlled Voltage Source (CCVS) analog component.
 *
 * Four-terminal element: sense+ and sense- form the current sense port;
 * out+ and out- are the output voltage source terminals.
 *
 * The output voltage equals an expression of the sensed current:
 *   V_out = f(I_sense)  where  I_sense flows into sense+
 *
 * A linear shortcut is provided via the `transresistance` property: when
 * `expression` is the default ("I(sense)"), the effective expression is
 * `transresistance * I(sense)`.
 *
 * MNA formulation (port of ngspice ccvsset.c / ccvsload.c):
 *   CCVS has one own branch row (the output voltage source current).
 *   setup() allocates it via ctx.makeCur (ccvsset.c:40-43), resolves the
 *   controlling branch via ctx.findBranch, then allocates 5 handles
 *   (ccvsset.c:58-62):
 *     _hPIbr    = G[posNode,   ownBranch]   :58
 *     _hNIbr    = G[negNode,   ownBranch]   :59
 *     _hIbrN    = G[ownBranch, negNode]     :60
 *     _hIbrP    = G[ownBranch, posNode]     :61
 *     _hIbrCtBr = G[ownBranch, contBranch]  :62
 *
 *   load() stamps B/C incidence for the output voltage source branch and
 *   the Jacobian linking the output branch equation to the controlling
 *   branch variable.
 *
 * senseSourceLabel MUST be set via setParam("senseSourceLabel", ...) at
 * compile time before setup() runs.
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
import { parseExpression } from "../../solver/analog/expression.js";
import { differentiate, simplify } from "../../solver/analog/expression-differentiate.js";
import { ControlledSourceElement } from "../../solver/analog/controlled-source-base.js";
import { NGSPICE_LOAD_ORDER } from "../../solver/analog/element.js";
import type { SetupContext } from "../../solver/analog/setup-context.js";
import type { SparseSolver } from "../../solver/analog/sparse-solver.js";
import type { LoadContext } from "../../solver/analog/load-context.js";
import { defineModelParams } from "../../core/model-params.js";

// ---------------------------------------------------------------------------
// Model parameter declarations
// ---------------------------------------------------------------------------

export const { paramDefs: CCVS_PARAM_DEFS, defaults: CCVS_DEFAULTS } = defineModelParams({
  primary: {
    transresistance: { default: 1000, unit: "Ω", description: "Linear transresistance" },
  },
});

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

function buildCCVSPinDeclarations(): PinDeclaration[] {
  return [
    {
      direction: PinDirection.INPUT,
      label: "sense+",
      defaultBitWidth: 1,
      position: { x: 0, y: 0 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.INPUT,
      label: "sense-",
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
// CCVSAnalogElement
// ---------------------------------------------------------------------------

/**
 * MNA analog element for a Current-Controlled Voltage Source.
 *
 * out+ and out- are the output voltage source terminals.
 * branchIndex: own output voltage source branch, set during setup().
 */
export class CCVSAnalogElement extends ControlledSourceElement {
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.CCVS;

  // senseSourceLabel- label of the controlling VSRC/CCVS/VCVS/IND.
  // Must be set via setParam("senseSourceLabel", label) before setup() runs.
  private _senseSourceLabel: string = "";

  // Resolved controlling branch index (filled in setup()).
  private _contBranch: number = -1;

  // TSTALLOC handles- allocated in setup(), written in load()
  // ccvsset.c:58-62 line-for-line
  private _hPIbr:    number = -1; // G[posNode,   ownBranch]   :58
  private _hNIbr:    number = -1; // G[negNode,   ownBranch]   :59
  private _hIbrN:    number = -1; // G[ownBranch, negNode]     :60
  private _hIbrP:    number = -1; // G[ownBranch, posNode]     :61
  private _hIbrCtBr: number = -1; // G[ownBranch, contBranch]  :62

  setup(ctx: SetupContext): void {
    const solver = ctx.solver;
    const posNode = this._pinNodes.get("out+")!;  // CCVSposNode  (pinNodeIds[2])
    const negNode = this._pinNodes.get("out-")!;  // CCVSnegNode  (pinNodeIds[3])

    // Own branch row: ccvsset.c:40-43 (idempotent guard)
    if (this.branchIndex === -1) {
      this.branchIndex = ctx.makeCur(this.label ?? "ccvs", "branch");
    }
    const ownBranch = this.branchIndex;

    // Resolve controlling branch: ccvsset.c:45
    // ctx.findBranch dispatches to the controlling source's findBranchFor
    // callback (lazy-allocating per 00-engine.md ssA2/A4.2).
    if (!this._senseSourceLabel) {
      throw new Error(`CCVS '${this.label}': senseSourceLabel not set before setup()`);
    }
    const contBranch = ctx.findBranch(this._senseSourceLabel);
    if (contBranch === 0) {
      throw new Error(
        `CCVS '${this.label}': unknown controlling source '${this._senseSourceLabel}'`,
      );
    }
    this._contBranch = contBranch;

    // TSTALLOC sequence: ccvsset.c:58-62, line-for-line
    this._hPIbr    = solver.allocElement(posNode,   ownBranch);  // :58
    this._hNIbr    = solver.allocElement(negNode,   ownBranch);  // :59
    this._hIbrN    = solver.allocElement(ownBranch, negNode);    // :60
    this._hIbrP    = solver.allocElement(ownBranch, posNode);    // :61
    this._hIbrCtBr = solver.allocElement(ownBranch, contBranch); // :62
  }

  setParam(key: string, value: number | string): void {
    if (key === "senseSourceLabel" && typeof value === "string") {
      this._senseSourceLabel = value;
    }
  }

  protected override _stampLinear(solver: SparseSolver): void {
    // Stamp B/C incidence for the own output voltage source branch.
    // Values are constant topology entries (±1); stamp every load() call.
    solver.stampElement(this._hPIbr,  1);  // B[posNode, ownBranch]
    solver.stampElement(this._hNIbr, -1);  // B[negNode, ownBranch]
    solver.stampElement(this._hIbrN, -1);  // C[ownBranch, negNode]
    solver.stampElement(this._hIbrP,  1);  // C[ownBranch, posNode]
  }

  protected override _bindContext(rhsOld: Float64Array): void {
    const iSense = rhsOld[this._contBranch];
    this._ctx.setBranchCurrentByIndex("sense", this._contBranch, rhsOld);
    this._ctrlValue = iSense;
  }

  /**
   * Stamp Jacobian and NR-linearized RHS for the output branch.
   * Port of ccvsload.c value-side- no allocElement calls.
   *
   * Output branch equation: V_out+ - V_out- - rm*I_sense = f(I0) - rm*I0
   *
   * Jacobian entry linking output branch row to controlling branch variable:
   *   G[ownBranch, contBranch] = -rm
   *
   * RHS[ownBranch] += f(I0) - f'(I0)*I0  (NR-linearized constant term)
   */
  override stampOutput(
    solver: SparseSolver,
    rhs: Float64Array,
    value: number,
    derivative: number,
    ctrlValue: number,
  ): void {
    const rm  = derivative;
    const vNR = value - derivative * ctrlValue;

    solver.stampElement(this._hIbrCtBr, -rm); // C[ownBranch, contBranch]

    rhs[this.branchIndex] += vNR;
  }

  /**
   * Per-pin currents in pinLayout order: [sense+, sense-, out+, out-].
   *
   * The sense port current flows through the external sense VSRC.
   * The output port current is the own branch variable.
   * Positive = current flowing INTO the pin.
   */
  getPinCurrents(rhs: Float64Array): number[] {
    const iSense = this._contBranch >= 0 ? rhs[this._contBranch] : 0;
    const iOut   = this.branchIndex >= 0  ? rhs[this.branchIndex]  : 0;
    return [iSense, -iSense, iOut, -iOut];
  }

  /**
   * Override load() to use cached handles- no allocElement calls.
   */
  override load(ctx: LoadContext): void {
    this._bindContext(ctx.rhsOld);
    this._stampLinear(ctx.solver);
    const value = this._compiledExpr(this._ctx);
    const deriv = this._compiledDeriv(this._ctx);
    this.stampOutput(ctx.solver, ctx.rhs, value, deriv, this._ctrlValue);
  }
}

// ---------------------------------------------------------------------------
// CCVSElement- CircuitElement
// ---------------------------------------------------------------------------

export class CCVSElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("CCVS", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildCCVSPinDeclarations(), []);
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
    const vSenseP = signals?.getPinVoltage("sense+");
    const vSenseN = signals?.getPinVoltage("sense-");
    const vOutP   = signals?.getPinVoltage("out+");
    const vOutN   = signals?.getPinVoltage("out-");

    ctx.save();
    ctx.setLineWidth(1);

    // Body- open polyline box (1,-1)→(5,-1)→(5,3)→(1,3) (no left edge)
    ctx.setColor("COMPONENT");
    ctx.drawLine(1, -1, 5, -1);
    ctx.drawLine(5, -1, 5, 3);
    ctx.drawLine(5, 3, 1, 3);

    // sense+ lead: x=0 to x=1, y=0
    drawColoredLead(ctx, signals, vSenseP, 0, 0, 1, 0);

    // sense- lead: x=0 to x=1, y=2
    drawColoredLead(ctx, signals, vSenseN, 0, 2, 1, 2);

    // out+ lead: x=5 to x=6, y=0
    drawColoredLead(ctx, signals, vOutP, 5, 0, 6, 0);

    // out- lead: x=5 to x=6, y=2
    drawColoredLead(ctx, signals, vOutN, 5, 2, 6, 2);

    // Pin labels inside body
    ctx.setColor("TEXT");
    ctx.setFont({ family: "sans-serif", size: 0.6 });
    ctx.drawText("sense+", 1.2, 0, { horizontal: "left", vertical: "middle" });
    ctx.drawText("sense−", 1.2, 2, { horizontal: "left", vertical: "middle" });
    ctx.drawText("out+",   4.8, 0, { horizontal: "right", vertical: "middle" });
    ctx.drawText("out−",   4.8, 2, { horizontal: "right", vertical: "middle" });

    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const CCVS_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "expression",
    type: PropertyType.STRING,
    label: "Transfer function",
    defaultValue: "I(sense)",
    description: "Expression defining output voltage as function of I(sense). Default: I(sense).",
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

const CCVS_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  { xmlName: "expression",     propertyKey: "expression",     convert: (v) => v },
  { xmlName: "transresistance",propertyKey: "transresistance",convert: (v) => parseFloat(v), modelParam: true },
  { xmlName: "Label",          propertyKey: "label",          convert: (v) => v },
];

// ---------------------------------------------------------------------------
// CCVSDefinition
// ---------------------------------------------------------------------------

export const CCVSDefinition: ComponentDefinition = {
  name: "CCVS",
  typeId: -1,
  category: ComponentCategory.ACTIVE,

  pinLayout: buildCCVSPinDeclarations(),
  propertyDefs: CCVS_PROPERTY_DEFS,
  attributeMap: CCVS_ATTRIBUTE_MAPPINGS,

  helpText:
    "Current-Controlled Voltage Source- output voltage is an expression of " +
    "the current through the sense port.",

  factory(props: PropertyBag): CCVSElement {
    return new CCVSElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
  },

  models: {},
  modelRegistry: {
    "behavioral": {
      kind: "inline",
      factory: (pinNodes, props, _getTime) => {
        const expression = props.getOrDefault<string>("expression", "I(sense)");
        const transresistance = props.getModelParam<number>("transresistance");
        const rawExpr = parseExpression(expression === "I(sense)"
          ? `${transresistance} * I(sense)`
          : expression);
        const deriv = simplify(differentiate(rawExpr, "I(sense)"));
        const el = new CCVSAnalogElement(rawExpr, deriv, "I(sense)", "current");
        el._pinNodes = new Map(pinNodes);
        return el;
      },
      paramDefs: CCVS_PARAM_DEFS,
      params: CCVS_DEFAULTS,
      ngspiceNodeMap: { "out+": "pos", "out-": "neg" },
    },
  },
  defaultModel: "behavioral",
};
