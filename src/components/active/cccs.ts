/**
 * Current-Controlled Current Source (CCCS) analog component.
 *
 * Four-terminal element: sense+ and sense- form the current sense port;
 * out+ and out- are the output current source terminals.
 *
 * The output current equals an expression of the sensed current:
 *   I_out = f(I_sense)  where  I_sense flows into sense+
 *
 * The linear F-element path: when `expression` is the default ("I(sense)"),
 * the stamped coefficient is the M-folded gain `_effectiveCoeff()` =
 * `CCCSmGiven ? gain * CCCSmValue : gain` (cccspar.c:25-28), so the output
 * current is `_effectiveCoeff() * I(sense)` — matching ngspice's scalar
 * CCCScoeff stamp (cccsload.c:35-36).
 *
 * Per the SPICE F-element convention (ngspice user manual, cccsload.c:35-36):
 * current flows FROM out+, through the source, TO out-. Positive
 * `currentGain` therefore PULLS current out of out+ and pushes it into out-.
 *
 * MNA formulation (port of ngspice cccsset.c / cccsload.c):
 *   CCCS has no own branch row. Current sensing relies on a 0V VSRC
 *   (the sense source) whose branch is resolved via ctx.findBranch at
 *   setup time. Two matrix handles are allocated (cccsset.c:49-50):
 *     _hPCtBr = G[posNode, contBranch]
 *     _hNCtBr = G[negNode, contBranch]
 *
 *   load() reads the controlling branch current from rhsOld and stamps
 *   the NR-linearized Norton equivalent (cccsload.c:35-36):
 *     G[posNode, contBranch] += gm
 *     G[negNode, contBranch] -= gm
 *     RHS[posNode] -= iNR
 *     RHS[negNode] += iNR
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
  type StandaloneComponentDefinition,
} from "../../core/registry.js";
import { parseExpression } from "../../solver/analog/expression.js";
import { differentiate, simplify } from "../../solver/analog/expression-differentiate.js";
import { ControlledSourceElement } from "../../solver/analog/controlled-source-base.js";
import { NGSPICE_LOAD_ORDER, type DeviceFamily } from "../../solver/analog/ngspice-load-order.js";
import type { SetupContext } from "../../solver/analog/setup-context.js";
import type { SparseSolver } from "../../solver/analog/sparse-solver.js";
import type { LoadContext } from "../../solver/analog/load-context.js";
import { defineModelParams } from "../../core/model-params.js";

// ---------------------------------------------------------------------------
// Model parameter declarations
// ---------------------------------------------------------------------------

export const { paramDefs: CCCS_PARAM_DEFS, defaults: CCCS_DEFAULTS } = defineModelParams({
  primary: {
    currentGain: { default: 1.0, description: "Linear current gain β" },
    // cccs.c:15 IOP("m", CCCS_M, IF_REAL, "Parallel multiplier") — parallel
    // multiplier folded into the gain coefficient when given (cccspar.c:26-27).
    M: { default: 1, description: "Parallel multiplier" },
  },
});

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

function buildCCCSPinDeclarations(): PinDeclaration[] {
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
// CCCSAnalogElement
// ---------------------------------------------------------------------------

/**
 * MNA analog element for a Current-Controlled Current Source.
 *
 * sense+ and sense- form the current sense port; out+ and out- are the output
 * current source terminals. No own branch row- controlling branch resolved
 * at setup() time.
 */
export class CCCSAnalogElement extends ControlledSourceElement {
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.CCCS;
  readonly deviceFamily: DeviceFamily = "CCCS";

  // senseSourceLabel- the label of the controlling VSRC/CCVS/VCVS/IND.
  // Must be set via setParam("senseSourceLabel", label) before setup() runs.
  private _senseSourceLabel: string = "";

  // cccsdefs.h:33 CCCScoeff — the bare gain coefficient (CCCScoeff pre-fold,
  // cccspar.c:25). _effectiveCoeff() folds in _mValue when _mGiven.
  private _gain: number = 1;
  // cccsdefs.h:35 CCCSmValue — the parallel multiplier (cccspar.c:34).
  private _mValue: number = 1;
  // cccsdefs.h:42 CCCSmGiven — multiplier-given flag; gates the
  // CCCScoeff *= CCCSmValue fold (cccspar.c:26).
  private _mGiven: boolean = false;
  // cccsdefs.h:41 CCCScoeffGiven — gain-given flag (cccspar.c:28). Tracks
  // whether the gain coefficient was netlisted, mirroring CCCScoeffGiven.
  private _gainGiven: boolean = false;
  // True for the default linear F-element path ("I(sense)"): the stamped
  // coefficient is the bare scalar _effectiveCoeff(), matching cccsload.c:35-36.
  // False for the digiTS-only non-default expression extension.
  private _linearDefault: boolean = true;

  // Resolved controlling branch index (filled in setup()).
  private _contBranch: number = -1;

  // TSTALLOC handles- allocated in setup(), written in load()
  // cccsset.c:49-50 line-for-line
  private _hPCtBr: number = -1; // G[posNode, contBranch]  :49
  private _hNCtBr: number = -1; // G[negNode, contBranch]  :50

  setup(ctx: SetupContext): void {
    const solver = ctx.solver;
    const posNode = this.pinNodes.get("out+")!;  // CCCSposNode  (pinNodeIds[2])
    const negNode = this.pinNodes.get("out-")!;  // CCCSnegNode  (pinNodeIds[3])

    // Resolve controlling branch: cccsset.c:36
    // ctx.findBranch dispatches to the controlling source's findBranchFor
    // callback (lazy-allocating per 00-engine.md ssA2/A4.2).
    if (!this._senseSourceLabel) {
      throw new Error(`CCCS '${this.label}': senseSourceLabel not set before setup()`);
    }
    const contBranch = ctx.findBranch(this._senseSourceLabel);
    if (contBranch === 0) {
      throw new Error(
        `CCCS '${this.label}': unknown controlling source '${this._senseSourceLabel}'`,
      );
    }
    this._contBranch = contBranch;

    // TSTALLOC sequence: cccsset.c:49-50, line-for-line
    this._hPCtBr = solver.allocElement(posNode, contBranch); // :49
    this._hNCtBr = solver.allocElement(negNode, contBranch); // :50
  }

  setParam(key: string, value: number | string): void {
    if (key === "senseSourceLabel" && typeof value === "string") {
      this._senseSourceLabel = value;
    } else if (key === "currentGain" && typeof value === "number") {
      // cccspar.c:25,28 — store the bare gain coefficient and mark it given.
      this._gain = value;
      this._gainGiven = true;
    } else if (key === "M" && typeof value === "number") {
      // cccspar.c:34-35 — store the parallel multiplier and mark it given.
      this._mValue = value;
      this._mGiven = true;
    }
  }

  /**
   * The stamped gain coefficient. cccspar.c:25-28: CCCScoeff = gain; if
   * (CCCSmGiven) CCCScoeff *= CCCSmValue. The bare gain is scaled by the
   * parallel multiplier only when m was given, so a CCCS with no m= stamps
   * exactly the bare gain — bit-identical to ngspice's CCCSmGiven=FALSE skip.
   */
  private _effectiveCoeff(): number {
    return this._mGiven ? this._gain * this._mValue : this._gain;
  }

  /**
   * The scalar factor the digiTS-only non-default expression is multiplied by.
   * cccspar.c:26 gate: the parallel multiplier folds in only when m was given,
   * so an un-netlisted m is a true no-op on the extension (not a ×1).
   */
  private _exprMultiplier(): number {
    return this._mGiven ? this._mValue : 1;
  }

  /** Select the linear F-element path vs the digiTS-only expression extension. */
  setLinearDefault(isLinear: boolean): void {
    this._linearDefault = isLinear;
  }

  protected override _stampLinear(_solver: SparseSolver): void {
    // CCCS has no linear (topology-constant) stamps of its own.
    // The sense 0V source is a separate VSRC element in the netlist.
  }

  protected override _bindContext(rhsOld: Float64Array): void {
    const iSense = rhsOld[this._contBranch];
    this._ctx.setBranchCurrentByIndex("sense", this._contBranch, rhsOld);
    this._ctrlValue = iSense;
  }

  /**
   * Stamp NR-linearized Norton equivalent for the controlled current output.
   * Port of cccsload.c:35-36 value-side- no allocElement calls.
   *
   * I_out â‰ˆ f'(I0) * I_sense + [f(I0) - f'(I0)*I0]
   *
   * SPICE F-element convention: current flows FROM posNode TO negNode, so
   *   G[posNode, contBranch] += gm
   *   G[negNode, contBranch] -= gm
   *   RHS[posNode] -= iNR
   *   RHS[negNode] += iNR
   */
  override stampOutput(
    solver: SparseSolver,
    rhs: Float64Array,
    value: number,
    derivative: number,
    ctrlValue: number,
  ): void {
    const gm  = derivative;
    const iNR = value - derivative * ctrlValue;

    solver.stampElement(this._hPCtBr,  gm); // G[posNode, contBranch]   cccsload.c:35
    solver.stampElement(this._hNCtBr, -gm); // G[negNode, contBranch]   cccsload.c:36

    const posNode = this.pinNodes.get("out+")!;
    const negNode = this.pinNodes.get("out-")!;
    // Unconditional - ground rows land in rhs[0], cleared post-solve.
    rhs[posNode] -= iNR;
    rhs[negNode] += iNR;
  }

  /**
   * Per-pin currents in pinLayout order: [sense+, sense-, out+, out-].
   *
   * The sense port is wired through an external VSRC whose branch variable
   * holds the sensed current. CCCS itself injects the controlled current at
   * the output port. Positive = current flowing INTO the pin.
   */
  getPinCurrents(rhs: Float64Array): number[] {
    const iSense = this._contBranch >= 0 ? rhs[this._contBranch] : 0;
    // cccsload.c:35-36 — the stamped coefficient is the M-folded CCCScoeff for
    // the linear F-element path; the non-default extension scales by the gated
    // multiplier only. The base expression _compiledExpr is unscaled.
    const factor = this._linearDefault ? this._effectiveCoeff() : this._exprMultiplier();
    const fI = factor * this._compiledExpr(this._ctx);
    return [
      iSense,   // sense+: I_sense flows in (through the external sense VSRC)
      -iSense,  // sense-: I_sense flows out
      -fI,      // out+: current is sourced into the net (element gives it out)
      fI,       // out-: current is sunk back into element
    ];
  }

  /**
   * Override load() to use cached handles instead of allocating in load().
   * Calls _bindContext, evaluates expression, then calls stampOutput with
   * the cached handle-based stamps.
   */
  override load(ctx: LoadContext): void {
    this._bindContext(ctx.rhsOld);
    this._stampLinear(ctx.solver);
    // The base expression is unscaled. cccspar.c:25-28: the stamped coefficient
    // is the bare gain folded with the parallel multiplier when m was given.
    // Reading _effectiveCoeff() here (rather than baking a constant at
    // construction) keeps currentGain and M hot-loadable via setParam: the next
    // load() re-reads the live _gain / _mValue, so the stamp tracks the change.
    // For the default linear path f = I(sense), so value = coeff·Isense,
    // deriv = coeff, gm = coeff, iNR = 0 — the ±CCCScoeff stamp of cccsload.c:35-36.
    const factor = this._linearDefault ? this._effectiveCoeff() : this._exprMultiplier();
    const value = factor * this._compiledExpr(this._ctx);
    const deriv = factor * this._compiledDeriv(this._ctx);
    this.stampOutput(ctx.solver, ctx.rhs, value, deriv, this._ctrlValue);
  }
}

// ---------------------------------------------------------------------------
// CCCSElement- CircuitElement
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

    // Body- polyline box (1,-1)â†’(5,-1)â†’(5,3)â†’(1,3)â†’(1,-1)
    ctx.setColor("COMPONENT");
    ctx.drawLine(1, -1, 5, -1);
    ctx.drawLine(5, -1, 5, 3);
    ctx.drawLine(5, 3, 1, 3);
    ctx.drawLine(1, 3, 1, -1);

    // sense+ lead
    drawColoredLead(ctx, signals, vSenseP, 0, 0, 1, 0);

    // sense- lead
    drawColoredLead(ctx, signals, vSenseN, 0, 2, 1, 2);

    // out+ lead
    drawColoredLead(ctx, signals, vOutP, 6, 0, 5, 0);

    // out- lead
    drawColoredLead(ctx, signals, vOutN, 6, 2, 5, 2);

    // Pin labels inside body
    ctx.setColor("TEXT");
    ctx.setFont({ family: "sans-serif", size: 0.6 });
    ctx.drawText("sense+", 1.2, 0, { horizontal: "left", vertical: "middle" });
    ctx.drawText("senseâˆ’", 1.2, 2, { horizontal: "left", vertical: "middle" });
    ctx.drawText("out+",   4.8, 0, { horizontal: "right", vertical: "middle" });
    ctx.drawText("outâˆ’",   4.8, 2, { horizontal: "right", vertical: "middle" });

    ctx.restore();
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
    key: "senseSourceLabel",
    type: PropertyType.STRING,
    label: "Sense source label",
    defaultValue: "",
    description:
      "Label of the controlling VSRC/CCVS/VCVS/IND whose branch current is sensed. " +
      "Required- setup() throws if empty.",
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
  { xmlName: "expression",       propertyKey: "expression",       convert: (v) => v },
  { xmlName: "currentGain",      propertyKey: "currentGain",      convert: (v) => parseFloat(v), modelParam: true },
  { xmlName: "m",                propertyKey: "M",                convert: (v) => parseFloat(v), modelParam: true },
  { xmlName: "senseSourceLabel", propertyKey: "senseSourceLabel", convert: (v) => v },
  { xmlName: "Label",            propertyKey: "label",            convert: (v) => v },
];

// ---------------------------------------------------------------------------
// CCCSDefinition
// ---------------------------------------------------------------------------

export const CCCSDefinition: StandaloneComponentDefinition = {
  name: "CCCS",
  typeId: -1,
  category: ComponentCategory.ACTIVE,

  pinLayout: buildCCCSPinDeclarations(),
  propertyDefs: CCCS_PROPERTY_DEFS,
  attributeMap: CCCS_ATTRIBUTE_MAPPINGS,

  helpText:
    "Current-Controlled Current Source- output current is an expression of " +
    "the current through the sense port.",

  factory(props: PropertyBag): CCCSElement {
    return new CCCSElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
  },

  models: {},
  modelRegistry: {
    "behavioral": {
      kind: "inline",
      factory: (pinNodes, props, _getTime) => {
        const expression = props.getOrDefault<string>("expression", "I(sense)");
        const isLinearDefault = expression === "I(sense)";
        // The base expression is the unscaled transfer function: I(sense) for
        // the linear F-element path (cccsload.c:35-36 stamps the scalar
        // coefficient against it), or the raw user expression for the
        // digiTS-only extension. The M-fold / gain coefficient is applied at
        // load() from _effectiveCoeff(), keeping currentGain and M hot-loadable.
        const baseExpr = parseExpression(isLinearDefault ? "I(sense)" : expression);
        const deriv = simplify(differentiate(baseExpr, "I(sense)"));
        const el = new CCCSAnalogElement(pinNodes, baseExpr, deriv, "I(sense)", "current");
        el.setLinearDefault(isLinearDefault);
        // cccspar.c:24-36 — drive the gain and parallel multiplier through the
        // public setParam path so the *Given flags mirror ngspice's
        // CCCScoeffGiven / CCCSmGiven (props.isModelParamGiven == ngspice
        // *Given). When a param is not netlisted, the field default holds the
        // ngspice default (CCCScoeff=1 / CCCSmValue=1, CCCSmGiven=FALSE), so the
        // fold is skipped exactly as ngspice skips it.
        if (props.isModelParamGiven("currentGain")) {
          el.setParam("currentGain", props.getModelParam<number>("currentGain"));
        }
        if (props.isModelParamGiven("M")) {
          el.setParam("M", props.getModelParam<number>("M"));
        }
        // Wire the sense-source link via the public setParam path so the
        // build-spec entry point can drive CCCS without reaching past the
        // factory boundary. Empty string = unset; setup() will throw with
        // the canonical error.
        const senseLabel = props.getOrDefault<string>("senseSourceLabel", "");
        el.setParam("senseSourceLabel", senseLabel);
        return el;
      },
      paramDefs: CCCS_PARAM_DEFS,
      params: CCCS_DEFAULTS,
    },
  },
  defaultModel: "behavioral",
};
