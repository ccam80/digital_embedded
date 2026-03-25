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
// Java StepperMotorShape: component body spans x=[-2..3], y=[-1..3]
// Body width = 5 (from -2 to 3), height = 4 (from -1 to 3)
// ---------------------------------------------------------------------------

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
// Unipolar step sequence: [P0, P1, P2, P3, com]
// ---------------------------------------------------------------------------

export const UNIPOLAR_STEP_SEQUENCE: readonly [number, number, number, number][] = [
  [1, 0, 0, 0],
  [0, 1, 0, 0],
  [0, 0, 1, 0],
  [0, 0, 0, 1],
];

// ---------------------------------------------------------------------------
// Pin layout helpers
// Java StepperMotorShape pin positions (grid units, relative to component origin):
//   Bipolar inputs:  A+@(-2,-1), A-@(-2,0), B+@(-2,1), B-@(-2,2)
//   Bipolar outputs: S0@(3,-1), S1@(3,3)
//   Unipolar inputs: P0@(-2,-1), P1@(-2,0), P2@(-2,1), P3@(-2,2), com@(-2,3)
//   Unipolar outputs: S0@(3,-1), S1@(3,3)
// ---------------------------------------------------------------------------

function buildBipolarPinDeclarations(): PinDeclaration[] {
  return [
    { direction: PinDirection.INPUT,  label: "A+",  defaultBitWidth: 1, position: { x: -2, y: -1 }, isNegatable: false, isClockCapable: false },
    { direction: PinDirection.INPUT,  label: "A-",  defaultBitWidth: 1, position: { x: -2, y:  0 }, isNegatable: false, isClockCapable: false },
    { direction: PinDirection.INPUT,  label: "B+",  defaultBitWidth: 1, position: { x: -2, y:  1 }, isNegatable: false, isClockCapable: false },
    { direction: PinDirection.INPUT,  label: "B-",  defaultBitWidth: 1, position: { x: -2, y:  2 }, isNegatable: false, isClockCapable: false },
    { direction: PinDirection.OUTPUT, label: "S0",  defaultBitWidth: 1, position: { x:  3, y: -1 }, isNegatable: false, isClockCapable: false },
    { direction: PinDirection.OUTPUT, label: "S1",  defaultBitWidth: 1, position: { x:  3, y:  3 }, isNegatable: false, isClockCapable: false },
  ];
}

function buildUnipolarPinDeclarations(): PinDeclaration[] {
  return [
    { direction: PinDirection.INPUT,  label: "P0",  defaultBitWidth: 1, position: { x: -2, y: -1 }, isNegatable: false, isClockCapable: false },
    { direction: PinDirection.INPUT,  label: "P1",  defaultBitWidth: 1, position: { x: -2, y:  0 }, isNegatable: false, isClockCapable: false },
    { direction: PinDirection.INPUT,  label: "P2",  defaultBitWidth: 1, position: { x: -2, y:  1 }, isNegatable: false, isClockCapable: false },
    { direction: PinDirection.INPUT,  label: "P3",  defaultBitWidth: 1, position: { x: -2, y:  2 }, isNegatable: false, isClockCapable: false },
    { direction: PinDirection.INPUT,  label: "com", defaultBitWidth: 1, position: { x: -2, y:  3 }, isNegatable: false, isClockCapable: false },
    { direction: PinDirection.OUTPUT, label: "S0",  defaultBitWidth: 1, position: { x:  3, y: -1 }, isNegatable: false, isClockCapable: false },
    { direction: PinDirection.OUTPUT, label: "S1",  defaultBitWidth: 1, position: { x:  3, y:  3 }, isNegatable: false, isClockCapable: false },
  ];
}

// ---------------------------------------------------------------------------
// Shared draw helper
// Java fixture: outer rect (-2,-1.5)→(3,3.5) [5x5], circle cx=0.5,cy=1,r=2 THIN,
// line (0.5,1)→(0.5,-1) NORMAL.
// ---------------------------------------------------------------------------

function drawMotorBody(ctx: RenderContext): void {
  // Outer rectangle: (-2,-1.5) to (3,3.5), width=5, height=5, NORMAL/filled
  ctx.setColor("COMPONENT_FILL");
  ctx.drawRect(-2, -1.5, 5, 5, true);
  ctx.setColor("COMPONENT");
  ctx.setLineWidth(1);
  ctx.drawRect(-2, -1.5, 5, 5, false);

  // Circle at cx=0.5, cy=1, r=2, THIN (thin line weight)
  ctx.setLineWidth(0.5);
  ctx.drawCircle(0.5, 1, 2, false);

  // Pointer line: (0.5,1) to (0.5,-1), NORMAL
  ctx.setLineWidth(1);
  ctx.drawLine(0.5, 1, 0.5, -1);
}

// ---------------------------------------------------------------------------
// StepperMotorBipolarElement
// ---------------------------------------------------------------------------

export class StepperMotorBipolarElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("StepperMotorBipolar", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildBipolarPinDeclarations(), []);
  }

  getBoundingBox(): Rect {
    // Java: rect (-2,-1.5) to (3,3.5) → width=5, height=5
    return { x: this.position.x - 2, y: this.position.y - 1.5, width: 5, height: 5 };
  }

  draw(ctx: RenderContext): void {
    ctx.save();
    drawMotorBody(ctx);
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
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("StepperMotorUnipolar", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildUnipolarPinDeclarations(), []);
  }

  getBoundingBox(): Rect {
    // Java: rect (-2,-1.5) to (3,3.5) → width=5, height=5
    return { x: this.position.x - 2, y: this.position.y - 1.5, width: 5, height: 5 };
  }

  draw(ctx: RenderContext): void {
    ctx.save();
    drawMotorBody(ctx);
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
  _highZs: Uint32Array,
  layout: ComponentLayout,
): void {
  const wt = layout.wiringTable;
  const inputStart = layout.inputOffset(index);
  const aPosHigh = state[wt[inputStart]];
  const aNegHigh = state[wt[inputStart + 1]];
  const bPosHigh = state[wt[inputStart + 2]];
  const bNegHigh = state[wt[inputStart + 3]];

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
  const outBase = layout.outputOffset(index);
  state[wt[outBase]]     = stepIndex & 0x3;       // S0: lower 2 bits
  state[wt[outBase + 1]] = (stepIndex >> 2) & 0x3; // S1: upper 2 bits
}

// ---------------------------------------------------------------------------
// executeStepperMotorUnipolar — detect coil pattern, output step index
// Inputs: P0, P1, P2, P3, com (5 inputs); Outputs: S0, S1
// ---------------------------------------------------------------------------

export function executeStepperMotorUnipolar(
  index: number,
  state: Uint32Array,
  _highZs: Uint32Array,
  layout: ComponentLayout,
): void {
  const wt = layout.wiringTable;
  const inputStart = layout.inputOffset(index);
  const p0 = state[wt[inputStart]];
  const p1 = state[wt[inputStart + 1]];
  const p2 = state[wt[inputStart + 2]];
  const p3 = state[wt[inputStart + 3]];
  // com (inputStart+4) is the common line — not used in step detection

  let stepIndex = 0;
  for (let s = 0; s < UNIPOLAR_STEP_SEQUENCE.length; s++) {
    const [sa, sb, sc, sd] = UNIPOLAR_STEP_SEQUENCE[s];
    if (
      (p0 !== 0) === (sa === 1) &&
      (p1 !== 0) === (sb === 1) &&
      (p2 !== 0) === (sc === 1) &&
      (p3 !== 0) === (sd === 1)
    ) {
      stepIndex = s;
      break;
    }
  }
  const outBase = layout.outputOffset(index);
  state[wt[outBase]]     = stepIndex & 0x3;
  state[wt[outBase + 1]] = (stepIndex >> 2) & 0x3;
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
  pinLayout: buildBipolarPinDeclarations(),
  propertyDefs: STEPPER_MOTOR_PROPERTY_DEFS,
  attributeMap: STEPPER_MOTOR_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.IO,
  helpText:
    "StepperMotorBipolar — bipolar stepper motor simulation.\n" +
    "4 coil inputs (A+, A-, B+, B-). Step position output tracks current step.\n" +
    "Full-step sequence advances one position per valid coil pattern change.",
  models: {
    digital: { executeFn: executeStepperMotorBipolar, inputSchema: ["A+", "A-", "B+", "B-"], outputSchema: ["S0", "S1"] },
  },
};

export const StepperMotorUnipolarDefinition: ComponentDefinition = {
  name: "StepperMotorUnipolar",
  typeId: -1,
  factory: unipolarFactory,
  pinLayout: buildUnipolarPinDeclarations(),
  propertyDefs: STEPPER_MOTOR_PROPERTY_DEFS,
  attributeMap: STEPPER_MOTOR_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.IO,
  helpText:
    "StepperMotorUnipolar — unipolar stepper motor simulation.\n" +
    "4 coil inputs (A, B, C, D). Step position output tracks current step.\n" +
    "Full-step sequence advances one position per valid coil pattern change.",
  models: {
    digital: { executeFn: executeStepperMotorUnipolar, inputSchema: ["P0", "P1", "P2", "P3", "com"], outputSchema: ["S0", "S1"] },
  },
};
