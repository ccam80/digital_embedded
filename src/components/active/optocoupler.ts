/**
 * Optocoupler (opto-isolator) analog component — F4b composition.
 *
 * Composed from ngspice primitives per spec §F4b:
 *   - LED (input side): diode.ts → dioload.c (LED junction)
 *   - CCCS coupling: CTR * I_LED drives the phototransistor base
 *   - Phototransistor (output side): bjt.ts → bjtload.c (NPN BJT)
 *
 * Composition architecture (sub-element delegation):
 *   optocoupler.load() calls:
 *     1. ledSub.load(ctx)           — LED diode stamp on anode/cathode; dioload.c:120-441
 *     2. CCCS stamp                 — injects CTR*I_LED as Norton source into internalBase
 *     3. bjtSub.load(ctx)           — BJT stamp on (internalBase, collector, emitter); bjtload.c:170-end
 *
 * Galvanic isolation:
 *   No shared MNA nodes between input (anode/cathode) and output (collector/emitter).
 *   The CCCS coupling is purely algebraic — off-diagonal Jacobian entries only in
 *   output rows, representing the controlled-source dependence on input voltage.
 *
 * Internal node:
 *   [internalNodeIds[0]] = phototransistor base (no external pin)
 *
 * Pins (nodeIds order):
 *   [0] = nAnode     (LED anode, input+)
 *   [1] = nCathode   (LED cathode, input-)
 *   [2] = nCollector (phototransistor collector, output+)
 *   [3] = nEmitter   (phototransistor emitter, output-)
 *
 * State pool layout:
 *   [0 .. DIODE_SCHEMA.size-1]                             — LED diode slots
 *   [DIODE_SCHEMA.size .. DIODE_SCHEMA.size+BJT_SIMPLE_SCHEMA.size-1] — BJT slots
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
import type { AnalogElementCore, LoadContext } from "../../solver/analog/element.js";
import { defineModelParams } from "../../core/model-params.js";
import { stampG, stampRHS } from "../../solver/analog/stamp-helpers.js";
import type { StatePoolRef } from "../../core/analog-types.js";

// Sub-element factories and schemas — LED — dioload.c:120-441
import {
  createDiodeElement,
  DIODE_SCHEMA,
  DIODE_PARAM_DEFAULTS,
} from "../semiconductors/diode.js";
// Sub-element factories and schemas — phototransistor — bjtload.c:170-end
import {
  createBjtElement,
  BJT_SIMPLE_SCHEMA,
  BJT_NPN_DEFAULTS,
} from "../semiconductors/bjt.js";

// ---------------------------------------------------------------------------
// Model parameter declarations
// ---------------------------------------------------------------------------

export const { paramDefs: OPTOCOUPLER_PARAM_DEFS, defaults: OPTOCOUPLER_DEFAULTS } = defineModelParams({
  primary: {
    ctr: { default: 1.0,   description: "Current transfer ratio CTR = I_collector / I_LED" },
    Is:  { default: 1e-14, unit: "A", description: "LED saturation current (dioload.c IS)" },
    n:   { default: 1.0,              description: "LED emission coefficient (dioload.c N)" },
  },
});

// Diode slot offsets within the combined state block (from DIODE_SCHEMA).
// SLOT_GEQ=1 (NR companion conductance), SLOT_ID=3 (diode current) — dioload.c CKTstate0.
const DIODE_SLOT_GEQ = 1;
const DIODE_SLOT_ID  = 3;

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
// Helpers to build PropertyBag for sub-elements
// ---------------------------------------------------------------------------

/** Build a PropertyBag for the LED diode sub-element with optocoupler-derived params. */
function makeLedProps(Is: number, n: number): PropertyBag {
  const bag = new PropertyBag(new Map<string, number>().entries());
  const merged: Record<string, number> = { ...DIODE_PARAM_DEFAULTS, IS: Is, N: n };
  bag.replaceModelParams(merged);
  return bag;
}

/** Build a PropertyBag for the phototransistor BJT sub-element (NPN, default L0 params). */
function makeBjtProps(): PropertyBag {
  const bag = new PropertyBag(new Map<string, number>().entries());
  bag.replaceModelParams({ ...BJT_NPN_DEFAULTS });
  return bag;
}

// ---------------------------------------------------------------------------
// OptocouplerAnalogElement factory — F4b composition
// ---------------------------------------------------------------------------

const DIODE_STATE_SIZE = DIODE_SCHEMA.size;  // 4 (no capacitance)
const BJT_STATE_SIZE   = BJT_SIMPLE_SCHEMA.size; // 8

function createOptocouplerElement(
  pinNodes: ReadonlyMap<string, number>,
  internalNodeIds: readonly number[],
  _branchIdx: number,
  props: PropertyBag,
): AnalogElementCore {
  const ctr = props.getModelParam<number>("ctr");
  const Is  = props.getModelParam<number>("Is");
  const n   = props.getModelParam<number>("n");

  const nAnode     = pinNodes.get("anode")!;
  const nCathode   = pinNodes.get("cathode")!;
  const nCollector = pinNodes.get("collector")!;
  const nEmitter   = pinNodes.get("emitter")!;

  // Internal base node for the phototransistor — no external pin.
  // Allocated by the compiler via getInternalNodeCount=1.
  const nBase = internalNodeIds[0]!;

  // --- LED diode sub-element (dioload.c:120-441) ---
  // Pin map uses diode's expected pin names "A" and "K".
  const ledPinNodes = new Map<string, number>([
    ["A", nAnode],
    ["K", nCathode],
  ]);
  const ledProps = makeLedProps(Is, n);
  const ledSub = createDiodeElement(ledPinNodes, [], -1, ledProps);

  // --- Phototransistor BJT sub-element (bjtload.c:170-end) ---
  // NPN polarity. Base = internalBase; C = nCollector; E = nEmitter.
  const bjtPinNodes = new Map<string, number>([
    ["B", nBase],
    ["C", nCollector],
    ["E", nEmitter],
  ]);
  const bjtProps = makeBjtProps();
  const bjtSub = createBjtElement(1 /* NPN polarity */, bjtPinNodes, -1, bjtProps);

  // Pool binding
  let pool: StatePoolRef;
  let diodeBase: number;
  let bjtBase: number;

  return {
    branchIndex: -1,
    isNonlinear: true,
    isReactive: false as const,
    poolBacked: true as const,
    stateSize: DIODE_STATE_SIZE + BJT_STATE_SIZE,
    stateSchema: DIODE_SCHEMA, // primary schema for diagnostics; BJT schema follows
    stateBaseOffset: -1,

    initState(poolRef: StatePoolRef): void {
      pool = poolRef;
      diodeBase = this.stateBaseOffset;
      bjtBase   = this.stateBaseOffset + DIODE_STATE_SIZE;

      // Wire sub-elements to their partitioned state regions.
      ledSub.stateBaseOffset = diodeBase;
      ledSub.initState(poolRef);

      bjtSub.stateBaseOffset = bjtBase;
      bjtSub.initState(poolRef);
    },

    load(ctx: LoadContext): void {
      // 1. LED diode stamp — dioload.c:120-441
      ledSub.load(ctx);

      // 2. CCCS stamp — CTR * I_LED injected as Norton source into internalBase.
      //
      // After ledSub.load(), pool.states[0][diodeBase + SLOT_ID] = I_LED (dioload.c DIOcurrent).
      //                        pool.states[0][diodeBase + SLOT_GEQ] = geq_LED (NR companion conductance).
      //
      // The CCCS injects I_base = CTR * I_LED into nBase.
      // NR linearization (Norton equivalent at operating point):
      //   I_base(Vd) = CTR * I_LED(Vd) ≈ CTR * geq_LED * Vd + CTR * ieq_LED
      //
      // Since I_LED = geq_LED * Vd - ieq_LED_offset, the Norton stamp into nBase is:
      //   Conductance coupling:
      //     G[nBase, nAnode]   += CTR * geq_LED
      //     G[nBase, nCathode] -= CTR * geq_LED
      //   Norton current (constant term from diode's ieq = id - geq*vd):
      //     iBase_nr = CTR * I_LED  (full operating-point current, not the ieq offset)
      //
      // Use the stored I_LED directly as the Norton injection (current source value at OP).
      // The conductance Jacobian links input (anode/cathode) columns to base row.
      const s0       = pool.states[0];
      const iLed     = s0[diodeBase + DIODE_SLOT_ID];
      const geqLed   = s0[diodeBase + DIODE_SLOT_GEQ];
      const iBase    = ctr * iLed;
      const gmCtr    = ctr * geqLed; // dI_base / dV_d

      // Conductance Jacobian: base row coupled to input voltage.
      // ngspice cccs/F source stamps: input branch column → output node rows.
      // Here the LED current is a voltage-controlled quantity (via the diode junction),
      // so we stamp as a conductance coupling from input nodes to base row.
      stampG(ctx.solver, nBase, nAnode,   gmCtr);
      stampG(ctx.solver, nBase, nCathode, -gmCtr);

      // Norton current source into base (RHS injection at operating point).
      // Jacobian reference current: iBase - gmCtr * (vA - vK) — linear part already
      // covered by stampG above, so the constant term is:
      //   iBase_norton = iBase - gmCtr * vd  where vd = vA - vK
      const vA = nAnode   > 0 ? ctx.voltages[nAnode   - 1] : 0;
      const vK = nCathode > 0 ? ctx.voltages[nCathode - 1] : 0;
      const vd = vA - vK;
      const iBaseNorton = iBase - gmCtr * vd;
      stampRHS(ctx.solver, nBase, iBaseNorton);

      // 3. Phototransistor BJT stamp — bjtload.c:170-end
      bjtSub.load(ctx);
    },

    setParam(key: string, value: number): void {
      // Optocoupler-level param update; sub-element params are immutable
      // after construction (no hot-reload path needed for composite).
      void key; void value;
    },

    getPinCurrents(voltages: Float64Array): number[] {
      // Pin order: [anode, cathode, collector, emitter]
      const s0   = pool.states[0];
      const iLed = s0[diodeBase + DIODE_SLOT_ID];
      const iC   = ctr * iLed;
      // LED side: I into anode = I_LED (positive = conventional current in)
      // BJT side: collector current ≈ CTR * I_LED (simplification at OP)
      return [iLed, -iLed, -iC, iC];
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
  { xmlName: "ctr",       propertyKey: "ctr",       convert: (v) => parseFloat(v), modelParam: true },
  { xmlName: "Is",        propertyKey: "Is",         convert: (v) => parseFloat(v), modelParam: true },
  { xmlName: "n",         propertyKey: "n",          convert: (v) => parseFloat(v), modelParam: true },
  { xmlName: "vceSat",    propertyKey: "vceSat",     convert: (v) => parseFloat(v) },
  { xmlName: "bandwidth", propertyKey: "bandwidth",  convert: (v) => parseFloat(v) },
  { xmlName: "Label",     propertyKey: "label",      convert: (v) => v },
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
    "LED input (dioload.c) + CCCS coupling (CTR) + phototransistor output (bjtload.c). " +
    "I_collector ≈ CTR * I_LED. Galvanic isolation between LED and phototransistor.",

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
      getInternalNodeCount: (_props) => 1, // phototransistor base node
      getInternalNodeLabels: (_props) => ["B'"], // internal base label for diagnostics
    },
  },
  defaultModel: "behavioral",
};
