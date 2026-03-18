/**
 * Current-Controlled Current Source (CCCS) analog component.
 *
 * Four-terminal element: sense+ and sense- form the current sense port;
 * out+ and out- are the output current source terminals.
 *
 * The output current equals an expression of the sensed current:
 *   I_out = f(I_sense)  where  I_sense flows into sense+
 *
 * A linear shortcut is provided via the `currentGain` property: when
 * `expression` is the default ("I(sense)"), the effective expression is
 * `currentGain * I(sense)`.
 *
 * MNA formulation:
 *   Current sensing uses a 0V voltage source (same as CCVS). One branch
 *   variable is required for the sense source at `senseBranchIdx = branchIdx`.
 *
 *   Sense port (0V source):
 *     B[nSenseP, senseBranch] += 1   C[senseBranch, nSenseP] += 1
 *     B[nSenseN, senseBranch] -= 1   C[senseBranch, nSenseN] -= 1
 *     RHS[senseBranch] = 0  (0V)
 *
 *   Output port (Norton stamp — no branch variable):
 *     The NR-linearized Norton equivalent at operating point I0:
 *       I_out ≈ f'(I0) * I_sense + [f(I0) - f'(I0) * I0]
 *
 *     In MNA, I_sense is a branch variable at row senseBranch. The current
 *     flowing out of row senseBranch (i.e., through the sense 0V source into
 *     nSenseP) appears in the solution as voltages[senseBranch]. To inject this
 *     into the output nodes as a controlled current source:
 *
 *     G sub-matrix (linking sense branch variable column to output node rows):
 *       G[nOutP, senseBranch] -= f'(I0)   (inject f' * I_sense into nOutP)
 *       G[nOutN, senseBranch] += f'(I0)
 *
 *     RHS (NR constant term, independent current source):
 *       RHS[nOutP] += f(I0) - f'(I0) * I0
 *       RHS[nOutN] -= f(I0) - f'(I0) * I0
 *
 * At convergence (I_sense = I0) the current injected into out+ equals f(I0). ✓
 *
 * Note: the `analogFactory` receives `branchIdx` as the sense branch row.
 * Tests must allocate at least 1 branch row for CCCS in the circuit's branchCount.
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

function buildCCCSPinDeclarations(): PinDeclaration[] {
  return [
    {
      direction: PinDirection.INPUT,
      label: "sense+",
      defaultBitWidth: 1,
      position: { x: 0, y: -1 },
      isNegatable: false,
      isClockCapable: false,
    },
    {
      direction: PinDirection.INPUT,
      label: "sense-",
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
// CCCSAnalogElement
// ---------------------------------------------------------------------------

/**
 * MNA analog element for a Current-Controlled Current Source.
 *
 * Node layout in nodeIds (from analogFactory):
 *   [0] = nSenseP  (sense+ node)
 *   [1] = nSenseN  (sense- node)
 *   [2] = nOutP    (out+ node)
 *   [3] = nOutN    (out- node)
 *
 * branchIdx: absolute 0-based sense branch row (for the 0V sense source).
 * No output branch variable (Norton stamp).
 */
class CCCSAnalogElement extends ControlledSourceElement {
  readonly nodeIndices: readonly number[];
  readonly branchIndex: number; // sense branch

  private readonly _nSenseP: number;
  private readonly _nSenseN: number;
  private readonly _nOutP: number;
  private readonly _nOutN: number;
  private readonly _senseBranch: number;

  constructor(
    nSenseP: number,
    nSenseN: number,
    nOutP: number,
    nOutN: number,
    senseBranchIdx: number,
    expressionStr: string,
    currentGain: number,
  ) {
    const rawExpr = parseExpression(expressionStr === "I(sense)"
      ? `${currentGain} * I(sense)`
      : expressionStr);
    const deriv = simplify(differentiate(rawExpr, "I(sense)"));

    super(rawExpr, deriv, "I(sense)", "current");

    this._nSenseP = nSenseP;
    this._nSenseN = nSenseN;
    this._nOutP = nOutP;
    this._nOutN = nOutN;
    this._senseBranch = senseBranchIdx;

    this.nodeIndices = [nSenseP, nSenseN, nOutP, nOutN];
    this.branchIndex = senseBranchIdx;
  }

  /**
   * Stamp linear B/C incidence for the sense 0V source branch.
   *
   *   B[nSenseP, senseBranch] += 1   C[senseBranch, nSenseP] += 1
   *   B[nSenseN, senseBranch] -= 1   C[senseBranch, nSenseN] -= 1
   *   RHS[senseBranch] = 0  (0V, not explicitly stamped — zeros from beginAssembly)
   */
  override stamp(solver: SparseSolver): void {
    const ks = this._senseBranch;

    if (this._nSenseP !== 0) {
      solver.stamp(this._nSenseP - 1, ks, 1);
      solver.stamp(ks, this._nSenseP - 1, 1);
    }
    if (this._nSenseN !== 0) {
      solver.stamp(this._nSenseN - 1, ks, -1);
      solver.stamp(ks, this._nSenseN - 1, -1);
    }
  }

  protected override _bindContext(voltages: Float64Array): void {
    const iSense = voltages[this._senseBranch];
    this._ctx.setBranchCurrentByIndex("sense", this._senseBranch, voltages);
    this._ctrlValue = iSense;
  }

  /**
   * Stamp NR-linearized Norton equivalent for the controlled current output.
   *
   * I_out ≈ f'(I0) * I_sense + [f(I0) - f'*I0]
   *
   * The I_sense term is a branch variable (column senseBranch in the MNA matrix).
   * Norton constant: iNR = f(I0) - f'(I0) * I0
   *
   * G sub-matrix: link sense branch COLUMN to output node ROWS.
   * For current injected INTO nOutP from the sense branch variable:
   *   G[nOutP, senseBranch] -= f'   (negative: contributes -f'*I_sense to KCL row)
   *   G[nOutN, senseBranch] += f'
   *
   * RHS (Norton constant term):
   *   RHS[nOutP] += iNR
   *   RHS[nOutN] -= iNR
   */
  override stampOutput(
    solver: SparseSolver,
    value: number,
    derivative: number,
    ctrlValue: number,
  ): void {
    const ks = this._senseBranch;
    const iNR = value - derivative * ctrlValue;

    // G sub-matrix: sense branch variable → output node rows
    if (this._nOutP !== 0) {
      solver.stamp(this._nOutP - 1, ks, -derivative);
    }
    if (this._nOutN !== 0) {
      solver.stamp(this._nOutN - 1, ks, derivative);
    }

    // RHS: Norton constant term
    if (this._nOutP !== 0) {
      solver.stampRHS(this._nOutP - 1, iNR);
    }
    if (this._nOutN !== 0) {
      solver.stampRHS(this._nOutN - 1, -iNR);
    }
  }
}

// ---------------------------------------------------------------------------
// CCCSElement — CircuitElement
// ---------------------------------------------------------------------------

export class CCCSElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("CCCS", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildCCCSPinDeclarations(), []);
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

    // Sense port label
    ctx.setFont({ family: "sans-serif", size: 0.5 });
    ctx.drawText("I-ctrl", 0.5, 0, { horizontal: "center", vertical: "center" });

    if (label.length > 0) {
      ctx.setFont({ family: "sans-serif", size: 0.8 });
      ctx.drawText(label, 2, -2.3, { horizontal: "center", vertical: "bottom" });
    }

    ctx.restore();
  }

  getHelpText(): string {
    return (
      "Current-Controlled Current Source — 4-terminal element. " +
      "Output current = expression(I_sense). " +
      "Pins: sense+, sense- (current sense port), out+, out- (output)."
    );
  }
}

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const CCCS_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "expression",
    type: PropertyType.STRING,
    label: "Transfer function",
    defaultValue: "I(sense)",
    description: "Expression defining output current as function of I(sense). Default: I(sense).",
  },
  {
    key: "currentGain",
    type: PropertyType.FLOAT,
    label: "Current gain (β)",
    defaultValue: 1.0,
    description: "Linear current gain. Used when expression is the default 'I(sense)'. Default: 1.0.",
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

const CCCS_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  { xmlName: "expression",  propertyKey: "expression",  convert: (v) => v },
  { xmlName: "currentGain", propertyKey: "currentGain", convert: (v) => parseFloat(v) },
  { xmlName: "Label",       propertyKey: "label",       convert: (v) => v },
];

// ---------------------------------------------------------------------------
// CCCSDefinition
// ---------------------------------------------------------------------------

export const CCCSDefinition: ComponentDefinition = {
  name: "CCCS",
  typeId: -1,
  engineType: "analog",
  category: ComponentCategory.ACTIVE,
  executeFn: noOpAnalogExecuteFn,

  pinLayout: buildCCCSPinDeclarations(),
  propertyDefs: CCCS_PROPERTY_DEFS,
  attributeMap: CCCS_ATTRIBUTE_MAPPINGS,

  helpText:
    "Current-Controlled Current Source — output current is an expression of " +
    "the current through the sense port.",

  requiresBranchRow: true,

  factory(props: PropertyBag): CCCSElement {
    return new CCCSElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
  },

  analogFactory(
    nodeIds: number[],
    branchIdx: number,
    props: PropertyBag,
  ): AnalogElement {
    const expression = props.getOrDefault<string>("expression", "I(sense)");
    const currentGain = props.getOrDefault<number>("currentGain", 1.0);
    return new CCCSAnalogElement(
      nodeIds[0], // sense+
      nodeIds[1], // sense-
      nodeIds[2], // out+
      nodeIds[3], // out-
      branchIdx,
      expression,
      currentGain,
    );
  },
};
