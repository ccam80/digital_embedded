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
 *   - When in=1 → out drives 1; when in=0 → out is high-Z.
 *   - Requires a pull-down resistor on the output net.
 *
 * DiodeBackward: unidirectional diode driving a pull-up output net (wired-AND).
 *   - Single input pin "in", single bidirectional output "out".
 *   - When in=1 → out drives 1 (contributes high to pull-up net).
 *   - When in=0 → out drives 0.
 *   - Requires a pull-up resistor on the output net.
 *
 * In the TS engine the bidirectional / high-Z semantics are handled by the bus
 * resolution layer (Phase 3). The executeFn encodes the drive intent into
 * dedicated output slots: outputSlot 0 = driven value, outputSlot 1 = highZ flag
 * (1 = output is high-Z, 0 = output is actively driven).
 */

import { AbstractCircuitElement } from "../../core/element.js";
import type { RenderContext } from "../../core/renderer-interface.js";
import type { Rect } from "../../core/renderer-interface.js";
import type { Pin, PinDeclaration, Rotation } from "../../core/pin.js";
import { PinDirection, resolvePins, createInverterConfig } from "../../core/pin.js";
import { PropertyBag, PropertyType } from "../../core/properties.js";
import type { PropertyDefinition } from "../../core/properties.js";
import {
  ComponentCategory,
  type AttributeMapping,
  type ComponentDefinition,
  type ComponentLayout,
} from "../../core/registry.js";

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

const COMP_WIDTH = 2;
const COMP_HEIGHT = 2;

// ---------------------------------------------------------------------------
// Shared pin layout helpers
// ---------------------------------------------------------------------------

function buildDiodePinDeclarations(): PinDeclaration[] {
  return [
    {
      direction: PinDirection.BIDIRECTIONAL,
      label: "cathode",
      defaultBitWidth: 1,
      position: { x: 0, y: 1 },
      isNegatable: false,
      isClockCapable: false,
    },
    {
      direction: PinDirection.BIDIRECTIONAL,
      label: "anode",
      defaultBitWidth: 1,
      position: { x: COMP_WIDTH, y: 1 },
      isNegatable: false,
      isClockCapable: false,
    },
  ];
}

function buildUnidirectionalPinDeclarations(): PinDeclaration[] {
  return [
    {
      direction: PinDirection.INPUT,
      label: "in",
      defaultBitWidth: 1,
      position: { x: 0, y: 1 },
      isNegatable: false,
      isClockCapable: false,
    },
    {
      direction: PinDirection.OUTPUT,
      label: "out",
      defaultBitWidth: 1,
      position: { x: COMP_WIDTH, y: 1 },
      isNegatable: false,
      isClockCapable: false,
    },
  ];
}

// ---------------------------------------------------------------------------
// Shared draw helpers
// ---------------------------------------------------------------------------

/**
 * Draw the diode triangle symbol body (cathode on left, anode on right).
 * The triangle tip points right (anode side).
 */
function drawDiodeBody(ctx: RenderContext, label: string): void {
  ctx.setColor("COMPONENT_FILL");
  ctx.drawPath({
    operations: [
      { op: "moveTo", x: 0.3, y: 0.2 },
      { op: "lineTo", x: 1.7, y: 1 },
      { op: "lineTo", x: 0.3, y: 1.8 },
      { op: "closePath" },
    ],
  });

  ctx.setColor("COMPONENT");
  ctx.setLineWidth(1);

  // Triangle outline
  ctx.drawPath({
    operations: [
      { op: "moveTo", x: 0.3, y: 0.2 },
      { op: "lineTo", x: 1.7, y: 1 },
      { op: "lineTo", x: 0.3, y: 1.8 },
      { op: "closePath" },
    ],
  });

  // Cathode bar (vertical line at right/anode tip)
  ctx.drawLine(1.7, 0.2, 1.7, 1.8);

  // Lead lines from pins to body
  ctx.drawLine(0, 1, 0.3, 1);
  ctx.drawLine(1.7, 1, COMP_WIDTH, 1);

  if (label.length > 0) {
    ctx.setColor("TEXT");
    ctx.setFont({ family: "sans-serif", size: 0.8 });
    ctx.drawText(label, COMP_WIDTH / 2, -0.3, { horizontal: "center", vertical: "bottom" });
  }
}

/**
 * Draw a backward diode (cathode on right, triangle pointing left).
 */
function drawDiodeBodyBackward(ctx: RenderContext, label: string): void {
  ctx.setColor("COMPONENT_FILL");
  ctx.drawPath({
    operations: [
      { op: "moveTo", x: 1.7, y: 0.2 },
      { op: "lineTo", x: 0.3, y: 1 },
      { op: "lineTo", x: 1.7, y: 1.8 },
      { op: "closePath" },
    ],
  });

  ctx.setColor("COMPONENT");
  ctx.setLineWidth(1);

  ctx.drawPath({
    operations: [
      { op: "moveTo", x: 1.7, y: 0.2 },
      { op: "lineTo", x: 0.3, y: 1 },
      { op: "lineTo", x: 1.7, y: 1.8 },
      { op: "closePath" },
    ],
  });

  // Cathode bar (vertical line at left/cathode tip)
  ctx.drawLine(0.3, 0.2, 0.3, 1.8);

  // Lead lines
  ctx.drawLine(0, 1, 0.3, 1);
  ctx.drawLine(1.7, 1, COMP_WIDTH, 1);

  if (label.length > 0) {
    ctx.setColor("TEXT");
    ctx.setFont({ family: "sans-serif", size: 0.8 });
    ctx.drawText(label, COMP_WIDTH / 2, -0.3, { horizontal: "center", vertical: "bottom" });
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
// DiodeElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class DiodeElement extends AbstractCircuitElement {
  private readonly _blown: boolean;
  private readonly _pins: readonly Pin[];

  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("Diode", instanceId, position, rotation, mirror, props);

    this._blown = props.getOrDefault<boolean>("blown", false);

    const decls = buildDiodePinDeclarations();
    this._pins = resolvePins(
      decls,
      position,
      rotation,
      createInverterConfig([]),
      { clockPins: new Set<string>() },
    );
  }

  getPins(): readonly Pin[] {
    return this._pins;
  }

  getBoundingBox(): Rect {
    return {
      x: this.position.x,
      y: this.position.y,
      width: COMP_WIDTH,
      height: COMP_HEIGHT,
    };
  }

  draw(ctx: RenderContext): void {
    ctx.save();

    const label = this._properties.getOrDefault<string>("label", "");
    drawDiodeBody(ctx, label);

    if (this._blown) {
      ctx.setColor("WIRE_ERROR");
      ctx.setLineWidth(1);
      ctx.drawLine(0.8, 0.4, 1.2, 1.6);
    }

    ctx.restore();
  }

  isBlown(): boolean {
    return this._blown;
  }

  getHelpText(): string {
    return (
      "Diode — unidirectional current-flow element for PLD wired-OR/AND arrays.\n" +
      "Anode (right) to cathode (left). Active: anode high drives cathode high;\n" +
      "cathode low drives anode low. Use in conjunction with pull-up/pull-down resistors.\n" +
      "blown=true permanently opens the diode."
    );
  }
}

// ---------------------------------------------------------------------------
// DiodeForwardElement — unidirectional forward diode (wired-OR)
// ---------------------------------------------------------------------------

export class DiodeForwardElement extends AbstractCircuitElement {
  private readonly _blown: boolean;
  private readonly _pins: readonly Pin[];

  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("DiodeForward", instanceId, position, rotation, mirror, props);

    this._blown = props.getOrDefault<boolean>("blown", false);

    const decls = buildUnidirectionalPinDeclarations();
    this._pins = resolvePins(
      decls,
      position,
      rotation,
      createInverterConfig([]),
      { clockPins: new Set<string>() },
    );
  }

  getPins(): readonly Pin[] {
    return this._pins;
  }

  getBoundingBox(): Rect {
    return {
      x: this.position.x,
      y: this.position.y,
      width: COMP_WIDTH,
      height: COMP_HEIGHT,
    };
  }

  draw(ctx: RenderContext): void {
    ctx.save();

    const label = this._properties.getOrDefault<string>("label", "");
    drawDiodeBody(ctx, label);

    if (this._blown) {
      ctx.setColor("WIRE_ERROR");
      ctx.setLineWidth(1);
      ctx.drawLine(0.8, 0.4, 1.2, 1.6);
    }

    ctx.restore();
  }

  getHelpText(): string {
    return (
      "DiodeForward — forward diode for wired-OR PLD arrays.\n" +
      "Input 'in' drives output 'out': in=1 → out=1; in=0 → out=high-Z.\n" +
      "Requires a pull-down resistor on the output net.\n" +
      "blown=true permanently opens the diode (output always high-Z)."
    );
  }
}

// ---------------------------------------------------------------------------
// DiodeBackwardElement — unidirectional backward diode (wired-AND)
// ---------------------------------------------------------------------------

export class DiodeBackwardElement extends AbstractCircuitElement {
  private readonly _blown: boolean;
  private readonly _pins: readonly Pin[];

  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("DiodeBackward", instanceId, position, rotation, mirror, props);

    this._blown = props.getOrDefault<boolean>("blown", false);

    const decls = buildUnidirectionalPinDeclarations();
    this._pins = resolvePins(
      decls,
      position,
      rotation,
      createInverterConfig([]),
      { clockPins: new Set<string>() },
    );
  }

  getPins(): readonly Pin[] {
    return this._pins;
  }

  getBoundingBox(): Rect {
    return {
      x: this.position.x,
      y: this.position.y,
      width: COMP_WIDTH,
      height: COMP_HEIGHT,
    };
  }

  draw(ctx: RenderContext): void {
    ctx.save();

    const label = this._properties.getOrDefault<string>("label", "");
    drawDiodeBodyBackward(ctx, label);

    if (this._blown) {
      ctx.setColor("WIRE_ERROR");
      ctx.setLineWidth(1);
      ctx.drawLine(0.8, 0.4, 1.2, 1.6);
    }

    ctx.restore();
  }

  getHelpText(): string {
    return (
      "DiodeBackward — backward diode for wired-AND PLD arrays.\n" +
      "Input 'in' drives output 'out': in=1 → out=1; in=0 → out=0.\n" +
      "Requires a pull-up resistor on the output net.\n" +
      "blown=true permanently opens the diode (output always high-Z)."
    );
  }
}

// ---------------------------------------------------------------------------
// executeDiode — flat simulation function
//
// The bidirectional Diode's bus interaction is handled by Phase 3 bus resolution.
// The executeFn encodes the diode's drive intent:
//   outputSlot 0 (cathode drive value): 1 if anode is high and not blown, else 0
//   outputSlot 1 (cathode highZ flag):  0 if driving, 1 if high-Z
//   outputSlot 2 (anode drive value):   0 if cathode is low and not blown, else 0
//   outputSlot 3 (anode highZ flag):    0 if driving, 1 if high-Z
//
// Input slots: 0=cathodeIn, 1=anodeIn, each encoded as value | (highZ << 16).
// ---------------------------------------------------------------------------

export function executeDiode(index: number, state: Uint32Array, _highZs: Uint32Array, layout: ComponentLayout): void {
  const wt = layout.wiringTable;
  const inputStart = layout.inputOffset(index);
  const outputStart = layout.outputOffset(index);

  const cathodeIn = state[wt[inputStart]];
  const anodeIn = state[wt[inputStart + 1]];

  const cathodeVal = cathodeIn & 0xFFFF;
  const cathodeHighZ = (cathodeIn >>> 16) & 1;
  const anodeVal = anodeIn & 0xFFFF;
  const anodeHighZ = (anodeIn >>> 16) & 1;

  // blown flag stored in output slot 4 as a sentinel (set once by compiler from props)
  const blown = state[wt[outputStart + 4]] !== 0;

  if (blown) {
    // Open circuit — both outputs high-Z
    state[wt[outputStart]] = 0;
    state[wt[outputStart + 1]] = 1;
    state[wt[outputStart + 2]] = 0;
    state[wt[outputStart + 3]] = 1;
    return;
  }

  // Cathode output: driven to 1 if anode is high (not high-Z)
  if (anodeHighZ === 0 && anodeVal !== 0) {
    state[wt[outputStart]] = 1;
    state[wt[outputStart + 1]] = 0;
  } else {
    state[wt[outputStart]] = 0;
    state[wt[outputStart + 1]] = 1;
  }

  // Anode output: driven to 0 if cathode is low (not high-Z)
  if (cathodeHighZ === 0 && cathodeVal === 0) {
    state[wt[outputStart + 2]] = 0;
    state[wt[outputStart + 3]] = 0;
  } else {
    state[wt[outputStart + 2]] = 0;
    state[wt[outputStart + 3]] = 1;
  }
}

// ---------------------------------------------------------------------------
// executeDiodeForward — flat simulation function (wired-OR diode)
//
// in=1 → out=1 (active drive); in=0 → out=high-Z.
// Output encoding: slot 0 = value, slot 1 = highZ (1=highZ).
// ---------------------------------------------------------------------------

export function executeDiodeForward(index: number, state: Uint32Array, _highZs: Uint32Array, layout: ComponentLayout): void {
  const wt = layout.wiringTable;
  const inputStart = layout.inputOffset(index);
  const outputStart = layout.outputOffset(index);

  const blown = state[wt[outputStart + 2]] !== 0;

  if (blown) {
    state[wt[outputStart]] = 0;
    state[wt[outputStart + 1]] = 1;
    return;
  }

  const inVal = state[wt[inputStart]] & 1;
  if (inVal !== 0) {
    state[wt[outputStart]] = 1;
    state[wt[outputStart + 1]] = 0;
  } else {
    state[wt[outputStart]] = 0;
    state[wt[outputStart + 1]] = 1;
  }
}

// ---------------------------------------------------------------------------
// executeDiodeBackward — flat simulation function (wired-AND diode)
//
// in=1 → out=1 (contributes to pull-up); in=0 → out=0 (pulls down).
// ---------------------------------------------------------------------------

export function executeDiodeBackward(index: number, state: Uint32Array, _highZs: Uint32Array, layout: ComponentLayout): void {
  const wt = layout.wiringTable;
  const inputStart = layout.inputOffset(index);
  const outputStart = layout.outputOffset(index);

  const blown = state[wt[outputStart + 2]] !== 0;

  if (blown) {
    state[wt[outputStart]] = 0;
    state[wt[outputStart + 1]] = 1;
    return;
  }

  const inVal = state[wt[inputStart]] & 1;
  state[wt[outputStart]] = inVal;
  state[wt[outputStart + 1]] = 0;
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

export const DiodeDefinition: ComponentDefinition = {
  name: "Diode",
  typeId: -1,
  factory: diodeFactory,
  executeFn: executeDiode,
  pinLayout: buildDiodePinDeclarations(),
  propertyDefs: DIODE_PROPERTY_DEFS,
  attributeMap: DIODE_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.PLD,
  helpText:
    "Diode — bidirectional current-flow element for PLD wired-OR/AND arrays.\n" +
    "Use in conjunction with pull-up/pull-down resistors.\n" +
    "blown=true permanently opens the diode.",
  defaultDelay: 0,
};

export const DiodeForwardDefinition: ComponentDefinition = {
  name: "DiodeForward",
  typeId: -1,
  factory: diodeForwardFactory,
  executeFn: executeDiodeForward,
  pinLayout: buildUnidirectionalPinDeclarations(),
  propertyDefs: DIODE_PROPERTY_DEFS,
  attributeMap: DIODE_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.PLD,
  helpText:
    "DiodeForward — forward diode for wired-OR PLD arrays.\n" +
    "in=1 → out=1; in=0 → out=high-Z. Requires pull-down on output net.\n" +
    "blown=true permanently opens the diode.",
  defaultDelay: 0,
};

export const DiodeBackwardDefinition: ComponentDefinition = {
  name: "DiodeBackward",
  typeId: -1,
  factory: diodeBackwardFactory,
  executeFn: executeDiodeBackward,
  pinLayout: buildUnidirectionalPinDeclarations(),
  propertyDefs: DIODE_PROPERTY_DEFS,
  attributeMap: DIODE_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.PLD,
  helpText:
    "DiodeBackward — backward diode for wired-AND PLD arrays.\n" +
    "in=1 → out=1; in=0 → out=0. Requires pull-up on output net.\n" +
    "blown=true permanently opens the diode.",
  defaultDelay: 0,
};
