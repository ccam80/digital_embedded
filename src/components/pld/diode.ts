/**
 * Diode, DiodeForward, DiodeBackward PLD components.
 *
 * Diode: bidirectional current-flow model for wired OR/AND arrays.
 *   - anode and cathode are BIDIRECTIONAL pins.
 *   - When anode is driven high: cathode is pulled to 1 (wired-OR contribution).
 *   - When cathode is driven low: anode is pulled to 0 (wired-AND contribution).
 *   - blown property: when true the diode is permanently open-circuit (no-op).
 *
 * DiodeForward: unidirectional diode driving a pull-down output net (wired-OR).
 *   - Single input pin "in", single bidirectional output "out".
 *   - When in=1 â†’ out drives 1; when in=0 â†’ out is high-Z.
 *   - Requires a pull-down resistor on the output net.
 *
 * DiodeBackward: unidirectional diode driving a pull-up output net (wired-AND).
 *   - Single input pin "in", single bidirectional output "out".
 *   - When in=1 â†’ out drives 1 (contributes high to pull-up net).
 *   - When in=0 â†’ out drives 0.
 *   - Requires a pull-up resistor on the output net.
 *
 * Bidirectional / high-Z semantics are handled by the bus resolution layer. A
 * driver communicates with the resolver through two parallel arrays keyed by the
 * (shadow) net id at its output-pin wiring slot: it writes its driven value into
 * `state[outNet]` and its drive state into `highZs[outNet]` (0 = actively
 * driving, 0xFFFFFFFF = high-Z). The resolver ORs together the non-high-Z
 * drivers and applies the net's pull resistor when every driver is high-Z
 * (bus-resolution.ts:resolveBusDrivers). A pin that is both read and driven (the
 * bidirectional Diode's out1/out2) appears in inputSchema (read the resolved
 * real-net value) and outputSchema (drive a per-driver shadow), mirroring the
 * bidirectional data bus in ram.ts.
 *
 * `blown` is a per-instance property read via layout.getProperty.
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
  type StandaloneComponentDefinition,
  type ComponentLayout,
} from "../../core/registry.js";

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

// Java DiodeShape: vertical layout
// Diode:         out1(0,0), out2(0,-1)  [cathode at y=0, anode at y=-1]
// DiodeBackward: in(0,0),   out(0,-1)
// DiodeForeward: in(0,0),   out(0,1)
//
// Java draws:
//   Polygon: (-0.5,-0.95) â†’ (0.5,-0.95) â†’ (0,-0.05), closed
//   Line:    (-0.5,-0.05) â†’ (0.5,-0.05)
// Pins: out1 at (0,0), out2 at (0,-1)
const COMP_WIDTH = 1;  // fits the ±0.5 x extent
const COMP_HEIGHT = 1; // fits the -1..0 y extent

// ---------------------------------------------------------------------------
// Shared pin layout helpers
// ---------------------------------------------------------------------------

function buildDiodePinDeclarations(): PinDeclaration[] {
  return [
    {
      direction: PinDirection.BIDIRECTIONAL,
      label: "out1",
      defaultBitWidth: 1,
      position: { x: 0, y: 0 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.BIDIRECTIONAL,
      label: "out2",
      defaultBitWidth: 1,
      position: { x: 0, y: -1 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
  ];
}

function buildDiodeBackwardPinDeclarations(): PinDeclaration[] {
  return [
    {
      direction: PinDirection.INPUT,
      label: "in",
      defaultBitWidth: 1,
      position: { x: 0, y: 0 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.OUTPUT,
      label: "out",
      defaultBitWidth: 1,
      position: { x: 0, y: -1 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
  ];
}

function buildDiodeForwardPinDeclarations(): PinDeclaration[] {
  return [
    {
      direction: PinDirection.INPUT,
      label: "in",
      defaultBitWidth: 1,
      position: { x: 0, y: 0 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.OUTPUT,
      label: "out",
      defaultBitWidth: 1,
      position: { x: 0, y: 1 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
  ];
}

// ---------------------------------------------------------------------------
// Shared draw helpers
// ---------------------------------------------------------------------------

/**
 * Draw the Diode symbol body.
 * Matches Java DiodeShape exactly:
 *   Polygon (closed): (-0.5,-0.95) â†’ (0.5,-0.95) â†’ (0,-0.05)
 *   Line: (-0.5,-0.05) â†’ (0.5,-0.05)   [cathode bar]
 * Pins: out1 at (0,0), out2 at (0,-1).
 * The polygon tip touches pin out1 at (0,-0.05â‰ˆ0), cathode bar at -0.05.
 * The base spans ±0.5 at y=-0.95, touching pin out2 at (0,-1) from below.
 */
function drawDiodeBody(ctx: RenderContext, label: string): void {
  ctx.setColor("COMPONENT");
  ctx.setLineWidth(1);

  // Triangle: base at top (y=-0.95), tip pointing down toward (0,-0.05)
  ctx.drawPath({
    operations: [
      { op: "moveTo", x: -0.5, y: -0.95 },
      { op: "lineTo", x: 0.5,  y: -0.95 },
      { op: "lineTo", x: 0,    y: -0.05 },
      { op: "closePath" },
    ],
  });

  // Cathode bar at the tip
  ctx.drawLine(-0.5, -0.05, 0.5, -0.05);

  if (label.length > 0) {
    ctx.setColor("TEXT");
    ctx.setFont({ family: "sans-serif", size: 0.8 });
    ctx.drawText(label, 0, -1.1, { horizontal: "center", vertical: "bottom" });
  }
}

/**
 * Draw DiodeForward: vertical orientation, pin "in" at top (0,0), pin "out" at bottom (0,1).
 * Downward-pointing triangle with cathode bar at bottom.
 * Matches Java DiodeShape for DiodeForward.
 */
function drawDiodeBodyForward(ctx: RenderContext, label: string): void {
  ctx.setColor("COMPONENT");
  ctx.setLineWidth(1);

  // Downward-pointing triangle: top-left â†’ top-right â†’ bottom-centre
  ctx.drawPath({
    operations: [
      { op: "moveTo", x: -0.5, y: 0.05 },
      { op: "lineTo", x: 0.5, y: 0.05 },
      { op: "lineTo", x: 0, y: 0.95 },
      { op: "closePath" },
    ],
  });

  // Cathode bar at bottom of triangle
  ctx.drawLine(-0.5, 0.95, 0.5, 0.95);

  if (label.length > 0) {
    ctx.setColor("TEXT");
    ctx.setFont({ family: "sans-serif", size: 0.8 });
    ctx.drawText(label, 0, -0.1, { horizontal: "center", vertical: "bottom" });
  }
}

/**
 * Draw DiodeBackward: vertical orientation, pin "in" at bottom (0,0), pin "out" at top (0,-1).
 * Upward-pointing triangle with cathode bar at top.
 * Matches Java DiodeShape for DiodeBackward.
 */
function drawDiodeBodyBackward(ctx: RenderContext, label: string): void {
  ctx.setColor("COMPONENT");
  ctx.setLineWidth(1);

  // Upward-pointing triangle: bottom-left â†’ bottom-right â†’ top-centre
  ctx.drawPath({
    operations: [
      { op: "moveTo", x: -0.5, y: -0.95 },
      { op: "lineTo", x: 0.5, y: -0.95 },
      { op: "lineTo", x: 0, y: -0.05 },
      { op: "closePath" },
    ],
  });

  // Cathode bar at top of triangle
  ctx.drawLine(-0.5, -0.05, 0.5, -0.05);

  if (label.length > 0) {
    ctx.setColor("TEXT");
    ctx.setFont({ family: "sans-serif", size: 0.8 });
    ctx.drawText(label, 0, 0.1, { horizontal: "center", vertical: "top" });
  }
}

// ---------------------------------------------------------------------------
// Shared property definitions and attribute mappings
// ---------------------------------------------------------------------------

const DIODE_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "blown",
    type: PropertyType.BOOLEAN,
    label: "Blown",
    defaultValue: false,
    description: "When true, diode is permanently open-circuit (no current flows)",
  },
  {
    key: "label",
    type: PropertyType.STRING,
    label: "Label",
    defaultValue: "",
    description: "Optional label shown near the component",
  },
];

const DIODE_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  {
    xmlName: "blown",
    propertyKey: "blown",
    convert: (v) => v === "true",
  },
  {
    xmlName: "Label",
    propertyKey: "label",
    convert: (v) => v,
  },
];

// ---------------------------------------------------------------------------
// DiodeElement- CircuitElement implementation
// ---------------------------------------------------------------------------

export class DiodeElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("PldDiode", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildDiodePinDeclarations());
  }

  getBoundingBox(): Rect {
    // Draw extents: x in [-0.5, 0.5], y in [-0.95, -0.05]
    return {
      x: this.position.x - 0.5,
      y: this.position.y - 0.95,
      width: COMP_WIDTH,
      height: COMP_HEIGHT,
    };
  }

  draw(ctx: RenderContext): void {
    const blown = this._properties.getOrDefault<boolean>("blown", false);
    ctx.save();

    const label = this._visibleLabel();
    drawDiodeBody(ctx, label);

    if (blown) {
      ctx.setColor("WIRE_ERROR");
      ctx.setLineWidth(1);
      ctx.drawLine(-0.2, -0.8, 0.2, -0.2);
    }

    ctx.restore();
  }

  isBlown(): boolean {
    return this._properties.getOrDefault<boolean>("blown", false);
  }
}

// ---------------------------------------------------------------------------
// DiodeForwardElement- unidirectional forward diode (wired-OR)
// ---------------------------------------------------------------------------

export class DiodeForwardElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("PldDiodeForward", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildDiodeForwardPinDeclarations());
  }

  getBoundingBox(): Rect {
    // Triangle spans x: -0.5 to 0.5, y: 0.05 to 0.95
    // Cathode bar at y=0.95, triangle top at y=0.05
    return {
      x: this.position.x - 0.5,
      y: this.position.y + 0.05,
      width: 1,
      height: 0.9,
    };
  }

  draw(ctx: RenderContext): void {
    const blown = this._properties.getOrDefault<boolean>("blown", false);
    ctx.save();

    const label = this._visibleLabel();
    drawDiodeBodyForward(ctx, label);

    if (blown) {
      ctx.setColor("WIRE_ERROR");
      ctx.setLineWidth(1);
      ctx.drawLine(-0.2, 0.2, 0.2, 0.8);
    }

    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// DiodeBackwardElement- unidirectional backward diode (wired-AND)
// ---------------------------------------------------------------------------

export class DiodeBackwardElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("PldDiodeBackward", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildDiodeBackwardPinDeclarations());
  }

  getBoundingBox(): Rect {
    // Triangle spans x: -0.5 to 0.5, y: -0.95 to -0.05
    // Cathode bar at y=-0.05, triangle bottom at y=-0.95
    return {
      x: this.position.x - 0.5,
      y: this.position.y - 0.95,
      width: 1,
      height: 0.9,
    };
  }

  draw(ctx: RenderContext): void {
    const blown = this._properties.getOrDefault<boolean>("blown", false);
    ctx.save();

    const label = this._visibleLabel();
    drawDiodeBodyBackward(ctx, label);

    if (blown) {
      ctx.setColor("WIRE_ERROR");
      ctx.setLineWidth(1);
      ctx.drawLine(-0.2, -0.8, 0.2, -0.2);
    }

    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// executeDiode- flat simulation function (bidirectional PLD diode)
//
// out1 = cathode side, out2 = anode side; both are read (inputSchema) and driven
// (outputSchema). Forward conduction drives the cathode to 1 when the anode side
// is actively high; reverse conduction drives the anode to 0 when the cathode
// side is actively low. Each side is high-Z otherwise, so the net's pull resistor
// (or another driver) sets the floating value.
//
// Input wiring slots index the resolved real nets (cathode=0, anode=1); output
// wiring slots index this diode's per-driver shadows (cathode=0, anode=1).
// ---------------------------------------------------------------------------

export function executeDiode(index: number, state: Uint32Array, highZs: Uint32Array, layout: ComponentLayout): void {
  const wt = layout.wiringTable;
  const inBase = layout.inputOffset(index);
  const outBase = layout.outputOffset(index);
  const blown = layout.getProperty(index, "blown") === true;

  const cathodeDriveNet = wt[outBase];
  const anodeDriveNet = wt[outBase + 1];

  if (blown) {
    // Open circuit- both sides high-Z.
    state[cathodeDriveNet] = 0;
    highZs[cathodeDriveNet] = 0xFFFFFFFF;
    state[anodeDriveNet] = 0;
    highZs[anodeDriveNet] = 0xFFFFFFFF;
    return;
  }

  const cathodeVal = state[wt[inBase]] & 1;
  const cathodeHighZ = (highZs[wt[inBase]] ?? 0xFFFFFFFF) & 1;
  const anodeVal = state[wt[inBase + 1]] & 1;
  const anodeHighZ = (highZs[wt[inBase + 1]] ?? 0xFFFFFFFF) & 1;

  // Cathode (out1): forward conduction drives it high when the anode is actively high.
  if (anodeHighZ === 0 && anodeVal !== 0) {
    state[cathodeDriveNet] = 1;
    highZs[cathodeDriveNet] = 0;
  } else {
    state[cathodeDriveNet] = 0;
    highZs[cathodeDriveNet] = 0xFFFFFFFF;
  }

  // Anode (out2): reverse conduction drives it low when the cathode is actively low.
  if (cathodeHighZ === 0 && cathodeVal === 0) {
    state[anodeDriveNet] = 0;
    highZs[anodeDriveNet] = 0;
  } else {
    state[anodeDriveNet] = 0;
    highZs[anodeDriveNet] = 0xFFFFFFFF;
  }
}

// ---------------------------------------------------------------------------
// executeDiodeForward- flat simulation function (wired-OR diode)
//
// in=1 â†’ out drives 1; in=0 (or blown) â†’ out high-Z so the net's pull-down
// resistor resolves it low.
// ---------------------------------------------------------------------------

export function executeDiodeForward(index: number, state: Uint32Array, highZs: Uint32Array, layout: ComponentLayout): void {
  const wt = layout.wiringTable;
  const inBase = layout.inputOffset(index);
  const outNet = wt[layout.outputOffset(index)];
  const blown = layout.getProperty(index, "blown") === true;

  if (!blown && (state[wt[inBase]] & 1) !== 0) {
    state[outNet] = 1;
    highZs[outNet] = 0;
  } else {
    state[outNet] = 0;
    highZs[outNet] = 0xFFFFFFFF;
  }
}

// ---------------------------------------------------------------------------
// executeDiodeBackward- flat simulation function (wired-AND diode)
//
// Actively drives out to the input value (in=1 â†’ 1, in=0 â†’ 0); blown â†’ high-Z.
// ---------------------------------------------------------------------------

export function executeDiodeBackward(index: number, state: Uint32Array, highZs: Uint32Array, layout: ComponentLayout): void {
  const wt = layout.wiringTable;
  const inBase = layout.inputOffset(index);
  const outNet = wt[layout.outputOffset(index)];
  const blown = layout.getProperty(index, "blown") === true;

  if (blown) {
    state[outNet] = 0;
    highZs[outNet] = 0xFFFFFFFF;
    return;
  }

  state[outNet] = state[wt[inBase]] & 1;
  highZs[outNet] = 0;
}

// ---------------------------------------------------------------------------
// Attribute mappings shared across all diode variants
// ---------------------------------------------------------------------------

export const DIODE_ATTRIBUTE_MAPPINGS_EXPORT: AttributeMapping[] = DIODE_ATTRIBUTE_MAPPINGS;

// ---------------------------------------------------------------------------
// Factory functions
// ---------------------------------------------------------------------------

function diodeFactory(props: PropertyBag): DiodeElement {
  return new DiodeElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

function diodeForwardFactory(props: PropertyBag): DiodeForwardElement {
  return new DiodeForwardElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

function diodeBackwardFactory(props: PropertyBag): DiodeBackwardElement {
  return new DiodeBackwardElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

// ---------------------------------------------------------------------------
// ComponentDefinitions
// ---------------------------------------------------------------------------

export const PldDiodeDefinition: StandaloneComponentDefinition = {
  name: "PldDiode",
  typeId: -1,
  factory: diodeFactory,
  pinLayout: buildDiodePinDeclarations(),
  propertyDefs: DIODE_PROPERTY_DEFS,
  attributeMap: DIODE_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.PLD,
  helpText:
    "Diode- bidirectional current-flow element for PLD wired-OR/AND arrays.\n" +
    "Use in conjunction with pull-up/pull-down resistors.\n" +
    "blown=true permanently opens the diode.",
  models: {
    digital: {
      executeFn: executeDiode,
      // out1/out2 are bidirectional: read as the resolved real net (inputSchema)
      // and driven via per-driver shadows (outputSchema), like ram.ts's D bus.
      inputSchema: ["out1", "out2"],
      outputSchema: ["out1", "out2"],
      defaultDelay: 0,
    },
  },
};

export const PldDiodeForwardDefinition: StandaloneComponentDefinition = {
  name: "PldDiodeForward",
  typeId: -1,
  factory: diodeForwardFactory,
  pinLayout: buildDiodeForwardPinDeclarations(),
  propertyDefs: DIODE_PROPERTY_DEFS,
  attributeMap: DIODE_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.PLD,
  helpText:
    "DiodeForward- forward diode for wired-OR PLD arrays.\n" +
    "in=1 â†’ out=1; in=0 â†’ out=high-Z. Requires pull-down on output net.\n" +
    "blown=true permanently opens the diode.",
  models: {
    digital: {
      executeFn: executeDiodeForward,
      inputSchema: ["in"],
      outputSchema: ["out"],
      defaultDelay: 0,
    },
  },
};

export const PldDiodeBackwardDefinition: StandaloneComponentDefinition = {
  name: "PldDiodeBackward",
  typeId: -1,
  factory: diodeBackwardFactory,
  pinLayout: buildDiodeBackwardPinDeclarations(),
  propertyDefs: DIODE_PROPERTY_DEFS,
  attributeMap: DIODE_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.PLD,
  helpText:
    "DiodeBackward- backward diode for wired-AND PLD arrays.\n" +
    "in=1 â†’ out=1; in=0 â†’ out=0. Requires pull-up on output net.\n" +
    "blown=true permanently opens the diode.",
  models: {
    digital: {
      executeFn: executeDiodeBackward,
      inputSchema: ["in"],
      outputSchema: ["out"],
      defaultDelay: 0,
    },
  },
};
