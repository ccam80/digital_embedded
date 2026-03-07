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
 *     C{n} — common terminal
 *     T{n} — throw (normally open, connects when coil energised)
 *     R{n} — rest (normally closed, connects when coil de-energised)
 *
 * internalStateCount: 1 (energised flag, read by bus resolver)
 *
 * Ported from:
 *   ref/Digital/src/main/java/de/neemann/digital/core/switching/RelayDT.java
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

const COMP_WIDTH = 4;
const POLE_HEIGHT = 3;
const COIL_HEIGHT = 2;

function componentHeight(poles: number): number {
  return Math.max(poles * POLE_HEIGHT, COIL_HEIGHT) + COIL_HEIGHT;
}

// ---------------------------------------------------------------------------
// Pin layout helper
// ---------------------------------------------------------------------------

function buildRelayDTPins(poles: number, bitWidth: number): PinDeclaration[] {
  const decls: PinDeclaration[] = [];

  // Coil input pins at top
  decls.push({
    direction: PinDirection.INPUT,
    label: "in1",
    defaultBitWidth: 1,
    position: { x: 0, y: 0 },
    isNegatable: false,
    isClockCapable: false,
  });
  decls.push({
    direction: PinDirection.INPUT,
    label: "in2",
    defaultBitWidth: 1,
    position: { x: COMP_WIDTH, y: 0 },
    isNegatable: false,
    isClockCapable: false,
  });

  // Contact poles: C (common, left), T (throw, right top), R (rest, right bottom)
  for (let p = 0; p < poles; p++) {
    const py = COIL_HEIGHT + p * POLE_HEIGHT;
    decls.push({
      direction: PinDirection.BIDIRECTIONAL,
      label: `C${p + 1}`,
      defaultBitWidth: bitWidth,
      position: { x: 0, y: py + 1 },
      isNegatable: false,
      isClockCapable: false,
    });
    decls.push({
      direction: PinDirection.BIDIRECTIONAL,
      label: `T${p + 1}`,
      defaultBitWidth: bitWidth,
      position: { x: COMP_WIDTH, y: py },
      isNegatable: false,
      isClockCapable: false,
    });
    decls.push({
      direction: PinDirection.BIDIRECTIONAL,
      label: `R${p + 1}`,
      defaultBitWidth: bitWidth,
      position: { x: COMP_WIDTH, y: py + 2 },
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
  private readonly _poles: number;
  private readonly _bitWidth: number;
  private readonly _pins: readonly Pin[];

  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("RelayDT", instanceId, position, rotation, mirror, props);
    this._poles = props.getOrDefault<number>("poles", 1);
    this._bitWidth = props.getOrDefault<number>("bitWidth", 1);
    this._pins = resolvePins(
      buildRelayDTPins(this._poles, this._bitWidth),
      position,
      rotation,
      createInverterConfig([]),
      { clockPins: new Set<string>() },
      this._bitWidth,
    );
  }

  getPins(): readonly Pin[] {
    return this._pins;
  }

  getBoundingBox(): Rect {
    const h = componentHeight(this._poles);
    return { x: this.position.x, y: this.position.y, width: COMP_WIDTH, height: h };
  }

  draw(ctx: RenderContext): void {
    const poles = this._poles;

    ctx.save();
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);

    // Coil symbol: rectangle at top
    ctx.drawRect(0.5, 0, COMP_WIDTH - 1, COIL_HEIGHT, false);
    ctx.setColor("TEXT");
    ctx.setFont({ family: "sans-serif", size: 0.7 });
    ctx.drawText("DT", COMP_WIDTH / 2, COIL_HEIGHT / 2, {
      horizontal: "center",
      vertical: "middle",
    });

    ctx.setColor("COMPONENT");

    // Contact poles: C on left, T (throw) on right top, R (rest) on right bottom
    for (let p = 0; p < poles; p++) {
      const py = COIL_HEIGHT + p * POLE_HEIGHT;
      // Common arm: line from C toward T position (de-energised = toward R)
      ctx.drawLine(0, py + 1, COMP_WIDTH - 0.5, py + 2); // de-energised position toward R
      // T pin marker
      ctx.drawLine(COMP_WIDTH - 0.5, py, COMP_WIDTH, py);
      // R pin marker
      ctx.drawLine(COMP_WIDTH - 0.5, py + 2, COMP_WIDTH, py + 2);
    }

    const label = this._properties.getOrDefault<string>("label", "");
    if (label.length > 0) {
      ctx.setColor("TEXT");
      ctx.setFont({ family: "sans-serif", size: 0.8 });
      ctx.drawText(label, COMP_WIDTH / 2, componentHeight(poles) + 0.3, {
        horizontal: "center",
        vertical: "top",
      });
    }

    ctx.restore();
  }

  getHelpText(): string {
    return (
      "RelayDT (SPDT) — coil-controlled double-throw contact switch.\n" +
      "Coil terminals in1 and in2: when current flows (in1 XOR in2 nonzero), C connects to T.\n" +
      "When de-energised, C connects to R (rest/normally-closed position).\n" +
      "Contact routing is managed by the bus resolution subsystem."
    );
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
  const inBase = layout.inputOffset(index);
  const stBase = (layout as RelayDTLayout).stateOffset(index);

  const in1 = state[inBase] & 1;
  const in2 = state[inBase + 1] & 1;

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
  executeFn: executeRelayDT,
  pinLayout: buildRelayDTPins(1, 1),
  propertyDefs: RELAY_DT_PROPERTY_DEFS,
  attributeMap: RELAY_DT_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.SWITCHING,
  helpText: "RelayDT (SPDT) — coil-controlled double-throw contact switch. C connects to T when energised, R when de-energised.",
  stateSlotCount: 1,
  defaultDelay: 0,
};
