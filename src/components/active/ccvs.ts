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
 * MNA formulation:
 *   Current sensing is accomplished by inserting a 0V voltage source in series
 *   with the sense port. This creates a dedicated branch variable at row
 *   `senseBranchIdx` whose value equals the sensed current. The expression
 *   binds `I(sense)` to this branch variable via `getBranchCurrent("sense")`.
 *
 *   Two branch variables are required:
 *     senseBranchIdx = branchIdx     (0V sense source)
 *     outBranchIdx   = branchIdx + 1 (output voltage source)
 *
 *   Sense port (0V source, nodes sense+ / sense-):
 *     B[nSenseP, senseBranch] += 1   C[senseBranch, nSenseP] += 1
 *     B[nSenseN, senseBranch] -= 1   C[senseBranch, nSenseN] -= 1
 *     RHS[senseBranch] = 0  (0V)
 *
 *   Output port (dependent voltage source, nodes out+ / out-):
 *     `_stampLinear()` places B/C incidence for out branch (and the sense 0V
 *     source incidence above).
 *     `load()` (via base class) binds I_sense, calls `_stampLinear`, evaluates
 *     f(I_sense) and f'(I_sense), then calls `stampOutput()` which fills the
 *     Jacobian and NR-linearized RHS:
 *       C[outBranch, senseBranch] -= f'(I_sense)  (Jacobian: dV_out/dI_sense)
 *       RHS[outBranch] = f(I0) - f'(I0) * I0
 *
 * At convergence the output branch equation is:
 *   V_out+ - V_out- - f'*I_sense = f(I0) - f'*I0
 * which gives V_out = f(I0) when I_sense = I0. ✓
 *
 * Note: the `analogFactory` receives `branchIdx` as the first (sense) branch.
 * The output branch is at `branchIdx + 1`. Tests must allocate 2 branch rows
 * for CCVS in the circuit's branchCount.
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
 * Node layout in nodeIds (from analogFactory):
 *   [0] = nSenseP  (sense+ node)
 *   [1] = nSenseN  (sense- node)
 *   [2] = nOutP    (out+ node)
 *   [3] = nOutN    (out- node)
 *
 * branchIdx (the value passed to analogFactory): absolute 0-based sense branch row.
 * outBranchIdx = branchIdx + 1: absolute 0-based output branch row.
 */
class CCVSAnalogElement extends ControlledSourceElement {
  readonly branchIndex: number; // sense branch (used by AnalogElement interface)

  private readonly _nSenseP: number;
  private readonly _nSenseN: number;
  private readonly _nOutP: number;
  private readonly _nOutN: number;
  private readonly _senseBranch: number; // absolute MNA row for 0V sense source
  private readonly _outBranch: number;   // absolute MNA row for output voltage source

  constructor(
    nSenseP: number,
    nSenseN: number,
    nOutP: number,
    nOutN: number,
    senseBranchIdx: number,
    expressionStr: string,
    transresistance: number,
  ) {
    const rawExpr = parseExpression(expressionStr === "I(sense)"
      ? `${transresistance} * I(sense)`
      : expressionStr);
    const deriv = simplify(differentiate(rawExpr, "I(sense)"));

    super(rawExpr, deriv, "I(sense)", "current");

    this._nSenseP = nSenseP;
    this._nSenseN = nSenseN;
    this._nOutP = nOutP;
    this._nOutN = nOutN;
    this._senseBranch = senseBranchIdx;
    this._outBranch = senseBranchIdx + 1;
    this.branchIndex = senseBranchIdx;
  }

  setParam(_key: string, _value: number): void {
  }

  /**
   * Stamp linear B/C incidence for both branch variables.
   *
   * Sense 0V source (enforces V_senseP - V_senseN = 0):
   *   B[nSenseP, senseBranch] += 1   C[senseBranch, nSenseP] += 1
   *   B[nSenseN, senseBranch] -= 1   C[senseBranch, nSenseN] -= 1
   *   RHS[senseBranch] = 0
   *
   * Output voltage source (incidence only; Jacobian stamped in stampOutput):
   *   B[nOutP, outBranch] += 1   C[outBranch, nOutP] += 1
   *   B[nOutN, outBranch] -= 1   C[outBranch, nOutN] -= 1
   */
  protected override _stampLinear(solver: SparseSolver): void {
    const ks = this._senseBranch;
    const ko = this._outBranch;

    // Sense 0V source incidence
    if (this._nSenseP !== 0) {
      solver.stampElement(solver.allocElement(this._nSenseP - 1, ks), 1);
      solver.stampElement(solver.allocElement(ks, this._nSenseP - 1), 1);
    }
    if (this._nSenseN !== 0) {
      solver.stampElement(solver.allocElement(this._nSenseN - 1, ks), -1);
      solver.stampElement(solver.allocElement(ks, this._nSenseN - 1), -1);
    }
    // RHS = 0V for sense source (no explicit stamp needed — beginAssembly zeros RHS)

    // Output voltage source incidence
    if (this._nOutP !== 0) {
      solver.stampElement(solver.allocElement(this._nOutP - 1, ko), 1);
      solver.stampElement(solver.allocElement(ko, this._nOutP - 1), 1);
    }
    if (this._nOutN !== 0) {
      solver.stampElement(solver.allocElement(this._nOutN - 1, ko), -1);
      solver.stampElement(solver.allocElement(ko, this._nOutN - 1), -1);
    }
  }

  protected override _bindContext(voltages: Float64Array): void {
    // Read sense current from the sense branch variable
    const iSense = voltages[this._senseBranch];
    this._ctx.setBranchCurrentByIndex("sense", this._senseBranch, voltages);
    this._ctrlValue = iSense;
  }

  /**
   * Stamp Jacobian and NR-linearized RHS for the output branch.
   *
   * Output branch equation: V_out+ - V_out- - f'(I0)*I_sense = f(I0) - f'*I0
   *
   * The Jacobian entry links the output branch row to the sense branch variable:
   *   C[outBranch, senseBranch] -= f'(I0)
   *
   * RHS: f(I0) - f'(I0) * I0
   */
  override stampOutput(
    solver: SparseSolver,
    value: number,
    derivative: number,
    ctrlValue: number,
  ): void {
    const ko = this._outBranch;
    const ks = this._senseBranch;

    // Jacobian: dV_out/dI_sense — links output branch equation to sense branch variable
    solver.stampElement(solver.allocElement(ko, ks), -derivative);

    // NR-linearized RHS
    solver.stampRHS(ko, value - derivative * ctrlValue);
  }

  /**
   * Per-pin currents in pinLayout order: [sense+, sense-, out+, out-].
   *
   * The sense port is a 0V voltage source whose branch variable holds the
   * sensed current. The output port is a dependent voltage source whose
   * branch variable holds the output current. Positive = current INTO the pin.
   * KCL: I_senseP + I_senseN + I_outP + I_outN = I - I + J - J = 0. ✓
   */
  getPinCurrents(voltages: Float64Array): number[] {
    const iSense = voltages[this._senseBranch];
    const iOut   = voltages[this._outBranch];
    return [iSense, -iSense, iOut, -iOut];
  }
}

// ---------------------------------------------------------------------------
// CCVSElement — CircuitElement
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

    // Body — open polyline box (1,-1)→(5,-1)→(5,3)→(1,3) (no left edge)
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
    ctx.drawText("sense\u2212", 1.2, 2, { horizontal: "left", vertical: "middle" });
    ctx.drawText("out+",   4.8, 0, { horizontal: "right", vertical: "middle" });
    ctx.drawText("out\u2212",   4.8, 2, { horizontal: "right", vertical: "middle" });

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
    "Current-Controlled Voltage Source — output voltage is an expression of " +
    "the current through the sense port.",

  factory(props: PropertyBag): CCVSElement {
    return new CCVSElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
  },

  models: {},
  modelRegistry: {
    "behavioral": {
      kind: "inline",
      factory: (pinNodes, _internalNodeIds, branchIdx, props) => {
        const expression = props.getOrDefault<string>("expression", "I(sense)");
        const transresistance = props.getModelParam<number>("transresistance");
        return new CCVSAnalogElement(
          pinNodes.get("sense+")!,
          pinNodes.get("sense-")!,
          pinNodes.get("out+")!,
          pinNodes.get("out-")!,
          branchIdx,
          expression,
          transresistance,
        );
      },
      paramDefs: CCVS_PARAM_DEFS,
      params: CCVS_DEFAULTS,
      branchCount: 2,
    },
  },
  defaultModel: "behavioral",
};
