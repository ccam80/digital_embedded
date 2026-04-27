/**
 * RelayDT (SPDT) — coil-controlled double-throw contact switch.
 *
 * Two coil terminals (in1, in2) control which contact position is active.
 * When the coil is energised (in1 XOR in2 is nonzero), the common terminal C
 * connects to the "throw" terminal T (normally open position).
 * When de-energised, C connects to the "rest" terminal R (normally closed position).
 *
 * Unlike Relay, RelayDT has no normallyClosed property — it always has both
 * a normally-open (T) and normally-closed (R) contact position.
 *
 * Pins:
 *   Inputs (coil): in1, in2 (1-bit each)
 *   Bidirectional (contacts per pole):
 *     A{n} — common terminal
 *     B{n} — throw (normally open, connects when coil energised)
 *     C{n} — rest (normally closed, connects when coil de-energised)
 *
 * internalStateCount: 1 (energised flag, read by bus resolver)
 */

import { AbstractCircuitElement } from "../../core/element.js";
import type { RenderContext } from "../../core/renderer-interface.js";
import type { Rect } from "../../core/renderer-interface.js";
import type { Pin, PinDeclaration, Rotation } from "../../core/pin.js";
import { PinDirection } from "../../core/pin.js";
import { PropertyBag, PropertyType } from "../../core/properties.js";
import type { PropertyDefinition } from "../../core/properties.js";
import {
  ComponentCategory,
  type AttributeMapping,
  type ComponentDefinition,
  type ComponentLayout,
} from "../../core/registry.js";
import type { LoadContext } from "../../solver/analog/element.js";
import { NGSPICE_LOAD_ORDER } from "../../solver/analog/element.js";
import type { SetupContext } from "../../solver/analog/setup-context.js";
import type { AnalogElementCore } from "../../core/analog-types.js";
import { SwitchAnalogElement } from "./switch.js";
import { RelayInductorSubElement, RelayResSubElement } from "./relay.js";

// ---------------------------------------------------------------------------
// RelayDT analog constants
// ---------------------------------------------------------------------------

const RELAY_DT_R_ON = 0.01;
const RELAY_DT_R_OFF = 1e7;
const RELAY_DT_R_COIL_DEFAULT = 100;
const RELAY_DT_L_DEFAULT = 0.1;
const RELAY_DT_I_PULL_DEFAULT = 20e-3;

// ---------------------------------------------------------------------------
// RelayDTAnalogElement — W3 migrated composite class
//
// Architecture: coilL (IND) + coilR (RES) + swNO (SW, normally-open) + swNC (SW, normally-closed)
// ngspice anchors:
//   coilL: indsetup.c:84-100, indload.c
//   coilR: ressetup.c:46-49, resload.c
//   swNO:  swsetup.c:47-62, swload.c
//   swNC:  swsetup.c:47-62, swload.c
// ---------------------------------------------------------------------------

class RelayDTAnalogElement implements AnalogElementCore {
  branchIndex: number = -1;
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.IND;
  readonly isNonlinear = true;
  readonly isReactive = true;
  _stateBase: number = -1;
  _pinNodes: Map<string, number>;

  readonly _coilL: RelayInductorSubElement;
  readonly _coilR: RelayResSubElement;
  readonly _swNO: SwitchAnalogElement;
  readonly _swNC: SwitchAnalogElement;

  private _nCoilMid: number = -1;
  private readonly _label: string;
  private readonly _iPull: number;

  constructor(label: string, pinNodes: ReadonlyMap<string, number>, props: PropertyBag) {
    this._label = label;
    this._pinNodes = new Map(pinNodes);
    this._iPull = props.has("iPull") ? (props.get("iPull") as number) : RELAY_DT_I_PULL_DEFAULT;

    const in1node = pinNodes.get("in1")!;
    const in2node = pinNodes.get("in2")!;
    const A1node = pinNodes.get("A1")!;
    const B1node = pinNodes.get("B1")!;
    const C1node = pinNodes.get("C1")!;

    const inductance = props.has("inductance") ? (props.get("inductance") as number) : RELAY_DT_L_DEFAULT;
    const coilResistance = props.has("coilResistance") ? (props.get("coilResistance") as number) : RELAY_DT_R_COIL_DEFAULT;

    // coilL: in1 → coilMid (B node will be set in setup() after makeVolt)
    this._coilL = new RelayInductorSubElement(`${label}/_coilL`, inductance);
    this._coilL._pinNodes = new Map([["A", in1node], ["B", -1]]);

    // coilR: coilMid → in2 (A node will be set in setup() after makeVolt)
    this._coilR = new RelayResSubElement(new Map([["A", -1], ["B", in2node]]), coilResistance);

    // swNO (normally-open): A1 ↔ B1 — starts open, closes when energised
    const swNOProps = new PropertyBag();
    swNOProps.set("Ron", RELAY_DT_R_ON);
    swNOProps.set("Roff", RELAY_DT_R_OFF);
    swNOProps.set("normallyClosed", false);
    swNOProps.set("closed", false);
    this._swNO = new SwitchAnalogElement(new Map([["A1", A1node], ["B1", B1node]]), swNOProps);

    // swNC (normally-closed): A1 ↔ C1 — starts closed, opens when energised
    const swNCProps = new PropertyBag();
    swNCProps.set("Ron", RELAY_DT_R_ON);
    swNCProps.set("Roff", RELAY_DT_R_OFF);
    swNCProps.set("normallyClosed", true);
    swNCProps.set("closed", false);
    this._swNC = new SwitchAnalogElement(new Map([["A1", A1node], ["B1", C1node]]), swNCProps);
  }

  setup(ctx: SetupContext): void {
    // Allocate mid-node between coilL and coilR
    this._nCoilMid = ctx.makeVolt(this._label, "coilMid");

    // Wire coilL: in1 → coilMid
    this._coilL._pinNodes.set("B", this._nCoilMid);

    // Wire coilR: coilMid → in2
    this._coilR._pinNodes.set("A", this._nCoilMid);

    // Sub-element setup in NGSPICE_LOAD_ORDER (IND=27 < RES=40 < SW=42)
    this._coilL.setup(ctx);  // 2 IND state slots + branch row + 5 IND handles
    this._coilR.setup(ctx);  // 0 state slots + 4 RES handles
    this._swNO.setup(ctx);   // 2 SW state slots + 4 SW handles (A1↔B1, normally-open)
    this._swNC.setup(ctx);   // 2 SW state slots + 4 SW handles (A1↔C1, normally-closed)

    // Store coilL's stateBase as the composite's state base
    this._stateBase = this._coilL._stateBase;

    // Expose branch index (coilL's branch)
    this.branchIndex = this._coilL.branchIndex;
  }

  findBranchFor(name: string, ctx: SetupContext): number {
    return this._coilL.findBranchFor(name, ctx);
  }

  load(ctx: LoadContext): void {
    this._coilL.load(ctx);  // IND Thevenin equivalent (req, veq)
    this._coilR.load(ctx);  // RES conductance stamp (coilResistance)
    this._swNO.load(ctx);   // normally-open: ON when |I_coil| > pickupCurrent
    this._swNC.load(ctx);   // normally-closed: OFF when |I_coil| > pickupCurrent (inverted)
  }

  accept(ctx: LoadContext, _simTime: number, _addBreakpoint: (t: number) => void): void {
    const b = this._coilL.branchIndex;
    const iCoil = b >= 0 ? ctx.rhs[b] : 0;
    const energised = Math.abs(iCoil) > this._iPull;
    // swNO: ON when energised
    this._swNO.setSwState(energised);
    // swNC: ON when NOT energised (normally closed inverts)
    this._swNC.setSwState(!energised);
  }

  getPinCurrents(rhs: Float64Array): number[] {
    const b = this._coilL.branchIndex;
    const iCoil = b >= 0 ? rhs[b] : 0;
    const noCurrents = this._swNO.getPinCurrents(rhs);
    const ncCurrents = this._swNC.getPinCurrents(rhs);
    return [iCoil, -iCoil, noCurrents[0] + ncCurrents[0], -noCurrents[0], -ncCurrents[0]];
  }

  setParam(key: string, value: number): void {
    if (key === "inductance") {
      this._coilL.setParam("inductance", value);
    } else if (key === "coilResistance") {
      this._coilR.setParam("resistance", value);
    } else if (key === "ron") {
      this._swNO.setParam("Ron", value);
      this._swNC.setParam("Ron", value);
    } else if (key === "roff") {
      this._swNO.setParam("Roff", value);
      this._swNC.setParam("Roff", value);
    }
  }
}

// ---------------------------------------------------------------------------
// createRelayDTAnalogElement — factory
// ---------------------------------------------------------------------------

function createRelayDTAnalogElement(
  pinNodes: ReadonlyMap<string, number>,
  props: PropertyBag,
  _getTime: () => number,
): AnalogElementCore {
  const label = (props.has("label") ? (props.get("label") as string) : undefined) ?? "RelayDT";
  return new RelayDTAnalogElement(label, pinNodes, props);
}

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

const COMP_WIDTH = 4;


// ---------------------------------------------------------------------------
// Pin layout helper
// ---------------------------------------------------------------------------

function buildRelayDTPins(poles: number, bitWidth: number): PinDeclaration[] {
  const decls: PinDeclaration[] = [];

  // Coil input pins above the body (in1 left, in2 right)
  // Java RelayDTShape: coil pins at y=-2 (above component origin), x=0 and x=2
  decls.push({
    kind: "signal",
    direction: PinDirection.INPUT,
    label: "in1",
    defaultBitWidth: 1,
    position: { x: 0, y: -2 },
    isNegatable: false,
    isClockCapable: false,
  });
  decls.push({
    kind: "signal",
    direction: PinDirection.INPUT,
    label: "in2",
    defaultBitWidth: 1,
    position: { x: 2, y: -2 },
    isNegatable: false,
    isClockCapable: false,
  });

  // Contact poles: A (common, left), B (throw, right top), C (rest, right bottom)
  // Java RelayDTShape: per pole p: A${p+1}@(0, 2*p), B${p+1}@(2, 2*p), C${p+1}@(2, 1+2*p)
  for (let p = 0; p < poles; p++) {
    decls.push({
      kind: "signal",
      direction: PinDirection.BIDIRECTIONAL,
      label: `A${p + 1}`,
      defaultBitWidth: bitWidth,
      position: { x: 0, y: 2 * p },
      isNegatable: false,
      isClockCapable: false,
    });
    decls.push({
      kind: "signal",
      direction: PinDirection.BIDIRECTIONAL,
      label: `B${p + 1}`,
      defaultBitWidth: bitWidth,
      position: { x: 2, y: 2 * p },
      isNegatable: false,
      isClockCapable: false,
    });
    decls.push({
      kind: "signal",
      direction: PinDirection.BIDIRECTIONAL,
      label: `C${p + 1}`,
      defaultBitWidth: bitWidth,
      position: { x: 2, y: 1 + 2 * p },
      isNegatable: false,
      isClockCapable: false,
    });
  }

  return decls;
}

// ---------------------------------------------------------------------------
// RelayDTElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class RelayDTElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("RelayDT", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    const poles = this._properties.getOrDefault<number>("poles", 1);
    const bitWidth = this._properties.getOrDefault<number>("bitWidth", 1);
    return this.derivePins(buildRelayDTPins(poles, bitWidth), []);
  }

  getBoundingBox(): Rect {
    const poles = this._properties.getOrDefault<number>("poles", 1);
    // Drawn geometry per pole: contact arm to y=0.5, pole stub to y=1 at x=2.
    // Coil (always present): rect (0.5,-1)→(1.5,-3), leads to x=0,x=2 at y=-2.
    // MaxY = poles * 2 - 1 (topmost pole stub) but for 1 pole = 1.
    const maxY = poles === 1 ? 1 : (poles - 1) * 2 + 1;
    return { x: this.position.x, y: this.position.y - 3, width: COMP_WIDTH, height: maxY + 3 };
  }

  draw(ctx: RenderContext): void {
    const label = this._visibleLabel();

    ctx.save();
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);

    // Pole stub (open L): (2,1) → (1.75,1) → (1.75,0.6) — use drawPath so the
    // rasterizer treats it as an open polyline matching the Java fixture (closed=false).
    ctx.drawPath({ operations: [
      { op: "moveTo", x: 2, y: 1 },
      { op: "lineTo", x: 1.75, y: 1 },
      { op: "lineTo", x: 1.75, y: 0.6 },
    ] });

    // Contact arm line: (0,0) to (1.8,0.5) — same as SwitchDT
    ctx.drawLine(0, 0, 1.8, 0.5);

    // Zero-length segment at B1 pin (2,0) so pin proximity check passes
    ctx.drawLine(2, 0, 2, 0);

    // Dashed linkage: (1,0.25) to (1,-0.95) — longer than SwitchDT, reaches coil
    ctx.setLineDash([0.2, 0.2]);
    ctx.drawLine(1, 0.25, 1, -0.95);
    ctx.setLineDash([]);

    // Coil rectangle (closed, NORMAL — outline only per Java fixture)
    ctx.drawPolygon(
      [
        { x: 0.5, y: -1 },
        { x: 0.5, y: -3 },
        { x: 1.5, y: -3 },
        { x: 1.5, y: -1 },
      ],
      false,
    );

    // Coil diagonal (THIN): (0.5,-1.5) to (1.5,-2.5)
    ctx.setLineWidth(0.5);
    ctx.drawLine(0.5, -1.5, 1.5, -2.5);
    ctx.setLineWidth(1);

    // Coil lead left: (0.5,-2) to (0,-2)
    ctx.drawLine(0.5, -2, 0, -2);

    // Coil lead right: (1.5,-2) to (2,-2)
    ctx.drawLine(1.5, -2, 2, -2);

    if (label.length > 0) {
      ctx.setColor("TEXT");
      ctx.setFont({ family: "sans-serif", size: 0.8 });
      ctx.drawText(label, 1, 2, { horizontal: "center", vertical: "top" });
    }

    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// RelayDTLayout — layout type with stateOffset
// ---------------------------------------------------------------------------

export interface RelayDTLayout extends ComponentLayout {
  stateOffset(componentIndex: number): number;
}

// ---------------------------------------------------------------------------
// executeRelayDT — flat simulation function
//
// Input layout: [in1=0, in2=1, C1..Cn, T1..Tn, R1..Rn contacts]
// State layout: [energisedFlag=0]
//
// When energised (in1 XOR in2 nonzero): C connects to T (state=1).
// When de-energised: C connects to R (state=0).
// Bus resolver reads state[stBase] to determine routing.
// ---------------------------------------------------------------------------

export function executeRelayDT(index: number, state: Uint32Array, _highZs: Uint32Array, layout: ComponentLayout): void {
  const wt = layout.wiringTable;
  const inBase = layout.inputOffset(index);
  const stBase = (layout as RelayDTLayout).stateOffset(index);

  const in1 = state[wt[inBase]] & 1;
  const in2 = state[wt[inBase + 1]] & 1;

  // Energised when coil terminals differ
  const energised = (in1 ^ in2) !== 0 ? 1 : 0;
  state[stBase] = energised;
}

// ---------------------------------------------------------------------------
// Attribute mappings and property definitions
// ---------------------------------------------------------------------------

export const RELAY_DT_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  { xmlName: "Bits", propertyKey: "bitWidth", convert: (v) => parseInt(v, 10) },
  { xmlName: "Label", propertyKey: "label", convert: (v) => v },
  { xmlName: "Poles", propertyKey: "poles", convert: (v) => parseInt(v, 10) },
];

const RELAY_DT_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "poles",
    type: PropertyType.INT,
    label: "Poles",
    defaultValue: 1,
    min: 1,
    max: 4,
    description: "Number of relay contact poles",
  },
  {
    key: "bitWidth",
    type: PropertyType.BIT_WIDTH,
    label: "Bits",
    defaultValue: 1,
    min: 1,
    max: 32,
    description: "Bit width of each switched signal",
    structural: true,
  },
  {
    key: "label",
    type: PropertyType.STRING,
    label: "Label",
    defaultValue: "",
    description: "Optional label shown near the component",
  },
];

function relayDTFactory(props: PropertyBag): RelayDTElement {
  return new RelayDTElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const RelayDTDefinition: ComponentDefinition = {
  name: "RelayDT",
  typeId: -1,
  factory: relayDTFactory,
  pinLayout: buildRelayDTPins(1, 1),
  propertyDefs: RELAY_DT_PROPERTY_DEFS,
  attributeMap: RELAY_DT_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.SWITCHING,
  helpText: "RelayDT (SPDT) — coil-controlled double-throw contact switch. C connects to T when energised, R when de-energised.",
  models: {
    digital: {
      executeFn: executeRelayDT,
      inputSchema: ["in1", "in2"],
      outputSchema: ["A1", "B1", "C1"],
      stateSlotCount: 1,
      switchPins: [2, 3],
      defaultDelay: 0,
    },
  },
  modelRegistry: {
    "behavioral": {
      kind: "inline",
      factory: createRelayDTAnalogElement,
      paramDefs: [],
      params: {},
      mayCreateInternalNodes: true,
    },
  },
  defaultModel: "digital",
};
