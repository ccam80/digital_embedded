/**
 * StepperMotor components — bipolar and unipolar stepper motor simulation.
 *
 * Stepper motors receive coil drive signals and advance a position counter
 * based on the step sequence. The current step position is stored as
 * internalStateCount: 1 (step position).
 *
 * StepperMotorBipolar: 4 coil inputs (A+, A-, B+, B-)
 * StepperMotorUnipolar: 4 coil inputs (A, B, C, D)
 *
 * Both motors:
 *   - Track current step position (0–3 for full-step, 0–7 for half-step)
 *   - Output current step position on a bus output for display
 *   - Interactive: position updates when coil pattern changes
 *
 * Full-step sequence (bipolar):
 *   Step 0: A+=1, A-=0, B+=1, B-=0
 *   Step 1: A+=0, A-=1, B+=1, B-=0
 *   Step 2: A+=0, A-=1, B+=0, B-=1
 *   Step 3: A+=1, A-=0, B+=0, B-=1
 */

import { AbstractCircuitElement } from "../../core/element.js";
import type { RenderContext } from "../../core/renderer-interface.js";
import type { Rect } from "../../core/renderer-interface.js";
import type { Pin, PinDeclaration, Rotation } from "../../core/pin.js";
import {
  PinDirection,
  createInverterConfig,
  resolvePins,
  layoutPinsOnFace,
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

const COMP_WIDTH = 4;
const COMP_HEIGHT = 5;

// ---------------------------------------------------------------------------
// Bipolar step sequence: [A+, A-, B+, B-]
// ---------------------------------------------------------------------------

export const BIPOLAR_STEP_SEQUENCE: readonly [number, number, number, number][] = [
  [1, 0, 1, 0],
  [0, 1, 1, 0],
  [0, 1, 0, 1],
  [1, 0, 0, 1],
];

// ---------------------------------------------------------------------------
// Unipolar step sequence: [A, B, C, D]
// ---------------------------------------------------------------------------

export const UNIPOLAR_STEP_SEQUENCE: readonly [number, number, number, number][] = [
  [1, 0, 0, 0],
  [0, 1, 0, 0],
  [0, 0, 1, 0],
  [0, 0, 0, 1],
];

// ---------------------------------------------------------------------------
// Pin layout helpers
// ---------------------------------------------------------------------------

function buildBipolarPinDeclarations(): PinDeclaration[] {
  const inputPositions = layoutPinsOnFace("west", 4, COMP_WIDTH, COMP_HEIGHT);
  const outputPositions = layoutPinsOnFace("east", 1, COMP_WIDTH, COMP_HEIGHT);
  const labels = ["A+", "A-", "B+", "B-"];
  const inputs: PinDeclaration[] = labels.map((label, i) => ({
    direction: PinDirection.INPUT,
    label,
    defaultBitWidth: 1,
    position: inputPositions[i],
    isNegatable: false,
    isClockCapable: false,
  }));
  return [
    ...inputs,
    {
      direction: PinDirection.OUTPUT,
      label: "step",
      defaultBitWidth: 4,
      position: outputPositions[0],
      isNegatable: false,
      isClockCapable: false,
    },
  ];
}

function buildUnipolarPinDeclarations(): PinDeclaration[] {
  const inputPositions = layoutPinsOnFace("west", 4, COMP_WIDTH, COMP_HEIGHT);
  const outputPositions = layoutPinsOnFace("east", 1, COMP_WIDTH, COMP_HEIGHT);
  const labels = ["A", "B", "C", "D"];
  const inputs: PinDeclaration[] = labels.map((label, i) => ({
    direction: PinDirection.INPUT,
    label,
    defaultBitWidth: 1,
    position: inputPositions[i],
    isNegatable: false,
    isClockCapable: false,
  }));
  return [
    ...inputs,
    {
      direction: PinDirection.OUTPUT,
      label: "step",
      defaultBitWidth: 4,
      position: outputPositions[0],
      isNegatable: false,
      isClockCapable: false,
    },
  ];
}

// ---------------------------------------------------------------------------
// Shared draw helper
// ---------------------------------------------------------------------------

function drawMotorBody(ctx: RenderContext, label: string, typeLabel: string): void {
  const cx = COMP_WIDTH / 2;
  const cy = COMP_HEIGHT / 2;

  ctx.setColor("COMPONENT_FILL");
  ctx.drawRect(0, 0, COMP_WIDTH, COMP_HEIGHT, true);
  ctx.setColor("COMPONENT");
  ctx.setLineWidth(1);
  ctx.drawRect(0, 0, COMP_WIDTH, COMP_HEIGHT, false);

  // Motor circle symbol
  ctx.drawCircle(cx, cy, 1.2, false);

  // "M" label inside
  ctx.setColor("TEXT");
  ctx.setFont({ family: "sans-serif", size: 0.8, weight: "bold" });
  ctx.drawText("M", cx, cy, { horizontal: "center", vertical: "middle" });

  // Type label below
  ctx.setFont({ family: "sans-serif", size: 0.5 });
  ctx.drawText(typeLabel, cx, COMP_HEIGHT + 0.3, { horizontal: "center", vertical: "top" });

  if (label.length > 0) {
    ctx.drawText(label, cx, -0.3, { horizontal: "center", vertical: "bottom" });
  }
}

// ---------------------------------------------------------------------------
// StepperMotorBipolarElement
// ---------------------------------------------------------------------------

export class StepperMotorBipolarElement extends AbstractCircuitElement {
  private readonly _label: string;
  private readonly _pins: readonly Pin[];

  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("StepperMotorBipolar", instanceId, position, rotation, mirror, props);
    this._label = props.getOrDefault<string>("label", "");
    const decls = buildBipolarPinDeclarations();
    this._pins = resolvePins(
      decls,
      position,
      rotation,
      createInverterConfig([]),
      { clockPins: new Set<string>() },
      1,
    );
  }

  getPins(): readonly Pin[] {
    return this._pins;
  }

  getBoundingBox(): Rect {
    return { x: this.position.x, y: this.position.y, width: COMP_WIDTH, height: COMP_HEIGHT };
  }

  draw(ctx: RenderContext): void {
    ctx.save();
    drawMotorBody(ctx, this._label, "Bipolar");
    ctx.restore();
  }

  getHelpText(): string {
    return (
      "StepperMotorBipolar — bipolar stepper motor simulation.\n" +
      "4 coil inputs (A+, A-, B+, B-). Step position output tracks current step.\n" +
      "Full-step sequence advances one position per valid coil pattern change."
    );
  }
}

// ---------------------------------------------------------------------------
// StepperMotorUnipolarElement
// ---------------------------------------------------------------------------

export class StepperMotorUnipolarElement extends AbstractCircuitElement {
  private readonly _label: string;
  private readonly _pins: readonly Pin[];

  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("StepperMotorUnipolar", instanceId, position, rotation, mirror, props);
    this._label = props.getOrDefault<string>("label", "");
    const decls = buildUnipolarPinDeclarations();
    this._pins = resolvePins(
      decls,
      position,
      rotation,
      createInverterConfig([]),
      { clockPins: new Set<string>() },
      1,
    );
  }

  getPins(): readonly Pin[] {
    return this._pins;
  }

  getBoundingBox(): Rect {
    return { x: this.position.x, y: this.position.y, width: COMP_WIDTH, height: COMP_HEIGHT };
  }

  draw(ctx: RenderContext): void {
    ctx.save();
    drawMotorBody(ctx, this._label, "Unipolar");
    ctx.restore();
  }

  getHelpText(): string {
    return (
      "StepperMotorUnipolar — unipolar stepper motor simulation.\n" +
      "4 coil inputs (A, B, C, D). Step position output tracks current step.\n" +
      "Full-step sequence advances one position per valid coil pattern change."
    );
  }
}

// ---------------------------------------------------------------------------
// executeStepperMotorBipolar — detect coil pattern, output step index
// ---------------------------------------------------------------------------

export function executeStepperMotorBipolar(
  index: number,
  state: Uint32Array,
  layout: ComponentLayout,
): void {
  const inputStart = layout.inputOffset(index);
  const aPosHigh = state[inputStart];
  const aNegHigh = state[inputStart + 1];
  const bPosHigh = state[inputStart + 2];
  const bNegHigh = state[inputStart + 3];

  let stepIndex = 0;
  for (let s = 0; s < BIPOLAR_STEP_SEQUENCE.length; s++) {
    const [ap, an, bp, bn] = BIPOLAR_STEP_SEQUENCE[s];
    if (
      (aPosHigh !== 0) === (ap === 1) &&
      (aNegHigh !== 0) === (an === 1) &&
      (bPosHigh !== 0) === (bp === 1) &&
      (bNegHigh !== 0) === (bn === 1)
    ) {
      stepIndex = s;
      break;
    }
  }
  state[layout.outputOffset(index)] = stepIndex;
}

// ---------------------------------------------------------------------------
// executeStepperMotorUnipolar — detect coil pattern, output step index
// ---------------------------------------------------------------------------

export function executeStepperMotorUnipolar(
  index: number,
  state: Uint32Array,
  layout: ComponentLayout,
): void {
  const inputStart = layout.inputOffset(index);
  const a = state[inputStart];
  const b = state[inputStart + 1];
  const c = state[inputStart + 2];
  const d = state[inputStart + 3];

  let stepIndex = 0;
  for (let s = 0; s < UNIPOLAR_STEP_SEQUENCE.length; s++) {
    const [sa, sb, sc, sd] = UNIPOLAR_STEP_SEQUENCE[s];
    if (
      (a !== 0) === (sa === 1) &&
      (b !== 0) === (sb === 1) &&
      (c !== 0) === (sc === 1) &&
      (d !== 0) === (sd === 1)
    ) {
      stepIndex = s;
      break;
    }
  }
  state[layout.outputOffset(index)] = stepIndex;
}

// ---------------------------------------------------------------------------
// Attribute mappings
// ---------------------------------------------------------------------------

export const STEPPER_MOTOR_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  {
    xmlName: "Label",
    propertyKey: "label",
    convert: (v) => v,
  },
];

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const STEPPER_MOTOR_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "label",
    type: PropertyType.STRING,
    label: "Label",
    defaultValue: "",
    description: "Label shown above the motor",
  },
];

// ---------------------------------------------------------------------------
// Factory functions
// ---------------------------------------------------------------------------

function bipolarFactory(props: PropertyBag): StepperMotorBipolarElement {
  return new StepperMotorBipolarElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

function unipolarFactory(props: PropertyBag): StepperMotorUnipolarElement {
  return new StepperMotorUnipolarElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

// ---------------------------------------------------------------------------
// ComponentDefinitions
// ---------------------------------------------------------------------------

export const StepperMotorBipolarDefinition: ComponentDefinition = {
  name: "StepperMotorBipolar",
  typeId: -1,
  factory: bipolarFactory,
  executeFn: executeStepperMotorBipolar,
  pinLayout: buildBipolarPinDeclarations(),
  propertyDefs: STEPPER_MOTOR_PROPERTY_DEFS,
  attributeMap: STEPPER_MOTOR_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.IO,
  helpText:
    "StepperMotorBipolar — bipolar stepper motor simulation.\n" +
    "4 coil inputs (A+, A-, B+, B-). Step position output tracks current step.\n" +
    "Full-step sequence advances one position per valid coil pattern change.",
};

export const StepperMotorUnipolarDefinition: ComponentDefinition = {
  name: "StepperMotorUnipolar",
  typeId: -1,
  factory: unipolarFactory,
  executeFn: executeStepperMotorUnipolar,
  pinLayout: buildUnipolarPinDeclarations(),
  propertyDefs: STEPPER_MOTOR_PROPERTY_DEFS,
  attributeMap: STEPPER_MOTOR_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.IO,
  helpText:
    "StepperMotorUnipolar — unipolar stepper motor simulation.\n" +
    "4 coil inputs (A, B, C, D). Step position output tracks current step.\n" +
    "Full-step sequence advances one position per valid coil pattern change.",
};
