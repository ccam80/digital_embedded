/**
 * Reset component — during initialization, output is held low (or high if inverted).
 * After init, output transitions to its post-reset state.
 *
 * Based on Digital's Java implementation: the Reset element has one output pin.
 * During the init phase, it holds the output in the reset state. After init,
 * the engine calls clearReset() and the output transitions.
 *
 * internalStateCount: 1 (init flag — 0 = in init phase, 1 = init complete)
 *
 * Properties:
 *   - invertOutput: invert the output polarity (default false)
 *   - label: label for identification (default "")
 *
 * Pin layout:
 *   0: Reset (output, 1-bit)
 */

import { AbstractCircuitElement } from "../../core/element.js";
import type { RenderContext } from "../../core/renderer-interface.js";
import type { Rect } from "../../core/renderer-interface.js";
import type { Pin, PinDeclaration, Rotation } from "../../core/pin.js";
import {
  PinDirection,
  createInverterConfig,
  resolvePins,
} from "../../core/pin.js";
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

const COMP_WIDTH = 3;
const COMP_HEIGHT = 3;

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

export function buildResetPinDeclarations(): PinDeclaration[] {
  const resetPin: PinDeclaration = {
    direction: PinDirection.OUTPUT,
    label: "Reset",
    defaultBitWidth: 1,
    position: { x: COMP_WIDTH, y: Math.floor(COMP_HEIGHT / 2) },
    isNegatable: false,
    isClockCapable: false,
  };

  return [resetPin];
}

// ---------------------------------------------------------------------------
// ResetElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class ResetElement extends AbstractCircuitElement {
  private readonly _invertOutput: boolean;
  private readonly _pins: readonly Pin[];

  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("Reset", instanceId, position, rotation, mirror, props);

    this._invertOutput = props.getOrDefault<boolean>("invertOutput", false);

    const decls = buildResetPinDeclarations();
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

    ctx.setColor("COMPONENT_FILL");
    ctx.drawRect(0, 0, COMP_WIDTH, COMP_HEIGHT, true);
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);
    ctx.drawRect(0, 0, COMP_WIDTH, COMP_HEIGHT, false);

    ctx.setColor("TEXT");
    ctx.setFont({ family: "sans-serif", size: 0.8, weight: "bold" });
    ctx.drawText("RST", COMP_WIDTH / 2, COMP_HEIGHT / 2, {
      horizontal: "center",
      vertical: "middle",
    });

    if (this._invertOutput) {
      ctx.drawCircle(COMP_WIDTH + 0.3, COMP_HEIGHT / 2, 0.3, false);
    }

    ctx.restore();
  }

  getHelpText(): string {
    return (
      "Reset — output is held in reset state during initialization.\n" +
      "After init, output transitions to its post-reset value.\n" +
      `Output polarity: ${this._invertOutput ? "inverted (active-low reset)" : "normal (active-high reset)"}.`
    );
  }
}

// ---------------------------------------------------------------------------
// executeReset — flat simulation function
//
// Uses internal state slot 0 as the init flag.
//   state[stateOffset+0] = 0: in init phase, output = !invertOutput (reset active)
//   state[stateOffset+0] = 1: init complete, output = invertOutput (reset released)
//
// The engine sets state[stateOffset+0] = 1 after the init phase completes.
//
// For this flat function, we read the output polarity from the output slot
// directly. The engine initialises the output to the reset value before
// simulation starts.
//
// Pin layout:
//   No inputs
//   output 0: Reset signal
// ---------------------------------------------------------------------------

export function executeReset(
  index: number,
  state: Uint32Array,
  _highZs: Uint32Array,
  layout: ComponentLayout,
): void {
  // Reset is a source component: its output is managed by the engine's
  // init/clear-reset protocol. The executeFn is a no-op — the engine
  // writes the output directly via the init sequence.
  // This satisfies the interface requirement while the engine handles
  // the actual reset/release logic.
  const outIdx = layout.outputOffset(index);
  // Preserve whatever value the engine has written — do not overwrite.
  void state[outIdx];
}

// ---------------------------------------------------------------------------
// RESET_ATTRIBUTE_MAPPINGS
// ---------------------------------------------------------------------------

export const RESET_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  {
    xmlName: "invertOutput",
    propertyKey: "invertOutput",
    convert: (v) => v === "true",
  },
  {
    xmlName: "Label",
    propertyKey: "label",
    convert: (v) => v,
  },
];

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const RESET_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "invertOutput",
    type: PropertyType.BOOLEAN,
    label: "Invert Output",
    defaultValue: false,
    description: "Invert the output polarity (active-low reset)",
  },
  {
    key: "label",
    type: PropertyType.STRING,
    label: "Label",
    defaultValue: "",
    description: "Optional label for identification",
  },
];

// ---------------------------------------------------------------------------
// ResetDefinition
// ---------------------------------------------------------------------------

function resetFactory(props: PropertyBag): ResetElement {
  return new ResetElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const ResetDefinition: ComponentDefinition = {
  name: "Reset",
  typeId: -1,
  factory: resetFactory,
  executeFn: executeReset,
  pinLayout: buildResetPinDeclarations(),
  propertyDefs: RESET_PROPERTY_DEFS,
  attributeMap: RESET_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.WIRING,
  helpText:
    "Reset — output held in reset state during init, then released.\n" +
    "Used to reset sequential circuits to a known state at startup.",
};
