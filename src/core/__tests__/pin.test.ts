import { describe, it, expect } from "vitest";
import {
  PinDirection,
  createInverterConfig,
  isPinInverted,
  makePin,
  rotatePoint,
  translatePoint,
  resolvePins,
  layoutPinsOnFace,
  standardGatePinLayout,
} from "../pin.js";
import type {
  Pin,
  PinDeclaration,
  Rotation,
} from "../pin.js";

// ---------------------------------------------------------------------------
// PinDirection enum
// ---------------------------------------------------------------------------

describe("PinDirection", () => {
  it("has INPUT, OUTPUT, BIDIRECTIONAL values", () => {
    expect(PinDirection.INPUT).toBe("INPUT");
    expect(PinDirection.OUTPUT).toBe("OUTPUT");
    expect(PinDirection.BIDIRECTIONAL).toBe("BIDIRECTIONAL");
  });
});

// ---------------------------------------------------------------------------
// InverterConfig
// ---------------------------------------------------------------------------

describe("InverterConfig", () => {
  it("createInverterConfig creates a config with the given labels inverted", () => {
    const config = createInverterConfig(["A", "B"]);
    expect(isPinInverted(config, "A")).toBe(true);
    expect(isPinInverted(config, "B")).toBe(true);
    expect(isPinInverted(config, "C")).toBe(false);
  });

  it("empty inverter config inverts nothing", () => {
    const config = createInverterConfig([]);
    expect(isPinInverted(config, "A")).toBe(false);
  });

  it("invertedPins is a ReadonlySet", () => {
    const config = createInverterConfig(["X"]);
    expect(config.invertedPins).toBeInstanceOf(Set);
    expect(config.invertedPins.has("X")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// makePin
// ---------------------------------------------------------------------------

describe("makePin", () => {
  const decl: PinDeclaration = {
    direction: PinDirection.INPUT,
    label: "A",
    defaultBitWidth: 1,
    position: { x: 0, y: 1 },
    isNegatable: true,
    isClockCapable: false,
  };

  it("creates a Pin with expected fields", () => {
    const config = createInverterConfig([]);
    const pin = makePin(decl, { x: 5, y: 6 }, config);

    expect(pin.direction).toBe(PinDirection.INPUT);
    expect(pin.label).toBe("A");
    expect(pin.bitWidth).toBe(1);
    expect(pin.position).toEqual({ x: 5, y: 6 });
    expect(pin.isNegated).toBe(false);
    expect(pin.isClock).toBe(false);
  });

  it("isNegated is true when pin label is in inverter config and pin is negatable", () => {
    const config = createInverterConfig(["A"]);
    const pin = makePin(decl, { x: 0, y: 0 }, config);
    expect(pin.isNegated).toBe(true);
  });

  it("isNegated is false even if label is inverted when isNegatable is false", () => {
    const nonNegatableDecl: PinDeclaration = { ...decl, isNegatable: false };
    const config = createInverterConfig(["A"]);
    const pin = makePin(nonNegatableDecl, { x: 0, y: 0 }, config);
    expect(pin.isNegated).toBe(false);
  });

  it("uses provided bitWidth over defaultBitWidth", () => {
    const config = createInverterConfig([]);
    const pin = makePin(decl, { x: 0, y: 0 }, config, 8);
    expect(pin.bitWidth).toBe(8);
  });

  it("falls back to defaultBitWidth when bitWidth is not provided", () => {
    const decl4bit: PinDeclaration = { ...decl, defaultBitWidth: 4 };
    const config = createInverterConfig([]);
    const pin = makePin(decl4bit, { x: 0, y: 0 }, config);
    expect(pin.bitWidth).toBe(4);
  });

  it("isClock reflects isClockCapable from declaration", () => {
    const clockDecl: PinDeclaration = { ...decl, isClockCapable: true };
    const config = createInverterConfig([]);
    const pin = makePin(clockDecl, { x: 0, y: 0 }, config);
    expect(pin.isClock).toBe(true);
  });

  it("Pin has no netId or signalValue properties (Decision 6)", () => {
    const config = createInverterConfig([]);
    const pin = makePin(decl, { x: 0, y: 0 }, config) as Pin & Record<string, unknown>;
    expect("netId" in pin).toBe(false);
    expect("signalValue" in pin).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// rotatePoint
// ---------------------------------------------------------------------------

describe("rotatePoint", () => {
  it("rotation 0 leaves point unchanged", () => {
    expect(rotatePoint({ x: 3, y: 4 }, 0)).toEqual({ x: 3, y: 4 });
  });

  it("rotation 1 (90° CW with y-down): (x,y) → (-y, x)", () => {
    expect(rotatePoint({ x: 3, y: 4 }, 1)).toEqual({ x: -4, y: 3 });
  });

  it("rotation 2 (180°): (x,y) → (-x, -y)", () => {
    expect(rotatePoint({ x: 3, y: 4 }, 2)).toEqual({ x: -3, y: -4 });
  });

  it("rotation 3 (270° CW): (x,y) → (y, -x)", () => {
    expect(rotatePoint({ x: 3, y: 4 }, 3)).toEqual({ x: 4, y: -3 });
  });

  it("four rotations return to origin", () => {
    const p = { x: 5, y: 2 };
    let result = p;
    for (let r = 0; r < 4; r++) {
      result = rotatePoint(result, 1 as Rotation);
    }
    expect(result).toEqual(p);
  });

  it("rotation of origin stays at origin for all rotations", () => {
    const origin = { x: 0, y: 0 };
    for (const r of [0, 1, 2, 3] as Rotation[]) {
      expect(rotatePoint(origin, r)).toEqual({ x: 0, y: 0 });
    }
  });
});

// ---------------------------------------------------------------------------
// translatePoint
// ---------------------------------------------------------------------------

describe("translatePoint", () => {
  it("adds offset to point", () => {
    expect(translatePoint({ x: 1, y: 2 }, { x: 10, y: 20 })).toEqual({ x: 11, y: 22 });
  });

  it("zero offset leaves point unchanged", () => {
    expect(translatePoint({ x: 5, y: 7 }, { x: 0, y: 0 })).toEqual({ x: 5, y: 7 });
  });

  it("negative offset works correctly", () => {
    expect(translatePoint({ x: 5, y: 7 }, { x: -3, y: -2 })).toEqual({ x: 2, y: 5 });
  });
});

// ---------------------------------------------------------------------------
// resolvePins
// ---------------------------------------------------------------------------

describe("resolvePins", () => {
  const decls: PinDeclaration[] = [
    {
      direction: PinDirection.INPUT,
      label: "A",
      defaultBitWidth: 1,
      position: { x: 0, y: 1 },
      isNegatable: true,
      isClockCapable: false,
    },
    {
      direction: PinDirection.OUTPUT,
      label: "Q",
      defaultBitWidth: 1,
      position: { x: 2, y: 1 },
      isNegatable: false,
      isClockCapable: false,
    },
  ];

  it("resolves pins with identity rotation at given origin", () => {
    const config = createInverterConfig([]);
    const pins = resolvePins(decls, { x: 10, y: 20 }, 0, config);
    expect(pins).toHaveLength(2);
    expect(pins[0].position).toEqual({ x: 10, y: 21 });
    expect(pins[1].position).toEqual({ x: 12, y: 21 });
  });

  it("resolves pins with 180° rotation", () => {
    const config = createInverterConfig([]);
    const pins = resolvePins(decls, { x: 10, y: 20 }, 2, config);
    // decl[0] pos (0,1) rotated 180° → (0,-1), translated to (10, 19)
    expect(pins[0].position).toEqual({ x: 10, y: 19 });
    // decl[1] pos (2,1) rotated 180° → (-2,-1), translated to (8, 19)
    expect(pins[1].position).toEqual({ x: 8, y: 19 });
  });

  it("applies inverter config to resolved pins", () => {
    const config = createInverterConfig(["A"]);
    const pins = resolvePins(decls, { x: 0, y: 0 }, 0, config);
    expect(pins[0].isNegated).toBe(true);
    expect(pins[1].isNegated).toBe(false);
  });

  it("applies custom bitWidth to all pins", () => {
    const config = createInverterConfig([]);
    const pins = resolvePins(decls, { x: 0, y: 0 }, 0, config, 4);
    expect(pins[0].bitWidth).toBe(4);
    expect(pins[1].bitWidth).toBe(4);
  });

  it("returns empty array for empty declarations", () => {
    const config = createInverterConfig([]);
    const pins = resolvePins([], { x: 0, y: 0 }, 0, config);
    expect(pins).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// layoutPinsOnFace
// ---------------------------------------------------------------------------

describe("layoutPinsOnFace", () => {
  it("returns empty array for 0 pins", () => {
    expect(layoutPinsOnFace("west", 0, 4, 4)).toHaveLength(0);
  });

  it("single pin on west face is at x=0", () => {
    const positions = layoutPinsOnFace("west", 1, 4, 4);
    expect(positions).toHaveLength(1);
    expect(positions[0].x).toBe(0);
  });

  it("single pin on east face is at x=componentW", () => {
    const positions = layoutPinsOnFace("east", 1, 4, 4);
    expect(positions).toHaveLength(1);
    expect(positions[0].x).toBe(4);
  });

  it("single pin on north face is at y=0", () => {
    const positions = layoutPinsOnFace("north", 1, 4, 4);
    expect(positions).toHaveLength(1);
    expect(positions[0].y).toBe(0);
  });

  it("single pin on south face is at y=componentH", () => {
    const positions = layoutPinsOnFace("south", 1, 4, 4);
    expect(positions).toHaveLength(1);
    expect(positions[0].y).toBe(4);
  });

  it("two pins on west face have sequential y positions", () => {
    const positions = layoutPinsOnFace("west", 2, 4, 4);
    expect(positions).toHaveLength(2);
    expect(positions[0].x).toBe(0);
    expect(positions[1].x).toBe(0);
    expect(positions[1].y - positions[0].y).toBe(1);
  });

  it("two pins on east face have sequential y positions", () => {
    const positions = layoutPinsOnFace("east", 2, 4, 4);
    expect(positions[0].x).toBe(4);
    expect(positions[1].y - positions[0].y).toBe(1);
  });

  it("two pins on north face have sequential x positions", () => {
    const positions = layoutPinsOnFace("north", 2, 4, 4);
    expect(positions[0].y).toBe(0);
    expect(positions[1].x - positions[0].x).toBe(1);
  });

  it("two pins on south face have sequential x positions", () => {
    const positions = layoutPinsOnFace("south", 2, 4, 4);
    expect(positions[0].y).toBe(4);
    expect(positions[1].x - positions[0].x).toBe(1);
  });

  it("four pins on west face span the full height", () => {
    const positions = layoutPinsOnFace("west", 4, 4, 4);
    expect(positions).toHaveLength(4);
    // All x=0
    positions.forEach((p) => expect(p.x).toBe(0));
    // y values are consecutive
    for (let i = 1; i < positions.length; i++) {
      expect(positions[i].y - positions[i - 1].y).toBe(1);
    }
  });
});

// ---------------------------------------------------------------------------
// standardGatePinLayout
// ---------------------------------------------------------------------------

describe("standardGatePinLayout", () => {
  it("produces the right number of pins (inputs + 1 output)", () => {
    const decls = standardGatePinLayout(["A", "B"], "Q", 4, 4);
    expect(decls).toHaveLength(3);
  });

  it("input pins have INPUT direction", () => {
    const decls = standardGatePinLayout(["A", "B"], "Q", 4, 4);
    const inputs = decls.filter((d) => d.direction === PinDirection.INPUT);
    expect(inputs).toHaveLength(2);
    expect(inputs[0].label).toBe("A");
    expect(inputs[1].label).toBe("B");
  });

  it("output pin has OUTPUT direction", () => {
    const decls = standardGatePinLayout(["A", "B"], "Q", 4, 4);
    const outputs = decls.filter((d) => d.direction === PinDirection.OUTPUT);
    expect(outputs).toHaveLength(1);
    expect(outputs[0].label).toBe("Q");
  });

  it("input pins are on the west face (x=0)", () => {
    const decls = standardGatePinLayout(["A", "B"], "Q", 4, 4);
    const inputs = decls.filter((d) => d.direction === PinDirection.INPUT);
    inputs.forEach((d) => expect(d.position.x).toBe(0));
  });

  it("output pin is on the east face (x=componentW)", () => {
    const decls = standardGatePinLayout(["A", "B"], "Q", 4, 4);
    const output = decls.find((d) => d.direction === PinDirection.OUTPUT)!;
    expect(output.position.x).toBe(4);
  });

  it("input pins are negatable, output pin is not", () => {
    const decls = standardGatePinLayout(["A", "B"], "Q", 4, 4);
    const inputs = decls.filter((d) => d.direction === PinDirection.INPUT);
    const output = decls.find((d) => d.direction === PinDirection.OUTPUT)!;
    inputs.forEach((d) => expect(d.isNegatable).toBe(true));
    expect(output.isNegatable).toBe(false);
  });

  it("uses provided defaultBitWidth", () => {
    const decls = standardGatePinLayout(["A"], "Q", 4, 4, 8);
    decls.forEach((d) => expect(d.defaultBitWidth).toBe(8));
  });

  it("defaults to bitWidth 1 when not specified", () => {
    const decls = standardGatePinLayout(["A"], "Q", 4, 4);
    decls.forEach((d) => expect(d.defaultBitWidth).toBe(1));
  });
});

// ---------------------------------------------------------------------------
// Full integration: PinDeclaration → resolvePins → Pin shape check
// ---------------------------------------------------------------------------

describe("Pin system integration", () => {
  it("standard 2-input gate with inversion on A resolves correctly at rotation 0", () => {
    const decls = standardGatePinLayout(["A", "B"], "Q", 4, 4);
    const config = createInverterConfig(["A"]);
    const origin = { x: 10, y: 10 };
    const pins = resolvePins(decls, origin, 0, config);

    const pinA = pins.find((p) => p.label === "A")!;
    const pinB = pins.find((p) => p.label === "B")!;
    const pinQ = pins.find((p) => p.label === "Q")!;

    expect(pinA.direction).toBe(PinDirection.INPUT);
    expect(pinA.isNegated).toBe(true);
    expect(pinA.position.x).toBe(10); // west face x=0 + origin.x

    expect(pinB.direction).toBe(PinDirection.INPUT);
    expect(pinB.isNegated).toBe(false);

    expect(pinQ.direction).toBe(PinDirection.OUTPUT);
    expect(pinQ.isNegated).toBe(false);
    expect(pinQ.position.x).toBe(14); // east face x=4 + origin.x
  });

  it("rotating a gate 180° swaps input/output sides", () => {
    const decls = standardGatePinLayout(["A"], "Q", 4, 2);
    const config = createInverterConfig([]);
    const origin = { x: 5, y: 5 };

    const pins0 = resolvePins(decls, origin, 0, config);
    const pins2 = resolvePins(decls, origin, 2, config);

    const inputAt0 = pins0.find((p) => p.label === "A")!;
    const inputAt2 = pins2.find((p) => p.label === "A")!;
    const outputAt0 = pins0.find((p) => p.label === "Q")!;
    const outputAt2 = pins2.find((p) => p.label === "Q")!;

    // At rotation 0, input is on west (lower x); at rotation 2, positions flip
    expect(inputAt0.position.x).toBeLessThan(outputAt0.position.x);
    expect(inputAt2.position.x).toBeGreaterThan(outputAt2.position.x);
  });
});
