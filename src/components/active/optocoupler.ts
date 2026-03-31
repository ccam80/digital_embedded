/**
 * Optocoupler (opto-isolator) analog component.
 *
 * Compound component: LED on the input side and a phototransistor on the
 * output side, with galvanic isolation (no electrical connection between
 * input and output sides).
 *
 * Transfer function:
 *   I_C = CTR * I_LED
 *
 * where I_LED is the current through the input LED, modelled with a
 * forward-voltage + series-resistance characteristic:
 *   I_LED = (V_anode - V_cathode - V_forward) / R_LED   when forward biased
 *   I_LED = 0                                            otherwise
 *
 * The phototransistor is modelled as a current-controlled current source
 * (CCCS) on the output side: I_C = CTR * I_LED, stamped as a Norton current
 * source between collector and emitter.
 *
 * Galvanic isolation is maintained by having NO shared MNA nodes between the
 * input (anode/cathode) and output (collector/emitter) ports.
 *
 * MNA formulation:
 *
 * Input LED (nonlinear diode with series resistance R_LED):
 *   The LED is modelled as a piecewise-linear element:
 *     - Off (V_d < V_F): conductance G_off = 1/R_off (leakage)
 *     - On (V_d >= V_F): conductance G_on = 1/R_LED, with voltage offset V_F
 *       Norton equivalent: I_eq = (V_d - V_F) / R_LED = G_on * V_d - G_on * V_F
 *
 *   At operating point V_d0:
 *     if V_d0 < V_F:
 *       G_LED = G_off (tiny leakage conductance for numerical stability)
 *       I_NR  = 0
 *     else:
 *       G_LED = G_on = 1/R_LED
 *       I_NR  = G_on * V_F  (Norton offset to shift the characteristic by V_F)
 *
 *   MNA stamps for input LED (anode=nA, cathode=nK):
 *     G[nA,nA] += G_LED    G[nA,nK] -= G_LED
 *     G[nK,nA] -= G_LED    G[nK,nK] += G_LED
 *     RHS[nA]  -= I_NR     RHS[nK]  += I_NR
 *
 * Output phototransistor (CCCS: I_C = CTR * I_LED):
 *   I_LED at operating point: I_LED0 = G_LED * V_d0 - I_NR
 *   I_C0 = CTR * I_LED0
 *
 *   The CCCS is approximated as a Norton current source at each NR iteration.
 *   Since I_C depends on V_d (= V_anode - V_cathode) via I_LED, we propagate
 *   the Jacobian from input to output:
 *     dI_C / dV_d = CTR * G_LED
 *
 *   Norton-linearized stamp for output (collector=nC, emitter=nE):
 *     G[nC,nA] -= CTR * G_LED    G[nC,nK] += CTR * G_LED
 *     G[nE,nA] += CTR * G_LED    G[nE,nK] -= CTR * G_LED
 *     RHS[nC]  += I_C0 - (CTR * G_LED) * V_d0
 *     RHS[nE]  -= I_C0 - (CTR * G_LED) * V_d0
 *
 * Note: the cross-port Jacobian entries (G[nC,nA] etc.) intentionally couple
 * the input and output ROWS of the MNA system via the off-diagonal sub-matrix.
 * This does NOT violate galvanic isolation because:
 *   1. The input nodes (nA, nK) are NOT in the same KCL mesh as output nodes.
 *   2. The cross-entries only appear in the output KCL rows (nC, nE), where
 *      they represent the controlled-source dependence on input voltage.
 *   3. No current physically flows between input and output nodes.
 *   4. Galvanic isolation means no shared physical node — the MNA off-diagonal
 *      coupling is purely algebraic (the dependent source relationship).
 *
 * Pins (nodeIds order):
 *   [0] = nAnode    (LED anode, input+)
 *   [1] = nCathode  (LED cathode, input-)
 *   [2] = nCollector (phototransistor collector, output+)
 *   [3] = nEmitter   (phototransistor emitter, output-)
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
import type { AnalogElementCore } from "../../solver/analog/element.js";
import type { SparseSolver } from "../../solver/analog/sparse-solver.js";
import { defineModelParams } from "../../core/model-params.js";

// ---------------------------------------------------------------------------
// Model parameter declarations
// ---------------------------------------------------------------------------

export const { paramDefs: OPTOCOUPLER_PARAM_DEFS, defaults: OPTOCOUPLER_DEFAULTS } = defineModelParams({
  primary: {
    ctr:      { default: 1.0,  description: "Current transfer ratio CTR = I_collector / I_LED" },
    vForward: { default: 1.2,  unit: "V", description: "LED forward voltage" },
    rLed:     { default: 10,   unit: "Ω", description: "LED series resistance" },
  },
});

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

function buildOptocouplerPinDeclarations(): PinDeclaration[] {
  return [
    {
      direction: PinDirection.INPUT,
      label: "anode",
      defaultBitWidth: 1,
      position: { x: 0, y: -1 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.INPUT,
      label: "cathode",
      defaultBitWidth: 1,
      position: { x: 0, y: 1 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.OUTPUT,
      label: "collector",
      defaultBitWidth: 1,
      position: { x: 4, y: -1 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.OUTPUT,
      label: "emitter",
      defaultBitWidth: 1,
      position: { x: 4, y: 1 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
  ];
}

// ---------------------------------------------------------------------------
// OptocouplerAnalogElement factory
// ---------------------------------------------------------------------------

/** Minimum leakage conductance for numerical stability in off-state. */
const G_OFF = 1e-9;

function createOptocouplerElement(
  pinNodes: ReadonlyMap<string, number>,
  _internalNodeIds: readonly number[],
  _branchIdx: number,
  props: PropertyBag,
): AnalogElementCore {
  const p: Record<string, number> = {
    ctr:      props.getModelParam<number>("ctr"),
    vForward: props.getModelParam<number>("vForward"),
    rLed:     props.getModelParam<number>("rLed"),
  };

  const nAnode     = pinNodes.get("anode")!;
  const nCathode   = pinNodes.get("cathode")!;
  const nCollector = pinNodes.get("collector")!;
  const nEmitter   = pinNodes.get("emitter")!;

  // Operating-point state
  let vd = 0;       // V_anode - V_cathode at last updateOperatingPoint
  let gLed = G_OFF; // effective LED conductance
  let iNR = 0;      // Norton offset for LED stamp

  function readNode(voltages: Float64Array, n: number): number {
    return n > 0 ? voltages[n - 1] : 0;
  }

  return {
    branchIndex: -1,
    isNonlinear: true,
    isReactive: false,

    stamp(_solver: SparseSolver): void {
      // No linear topology-constant contributions.
    },

    stampNonlinear(solver: SparseSolver): void {
      // --- Input LED stamp ---
      // Conductance stamp between anode and cathode
      if (nAnode !== 0) {
        solver.stamp(nAnode - 1, nAnode - 1, gLed);
        if (nCathode !== 0) {
          solver.stamp(nAnode - 1, nCathode - 1, -gLed);
        }
      }
      if (nCathode !== 0) {
        if (nAnode !== 0) {
          solver.stamp(nCathode - 1, nAnode - 1, -gLed);
        }
        solver.stamp(nCathode - 1, nCathode - 1, gLed);
      }
      // Norton offset (shifts characteristic by V_forward)
      if (nAnode !== 0) solver.stampRHS(nAnode - 1, -iNR);
      if (nCathode !== 0) solver.stampRHS(nCathode - 1, iNR);

      // --- Output phototransistor stamp ---
      // I_C = CTR * I_LED; I_LED = gLed * V_d - iNR
      const iLed0 = gLed * vd - iNR;
      const iC0 = p.ctr * iLed0;
      const gmCtr = p.ctr * gLed; // dI_C/dV_d

      // NR constant term for output Norton source
      const iCnr = iC0 - gmCtr * vd;

      // Cross-port Jacobian: controlled source dependence on input voltage
      // G[nC, nA] -= gmCtr   G[nC, nK] += gmCtr
      // G[nE, nA] += gmCtr   G[nE, nK] -= gmCtr
      if (nCollector !== 0 && nAnode !== 0) solver.stamp(nCollector - 1, nAnode - 1, -gmCtr);
      if (nCollector !== 0 && nCathode !== 0) solver.stamp(nCollector - 1, nCathode - 1, gmCtr);
      if (nEmitter !== 0 && nAnode !== 0) solver.stamp(nEmitter - 1, nAnode - 1, gmCtr);
      if (nEmitter !== 0 && nCathode !== 0) solver.stamp(nEmitter - 1, nCathode - 1, -gmCtr);

      // RHS: Norton constant
      if (nCollector !== 0) solver.stampRHS(nCollector - 1, iCnr);
      if (nEmitter !== 0) solver.stampRHS(nEmitter - 1, -iCnr);
    },

    updateOperatingPoint(voltages: Float64Array): void {
      const vA = readNode(voltages, nAnode);
      const vK = readNode(voltages, nCathode);
      vd = vA - vK;

      const gOn = 1 / p.rLed;
      if (vd >= p.vForward) {
        gLed = gOn;
        iNR = gOn * p.vForward;
      } else {
        gLed = G_OFF;
        iNR = 0;
      }
    },

    getPinCurrents(voltages: Float64Array): number[] {
      // Pin order: [anode, cathode, collector, emitter]
      // LED current (into anode): I_LED = gLed * (V_A - V_K) - iNR
      const vA = readNode(voltages, nAnode);
      const vK = readNode(voltages, nCathode);
      const iLed = gLed * (vA - vK) - iNR;
      // Phototransistor: I_C = CTR * I_LED
      // Norton source pushes iC0 out of collector → current INTO collector is -iC0
      // Norton source pulls iC0 into emitter → current INTO emitter is +iC0
      const iC = p.ctr * iLed;
      return [iLed, -iLed, -iC, iC];
    },

    setParam(key: string, value: number): void {
      if (key in p) p[key] = value;
    },
  };
}

// ---------------------------------------------------------------------------
// OptocouplerElement — CircuitElement
// ---------------------------------------------------------------------------

export class OptocouplerElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("Optocoupler", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildOptocouplerPinDeclarations(), []);
  }

  getBoundingBox(): Rect {
    return {
      x: this.position.x,
      y: this.position.y - 2,
      width: 4,
      height: 4,
    };
  }

  draw(ctx: RenderContext, signals?: PinVoltageAccess): void {
    const PX = 1 / 16;

    const vAnode     = signals?.getPinVoltage("anode");
    const vCathode   = signals?.getPinVoltage("cathode");
    const vCollector = signals?.getPinVoltage("collector");
    const vEmitter   = signals?.getPinVoltage("emitter");

    ctx.save();
    ctx.setLineWidth(1);

    // Body: rectangle, isolation barrier, LED triangle/bar, light arrows, transistor body — all COMPONENT
    ctx.setColor("COMPONENT");
    ctx.drawRect(0, -2, 4, 4, false);
    ctx.drawLine(2, -2, 2, 2);

    const ledHs = 8 * PX; // 0.5
    const triTop  = { x: 0.5, y: -ledHs };
    const triBtm  = { x: 0.5, y: ledHs };
    const triTip  = { x: 1.5, y: 0 };
    ctx.drawPolygon([triTop, triBtm, triTip], false);  // LED triangle
    ctx.drawLine(triTip.x - ledHs, triTip.y + ledHs,
                 triTip.x + ledHs, triTip.y - ledHs); // cathode bar

    // Two light arrows
    for (let i = 0; i < 2; i++) {
      const ay = -0.2 + i * 0.4;
      const aBase = { x: 1.7, y: ay };
      const aTip = { x: 2.1, y: ay - 0.3 };
      const dx = aTip.x - aBase.x;
      const dy = aTip.y - aBase.y;
      const len = Math.sqrt(dx * dx + dy * dy);
      const al = 5 * PX;
      const aw = 3 * PX;
      const f = 1 - al / len;
      const cx = aBase.x * (1 - f) + aTip.x * f;
      const cy = aBase.y * (1 - f) + aTip.y * f;
      const gx = (dy / len) * aw;
      const gy = (-dx / len) * aw;
      ctx.drawPolygon(
        [{ x: aTip.x, y: aTip.y }, { x: cx + gx, y: cy + gy }, { x: cx - gx, y: cy - gy }],
        true,
      );
      ctx.drawLine(aBase.x, aBase.y, aTip.x - 5 * PX * 0.7, aTip.y + 5 * PX * 0.7);
    }

    // NPN phototransistor body: circle, base bar, base lead — all COMPONENT
    ctx.drawCircle(3, 0, 0.7, false);
    ctx.drawLine(2.75, -0.5, 2.75, 0.5);  // base bar
    ctx.drawLine(2, 0, 2.75, 0);           // base lead (internal, no external pin)

    // Emitter arrow (body decoration, stays COMPONENT)
    const emDx = 4 - 2.75;
    const emDy = 1 - 0.5;
    const emLen = Math.sqrt(emDx * emDx + emDy * emDy);
    const emAl = 8 * PX;
    const emAw = 3 * PX;
    const emF = 1 - emAl / emLen;
    const emCx = 2.75 * (1 - emF) + 4 * emF;
    const emCy = 0.5 * (1 - emF) + 1 * emF;
    const emGx = (emDy / emLen) * emAw;
    const emGy = (-emDx / emLen) * emAw;
    ctx.drawPolygon(
      [{ x: 4, y: 1 }, { x: emCx + emGx, y: emCy + emGy }, { x: emCx - emGx, y: emCy - emGy }],
      true,
    );

    // anode lead
    drawColoredLead(ctx, signals, vAnode, 0, -1, triTop.x, triTop.y);

    // cathode lead
    drawColoredLead(ctx, signals, vCathode, 0, 1, triBtm.x, triBtm.y);

    // collector lead
    drawColoredLead(ctx, signals, vCollector, 2.75, -0.5, 4, -1);

    // emitter lead
    drawColoredLead(ctx, signals, vEmitter, 2.75, 0.5, 4, 1);

    // Pin labels outside body near pin tips
    ctx.setColor("TEXT");
    ctx.setFont({ family: "sans-serif", size: 0.5 });
    ctx.drawText("A", 0.15, -1.4, { horizontal: "left", vertical: "bottom" });
    ctx.drawText("K", 0.15, 1.4, { horizontal: "left", vertical: "top" });
    ctx.drawText("C", 3.85, -1.4, { horizontal: "right", vertical: "bottom" });
    ctx.drawText("E", 3.85, 1.4, { horizontal: "right", vertical: "top" });

    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const OPTOCOUPLER_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "ctr",
    type: PropertyType.FLOAT,
    label: "Current Transfer Ratio",
    defaultValue: 1.0,
    min: 0,
    description: "Current transfer ratio CTR = I_collector / I_LED. Default: 1.0 (100%).",
  },
  {
    key: "vForward",
    type: PropertyType.FLOAT,
    label: "LED forward voltage (V)",
    defaultValue: 1.2,
    min: 0,
    description: "LED forward voltage in volts. Default: 1.2 V.",
  },
  {
    key: "rLed",
    type: PropertyType.FLOAT,
    label: "LED series resistance (Ω)",
    defaultValue: 10,
    min: 1e-9,
    description: "LED series resistance in ohms. Default: 10 Ω.",
  },
  {
    key: "vceSat",
    type: PropertyType.FLOAT,
    label: "V_CE saturation (V)",
    defaultValue: 0.3,
    min: 0,
    description: "Phototransistor saturation voltage V_CE in volts. Default: 0.3 V.",
  },
  {
    key: "bandwidth",
    type: PropertyType.FLOAT,
    label: "Bandwidth (Hz)",
    defaultValue: 50000,
    min: 1,
    description: "Optocoupler bandwidth in Hz. Default: 50 kHz.",
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

const OPTOCOUPLER_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  { xmlName: "ctr",       propertyKey: "ctr",       convert: (v) => parseFloat(v) },
  { xmlName: "vForward",  propertyKey: "vForward",  convert: (v) => parseFloat(v) },
  { xmlName: "rLed",      propertyKey: "rLed",      convert: (v) => parseFloat(v) },
  { xmlName: "vceSat",    propertyKey: "vceSat",    convert: (v) => parseFloat(v) },
  { xmlName: "bandwidth", propertyKey: "bandwidth", convert: (v) => parseFloat(v) },
  { xmlName: "Label",     propertyKey: "label",     convert: (v) => v },
];

// ---------------------------------------------------------------------------
// OptocouplerDefinition
// ---------------------------------------------------------------------------

export const OptocouplerDefinition: ComponentDefinition = {
  name: "Optocoupler",
  typeId: -1,
  category: ComponentCategory.ACTIVE,

  pinLayout: buildOptocouplerPinDeclarations(),
  propertyDefs: OPTOCOUPLER_PROPERTY_DEFS,
  attributeMap: OPTOCOUPLER_ATTRIBUTE_MAPPINGS,

  helpText:
    "Optocoupler — 4-terminal element (anode, cathode, collector, emitter). " +
    "I_collector = CTR * I_LED. Galvanic isolation between LED input and phototransistor output.",

  factory(props: PropertyBag): OptocouplerElement {
    return new OptocouplerElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
  },

  models: {},
  modelRegistry: {
    "behavioral": {
      kind: "inline",
      factory: (pinNodes, internalNodeIds, branchIdx, props) =>
        createOptocouplerElement(pinNodes, internalNodeIds, branchIdx, props),
      paramDefs: OPTOCOUPLER_PARAM_DEFS,
      params: OPTOCOUPLER_DEFAULTS,
    },
  },
  defaultModel: "behavioral",
};
