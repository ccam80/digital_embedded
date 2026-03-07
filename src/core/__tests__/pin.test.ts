import { describe, it, expect } from "vitest";
import {
  PinDirection,
  createInverterConfig,
  isPinInverted,
  createClockConfig,
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
    const pin = makePin(decl, { x: 5, y: 6 }, config, createClockConfig([]));

    expect(pin.direction).toBe(PinDirection.INPUT);
    expect(pin.label).toBe("A");
    expect(pin.bitWidth).toBe(1);
    expect(pin.position).toEqual({ x: 5, y: 6 });
    expect(pin.isNegated).toBe(false);
    expect(pin.isClock).toBe(false);
  });

  it("isNegated is true when pin label is in inverter config and pin is negatable", () => {
    const config = createInverterConfig(["A"]);
    const pin = makePin(decl, { x: 0, y: 0 }, config, createClockConfig([]));
    expect(pin.isNegated).toBe(true);
  });

  it("isNegated is false even if label is inverted when isNegatable is false", () => {
    const nonNegatableDecl: PinDeclaration = { ...decl, isNegatable: false };
    const config = createInverterConfig(["A"]);
    const pin = makePin(nonNegatableDecl, { x: 0, y: 0 }, config, createClockConfig([]));
    expect(pin.isNegated).toBe(false);
  });

  it("uses provided bitWidth over defaultBitWidth", () => {
    const config = createInverterConfig([]);
    const pin = makePin(decl, { x: 0, y: 0 }, config, createClockConfig([]), 8);
    expect(pin.bitWidth).toBe(8);
  });

  it("falls back to defaultBitWidth when bitWidth is not provided", () => {
    const decl4bit: PinDeclaration = { ...decl, defaultBitWidth: 4 };
    const config = createInverterConfig([]);
    const pin = makePin(decl4bit, { x: 0, y: 0 }, config, createClockConfig([]));
    expect(pin.bitWidth).toBe(4);
  });

  it("isClock is true when pin is clock-capable and label is in clock config", () => {
    const clockDecl: PinDeclaration = { ...decl, isClockCapable: true };
    const config = createInverterConfig([]);
    const pin = makePin(clockDecl, { x: 0, y: 0 }, config, createClockConfig(["A"]));
    expect(pin.isClock).toBe(true);
  });

  it("isClock is false when pin is clock-capable but label is not in clock config", () => {
    const clockDecl: PinDeclaration = { ...decl, isClockCapable: true };
    const config = createInverterConfig([]);
    const pin = makePin(clockDecl, { x: 0, y: 0 }, config, createClockConfig([]));
    expect(pin.isClock).toBe(false);
  });

  it("Pin has no netId or signalValue properties (Decision 6)", () => {
    const config = createInverterConfig([]);
    const pin = makePin(decl, { x: 0, y: 0 }, config, createClockConfig([])) as Pin & Record<string, unknown>;
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

  it("resolves pins with identity rotation (origin ignored)", () => {
    const config = createInverterConfig([]);
    const pins = resolvePins(decls, { x: 10, y: 20 }, 0, config, createClockConfig([]));
    expect(pins).toHaveLength(2);
    // Origin is ignored — positions are local-rotated only
    expect(pins[0].position).toEqual({ x: 0, y: 1 });
    expect(pins[1].position).toEqual({ x: 2, y: 1 });
  });

  it("resolves pins with 180° rotation (origin ignored)", () => {
    const config = createInverterConfig([]);
    const pins = resolvePins(decls, { x: 10, y: 20 }, 2, config, createClockConfig([]));
    // decl[0] pos (0,1) rotated 180° → (0,-1)
    expect(pins[0].position).toEqual({ x: 0, y: -1 });
    // decl[1] pos (2,1) rotated 180° → (-2,-1)
    expect(pins[1].position).toEqual({ x: -2, y: -1 });
  });

  it("applies inverter config to resolved pins", () => {
    const config = createInverterConfig(["A"]);
    const pins = resolvePins(decls, { x: 0, y: 0 }, 0, config, createClockConfig([]));
    expect(pins[0].isNegated).toBe(true);
    expect(pins[1].isNegated).toBe(false);
  });

  it("applies custom bitWidth to all pins", () => {
    const config = createInverterConfig([]);
    const pins = resolvePins(decls, { x: 0, y: 0 }, 0, config, createClockConfig([]), 4);
    expect(pins[0].bitWidth).toBe(4);
    expect(pins[1].bitWidth).toBe(4);
  });

  it("returns empty array for empty declarations", () => {
    const config = createInverterConfig([]);
    const pins = resolvePins([], { x: 0, y: 0 }, 0, config, createClockConfig([]));
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

  it("two pins on west face are evenly distributed (y=1,3)", () => {
    const positions = layoutPinsOnFace("west", 2, 4, 4);
    expect(positions).toHaveLength(2);
    expect(positions[0].x).toBe(0);
    expect(positions[1].x).toBe(0);
    expect(positions[0].y).toBe(1);
    expect(positions[1].y).toBe(3);
  });

  it("two pins on east face are evenly distributed (y=1,3)", () => {
    const positions = layoutPinsOnFace("east", 2, 4, 4);
    expect(positions[0].x).toBe(4);
    expect(positions[0].y).toBe(1);
    expect(positions[1].y).toBe(3);
  });

  it("two pins on north face are evenly distributed (x=1,3)", () => {
    const positions = layoutPinsOnFace("north", 2, 4, 4);
    expect(positions[0].y).toBe(0);
    expect(positions[0].x).toBe(1);
    expect(positions[1].x).toBe(3);
  });

  it("two pins on south face are evenly distributed (x=1,3)", () => {
    const positions = layoutPinsOnFace("south", 2, 4, 4);
    expect(positions[0].y).toBe(4);
    expect(positions[0].x).toBe(1);
    expect(positions[1].x).toBe(3);
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

  it("single pin on west face is centred vertically (h=4 → y=2)", () => {
    // floor((4 - 1 + 1) / 2) = floor(2) = 2
    const positions = layoutPinsOnFace("west", 1, 4, 4);
    expect(positions[0].y).toBe(2);
  });

  it("two pins on west face are evenly distributed (h=4 → y=1,3)", () => {
    // Even distribution with margin=1: y=1,3 — symmetric about midline y=2
    const positions = layoutPinsOnFace("west", 2, 4, 4);
    expect(positions[0].y).toBe(1);
    expect(positions[1].y).toBe(3);
  });

  it("four pins fill a h=4 component starting at y=0", () => {
    // floor((4 - 4 + 1) / 2) = floor(0.5) = 0  → y=0,1,2,3
    const positions = layoutPinsOnFace("west", 4, 4, 4);
    expect(positions[0].y).toBe(0);
    expect(positions[3].y).toBe(3);
  });

  it("AND gate 2-input standard layout: inputs straddle centre, output centred", () => {
    // COMP_WIDTH=4, h=4 (2 inputs × 2 = 4)
    // Inputs west: margin=1, step=2 → y=1,3
    // Output east: centred → y=2
    const decls = standardGatePinLayout(["in0", "in1"], "out", 4, 4);
    const inputs = decls.filter((d) => d.direction === PinDirection.INPUT);
    const output = decls.find((d) => d.direction === PinDirection.OUTPUT)!;
    expect(inputs[0].position.y).toBe(1);
    expect(inputs[1].position.y).toBe(3);
    expect(output.position.y).toBe(2);
    // x-coordinates
    expect(inputs[0].position.x).toBe(0);
    expect(output.position.x).toBe(4);
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
    const pins = resolvePins(decls, origin, 0, config, createClockConfig([]));

    const pinA = pins.find((p) => p.label === "A")!;
    const pinB = pins.find((p) => p.label === "B")!;
    const pinQ = pins.find((p) => p.label === "Q")!;

    expect(pinA.direction).toBe(PinDirection.INPUT);
    expect(pinA.isNegated).toBe(true);
    expect(pinA.position.x).toBe(0); // west face x=0 (origin ignored)

    expect(pinB.direction).toBe(PinDirection.INPUT);
    expect(pinB.isNegated).toBe(false);

    expect(pinQ.direction).toBe(PinDirection.OUTPUT);
    expect(pinQ.isNegated).toBe(false);
    expect(pinQ.position.x).toBe(4); // east face x=4 (origin ignored)
  });

  it("rotating a gate 180° swaps input/output sides", () => {
    const decls = standardGatePinLayout(["A"], "Q", 4, 2);
    const config = createInverterConfig([]);
    const origin = { x: 5, y: 5 };

    const pins0 = resolvePins(decls, origin, 0, config, createClockConfig([]));
    const pins2 = resolvePins(decls, origin, 2, config, createClockConfig([]));

    const inputAt0 = pins0.find((p) => p.label === "A")!;
    const inputAt2 = pins2.find((p) => p.label === "A")!;
    const outputAt0 = pins0.find((p) => p.label === "Q")!;
    const outputAt2 = pins2.find((p) => p.label === "Q")!;

    // At rotation 0, input is on west (lower x); at rotation 2, positions flip
    expect(inputAt0.position.x).toBeLessThan(outputAt0.position.x);
    expect(inputAt2.position.x).toBeGreaterThan(outputAt2.position.x);
  });
});
