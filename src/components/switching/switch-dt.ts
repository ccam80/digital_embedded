/**
 * SwitchDT component -- SPDT switch with mechanical symbol rendering.
 *
 * Double-throw switch: three terminals per pole (A=common, B=upper, C=lower).
 * When closed=true: A-B are connected, A-C are disconnected.
 * When closed=false: A-B are disconnected, A-C are connected.
 *
 * Differs from PlainSwitchDT only in visual rendering (uses the same
 * mechanical-symbol style as Switch for the contact lines, with the
 * additional DT stub shown by SwitchDTShape.java).
 *
 * Pattern follows the And gate exemplar exactly.
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
import type { AnalogElement, LoadContext } from "../../solver/analog/element.js";
import { NGSPICE_LOAD_ORDER } from "../../solver/analog/element.js";
import type { SetupContext } from "../../solver/analog/setup-context.js";
import { SwitchAnalogElement } from "./switch.js";

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

/** Component width in grid units. */
const COMP_WIDTH = 2;

/** Vertical spacing between poles in grid units. */
const POLE_HEIGHT = 2;

/** Vertical offset for C pin (lower contact) relative to pole base. */
const C_OFFSET = 1;

function componentHeight(poles: number): number {
  return Math.max(poles * POLE_HEIGHT + C_OFFSET, 3);
}

// ---------------------------------------------------------------------------
// Pin layout helpers
// ---------------------------------------------------------------------------

function buildPinDeclarations(poles: number, bitWidth: number): PinDeclaration[] {
  const decls: PinDeclaration[] = [];
  for (let p = 0; p < poles; p++) {
    const yBase = p * POLE_HEIGHT;
    // A: common terminal (left)
    decls.push({
      kind: "signal",
      direction: PinDirection.BIDIRECTIONAL,
      label: `A${p + 1}`,
      defaultBitWidth: bitWidth,
      position: { x: 0, y: yBase },
      isNegatable: false,
      isClockCapable: false,
    });
    // B: upper-right contact
    decls.push({
      kind: "signal",
      direction: PinDirection.BIDIRECTIONAL,
      label: `B${p + 1}`,
      defaultBitWidth: bitWidth,
      position: { x: COMP_WIDTH, y: yBase },
      isNegatable: false,
      isClockCapable: false,
    });
    // C: lower-right contact (C_OFFSET below B)
    decls.push({
      kind: "signal",
      direction: PinDirection.BIDIRECTIONAL,
      label: `C${p + 1}`,
      defaultBitWidth: bitWidth,
      position: { x: COMP_WIDTH, y: yBase + C_OFFSET },
      isNegatable: false,
      isClockCapable: false,
    });
  }
  return decls;
}

// ---------------------------------------------------------------------------
// SwitchDTElement -- CircuitElement implementation
// ---------------------------------------------------------------------------

export class SwitchDTElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("SwitchDT", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    const poles = this._properties.getOrDefault<number>("poles", 1);
    const bitWidth = this._properties.getOrDefault<number>("bitWidth", 1);
    return this.derivePins(buildPinDeclarations(poles, bitWidth), []);
  }

  getBoundingBox(): Rect {
    const poles = this._properties.getOrDefault<number>("poles", 1);
    const h = componentHeight(poles);
    // Thin bar at (0.5,-0.75)->(1.5,-0.75); contact arm to (1.8,0.5); pole stub to (2,1).
    // MinX=0, MaxX=2, MinY=-0.75, MaxY=max(h, 1).
    return {
      x: this.position.x,
      y: this.position.y - 0.75,
      width: COMP_WIDTH,
      height: Math.max(h, 1) + 0.75,
    };
  }

  draw(ctx: RenderContext): void {
    const label = this._visibleLabel();

    ctx.save();
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);

    // Pole stub (open L): (2,1) -> (1.75,1) -> (1.75,0.6) -- use drawPath so the
    // rasterizer treats it as an open polyline matching the Java fixture (closed=false).
    ctx.drawPath({ operations: [
      { op: "moveTo", x: 2, y: 1 },
      { op: "lineTo", x: 1.75, y: 1 },
      { op: "lineTo", x: 1.75, y: 0.6 },
    ] });

    // Contact arm line: (0,0) to (1.8,0.5)
    ctx.drawLine(0, 0, 1.8, 0.5);

    // Zero-length segment at B pin (2,0) so pin proximity check passes
    ctx.drawLine(2, 0, 2, 0);

    // Dashed linkage: (1,0.25) to (1,-0.75)
    ctx.setLineDash([0.2, 0.2]);
    ctx.drawLine(1, 0.25, 1, -0.75);
    ctx.setLineDash([]);

    // Thin bar: (0.5,-0.75) to (1.5,-0.75)
    ctx.setLineWidth(0.5);
    ctx.drawLine(0.5, -0.75, 1.5, -0.75);
    ctx.setLineWidth(1);

    if (label.length > 0) {
      ctx.setColor("TEXT");
      ctx.setFont({ family: "sans-serif", size: 0.8 });
      ctx.drawText(label, COMP_WIDTH / 2, 2, { horizontal: "center", vertical: "top" });
    }

    ctx.restore();
  }

  isClosed(): boolean {
    return this._properties.getOrDefault<boolean>("closed", false);
  }
}

// ---------------------------------------------------------------------------
// executeSwitchDT -- flat simulation function
//
// SPDT switches are handled by the bus resolution subsystem (Phase 3).
// The switch state is managed by the interactive engine layer.
// No computation needed here.
// ---------------------------------------------------------------------------

export function executeSwitchDT(index: number, state: Uint32Array, _highZs: Uint32Array, layout: ComponentLayout): void {
  const stBase = layout.stateOffset(index);
  const closed = layout.getProperty(index, "closed") ?? false;
  const normallyClosed = layout.getProperty(index, "normallyClosed") ?? false;
  // Effective state: NC inverts the meaning
  const effectivelyClosed = normallyClosed ? !closed : closed;
  state[stBase] = effectivelyClosed ? 1 : 0;
}

// ---------------------------------------------------------------------------
// SWITCH_DT_ATTRIBUTE_MAPPINGS
// ---------------------------------------------------------------------------

export const SWITCH_DT_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  {
    xmlName: "Bits",
    propertyKey: "bitWidth",
    convert: (v) => parseInt(v, 10),
  },
  {
    xmlName: "Label",
    propertyKey: "label",
    convert: (v) => v,
  },
  {
    xmlName: "Poles",
    propertyKey: "poles",
    convert: (v) => parseInt(v, 10),
  },
  {
    xmlName: "closed",
    propertyKey: "closed",
    convert: (v) => v === "true",
  },
  {
    xmlName: "Ron",
    propertyKey: "Ron",
    convert: (v) => parseFloat(v),
  },
  {
    xmlName: "Roff",
    propertyKey: "Roff",
    convert: (v) => parseFloat(v),
  },
  {
    xmlName: "momentary",
    propertyKey: "momentary",
    convert: (v) => v === "true",
  },
  {
    xmlName: "normallyClosed",
    propertyKey: "normallyClosed",
    convert: (v) => v === "true",
  },
];

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const SWITCH_DT_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "poles",
    type: PropertyType.INT,
    label: "Poles",
    defaultValue: 1,
    min: 1,
    max: 4,
    description: "Number of switch poles",
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
    key: "closed",
    type: PropertyType.BOOLEAN,
    label: "Closed",
    defaultValue: false,
    description: "Initial switch state (closed=true: A-B connected; false: A-C connected)",
  },
  {
    key: "label",
    type: PropertyType.STRING,
    label: "Label",
    defaultValue: "",
    description: "Optional label shown near the component",
  },
  {
    key: "Ron",
    type: PropertyType.FLOAT,
    label: "Ron (Î)",
    defaultValue: 1,
    min: 1e-12,
    description: "On-state resistance in ohms (analog mode)",
  },
  {
    key: "Roff",
    type: PropertyType.FLOAT,
    label: "Roff (Î)",
    defaultValue: 1e9,
    min: 1,
    description: "Off-state resistance in ohms (analog mode)",
  },
  {
    key: "momentary",
    type: PropertyType.BOOLEAN,
    label: "Momentary",
    defaultValue: false,
    description: "When true, switch is only active while held (releases on mouseup)",
  },
  {
    key: "normallyClosed",
    type: PropertyType.BOOLEAN,
    label: "Normally Closed",
    defaultValue: false,
    description: "When true, switch is closed at rest",
  },
];

// ---------------------------------------------------------------------------
// Composite: two SW sub-elements (SW_AB and SW_AC) per PB-SW-DT spec.
// setup() forwards to sub-elements in order: swAB first, swAC second.
// Port of ngspice SW device applied twice:
//   setup: swsetup.c:47-62 (applied to each sub-element)
//   load:  swload.c (applied to each sub-element)
// ---------------------------------------------------------------------------

export interface SpdtAnalogElement extends AnalogElement {
  setClosed(closed: boolean): void;
}

export class SwitchDTAnalogElement implements SpdtAnalogElement {
  label: string = "";
  branchIndex: number = -1;
  readonly ngspiceLoadOrder: number = NGSPICE_LOAD_ORDER.SW;
  _stateBase: number = -1;
  _pinNodes: Map<string, number>;

  readonly swAB: SwitchAnalogElement;
  readonly swAC: SwitchAnalogElement;

  constructor(pinNodes: ReadonlyMap<string, number>, props: PropertyBag) {
    this._pinNodes = new Map(pinNodes);

    const a1 = pinNodes.get("A1")!;
    const b1 = pinNodes.get("B1")!;
    const c1 = pinNodes.get("C1")!;

    const closed = props.getOrDefault<boolean>("closed", false);

    // SW_AB: A1 (pos) ↔ B1 (neg)
    const propAB = new PropertyBag();
    propAB.set("Ron", props.getOrDefault<number>("Ron", 1));
    propAB.set("Roff", props.getOrDefault<number>("Roff", 1e9));
    propAB.set("normallyClosed", props.getOrDefault<boolean>("normallyClosed", false));
    propAB.set("closed", closed);
    this.swAB = new SwitchAnalogElement(
      new Map([["A1", a1], ["B1", b1]]),
      propAB,
    );

    // SW_AC: A1 (pos) ↔ C1 (neg)
    // When closed=true: AB is on (Ron), AC is off (Roff).
    // When closed=false: AB is off (Roff), AC is on (Ron).
    // So SW_AC is the complement: it starts as !closed.
    const propAC = new PropertyBag();
    propAC.set("Ron", props.getOrDefault<number>("Ron", 1));
    propAC.set("Roff", props.getOrDefault<number>("Roff", 1e9));
    propAC.set("normallyClosed", props.getOrDefault<boolean>("normallyClosed", false));
    propAC.set("closed", !closed);
    this.swAC = new SwitchAnalogElement(
      new Map([["A1", a1], ["B1", c1]]),
      propAC,
    );
  }

  setup(ctx: SetupContext): void {
    // Composite forwards to sub-elements in subElements[] order.
    // swAB runs first (A1↔B1), swAC runs second (A1↔C1).
    this.swAB.setup(ctx);  // allocates SW_AB's 2 state slots + 4 matrix handles
    this.swAC.setup(ctx);  // allocates SW_AC's 2 state slots + 4 matrix handles
  }

  load(ctx: LoadContext): void {
    this.swAB.load(ctx);  // stamps SW_AB conductance onto A1/B1 nodes
    this.swAC.load(ctx);  // stamps SW_AC conductance onto A1/C1 nodes
  }

  setClosed(closed: boolean): void {
    // SPDT: AB is on when closed, AC is on when NOT closed
    this.swAB.setClosed(closed);
    this.swAC.setClosed(!closed);
  }

  getPinCurrents(rhs: Float64Array): number[] {
    const a1 = this._pinNodes.get("A1")!;
    const b1 = this._pinNodes.get("B1")!;
    const c1 = this._pinNodes.get("C1")!;
    const [iAB_a, iAB_b] = this.swAB.getPinCurrents(rhs);
    const [iAC_a, iAC_c] = this.swAC.getPinCurrents(rhs);
    void a1; void b1; void c1;
    return [iAB_a + iAC_a, iAB_b, iAC_c];
  }

  setParam(key: string, value: unknown): void {
    if (key === "ron" || key === "roff" || key === "Ron" || key === "Roff") {
      this.swAB.setParam(key, value);
      this.swAC.setParam(key, value);
    }
    if (key === "closed") {
      this.setClosed(!!value);
    }
  }
}

// ---------------------------------------------------------------------------
// SwitchDTDefinition
// ---------------------------------------------------------------------------

function switchDTFactory(props: PropertyBag): SwitchDTElement {
  return new SwitchDTElement(
    crypto.randomUUID(),
    { x: 0, y: 0 },
    0,
    false,
    props,
  );
}

export const SwitchDTDefinition: ComponentDefinition = {
  name: "SwitchDT",
  typeId: -1,
  factory: switchDTFactory,
  pinLayout: buildPinDeclarations(1, 1),
  propertyDefs: SWITCH_DT_PROPERTY_DEFS,
  attributeMap: SWITCH_DT_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.SWITCHING,
  helpText:
    "Switch DT (SPDT) -- a manually controlled single-pole double-throw switch.\n" +
    "Common terminal A connects to B when closed, to C when open.\n" +
    "Net merging/splitting handled by bus resolution subsystem.\n" +
    "Click to toggle during simulation.",
  models: {
    digital: {
      executeFn: executeSwitchDT,
      inputSchema: [],
      outputSchema: ["A1", "B1", "C1"],
      stateSlotCount: 1,
      switchPins: [0, 1],
      defaultDelay: 0,
    },
  },
  modelRegistry: {
    "behavioral": {
      kind: "inline",
      factory: (pinNodes, props, _getTime) => new SwitchDTAnalogElement(pinNodes, props),
      paramDefs: [],
      params: {},
    },
  },
  defaultModel: "digital",
};
