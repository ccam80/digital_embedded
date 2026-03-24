/**
 * Tests for element-help.ts — buildHelpContent.
 */

import { describe, it, expect } from "vitest";
import { buildHelpContent } from "@/editor/element-help";
import type { HelpContent } from "@/editor/element-help";
import { AbstractCircuitElement } from "@/core/element";
import { PinDirection } from "@/core/pin";
import { PropertyBag, PropertyType } from "@/core/properties";
import type { Pin, Rotation } from "@/core/pin";
import type { RenderContext, Rect } from "@/core/renderer-interface";
import type { SerializedElement } from "@/core/element";
import type { ComponentDefinition, ComponentLayout } from "@/core/registry";
import { ComponentCategory } from "@/core/registry";
import type { PropertyDefinition } from "@/core/properties";

// ---------------------------------------------------------------------------
// Stub helpers
// ---------------------------------------------------------------------------

let _idCounter = 0;

function makeElementWithPins(
  helpText: string,
  pins: Pin[],
): InstanceType<typeof AbstractCircuitElement> {
  const id = `el-${++_idCounter}`;
  const capturedPins = pins;
  const capturedHelp = helpText;

  return new (class extends AbstractCircuitElement {
    constructor() {
      super("TestComp", id, { x: 0, y: 0 }, 0 as Rotation, false, new PropertyBag());
    }
    getPins(): readonly Pin[] {
      return capturedPins;
    }
    draw(_ctx: RenderContext): void {}
    getBoundingBox(): Rect {
      return { x: 0, y: 0, width: 2, height: 2 };
    }
    getHelpText(): string {
      return capturedHelp;
    }
    serialize(): SerializedElement {
      return {} as SerializedElement;
    }
  })();
}

function makePin(label: string, direction: PinDirection = PinDirection.INPUT): Pin {
  return {
    direction,
    position: { x: 0, y: 0 },
    label,
    bitWidth: 1,
    isNegated: false,
    isClock: false,
  };
}

function makePinWithDetails(
  label: string,
  direction: PinDirection,
  bitWidth: number,
  isNegated: boolean,
  isClock: boolean,
): Pin {
  return { direction, position: { x: 0, y: 0 }, label, bitWidth, isNegated, isClock };
}

function makeDefinition(
  name: string,
  helpText: string,
  propertyDefs: PropertyDefinition[] = [],
): ComponentDefinition {
  return {
    name,
    typeId: -1,
    factory: (_props) =>
      makeElementWithPins(helpText, []) as unknown as ReturnType<ComponentDefinition["factory"]>,
    executeFn: (_index: number, _state: Uint32Array, _highZs: Uint32Array, _layout: ComponentLayout) => {},
    pinLayout: [],
    propertyDefs,
    attributeMap: [],
    category: ComponentCategory.LOGIC,
    helpText,
  };
}

function makePropDef(
  key: string,
  label: string,
  type: PropertyType = PropertyType.INT,
  defaultValue: number | string | boolean = 0,
  description?: string,
): PropertyDefinition {
  return description !== undefined
    ? { key, label, type, defaultValue, description }
    : { key, label, type, defaultValue };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ElementHelp", () => {
  describe("includesPinTable", () => {
    it("pinTable has 3 entries for element with 3 pins", () => {
      const pins = [
        makePin("A", PinDirection.INPUT),
        makePin("B", PinDirection.INPUT),
        makePin("OUT", PinDirection.OUTPUT),
      ];
      const element = makeElementWithPins("Test help text", pins);
      const definition = makeDefinition("TestGate", "A simple test gate");

      const content: HelpContent = buildHelpContent(element, definition);

      expect(content.pinTable).toHaveLength(3);
    });

    it("pinTable entries have correct labels", () => {
      const pins = [
        makePin("IN1", PinDirection.INPUT),
        makePin("IN2", PinDirection.INPUT),
        makePin("Q", PinDirection.OUTPUT),
      ];
      const element = makeElementWithPins("help", pins);
      const definition = makeDefinition("SomeComp", "desc");

      const content = buildHelpContent(element, definition);

      expect(content.pinTable[0]!.label).toBe("IN1");
      expect(content.pinTable[1]!.label).toBe("IN2");
      expect(content.pinTable[2]!.label).toBe("Q");
    });

    it("pinTable entries have correct directions", () => {
      const pins = [
        makePin("A", PinDirection.INPUT),
        makePin("OUT", PinDirection.OUTPUT),
        makePin("BUS", PinDirection.BIDIRECTIONAL),
      ];
      const element = makeElementWithPins("help", pins);
      const definition = makeDefinition("Comp", "desc");

      const content = buildHelpContent(element, definition);

      expect(content.pinTable[0]!.direction).toBe("Input");
      expect(content.pinTable[1]!.direction).toBe("Output");
      expect(content.pinTable[2]!.direction).toBe("Bidirectional");
    });

    it("pinTable entries have correct bitWidth", () => {
      const pins = [
        makePinWithDetails("A", PinDirection.INPUT, 4, false, false),
        makePinWithDetails("B", PinDirection.INPUT, 8, false, false),
      ];
      const element = makeElementWithPins("help", pins);
      const definition = makeDefinition("Comp", "desc");

      const content = buildHelpContent(element, definition);

      expect(content.pinTable[0]!.bitWidth).toBe(4);
      expect(content.pinTable[1]!.bitWidth).toBe(8);
    });

    it("pinTable reflects isNegated and isClock flags", () => {
      const pins = [
        makePinWithDetails("CLK", PinDirection.INPUT, 1, false, true),
        makePinWithDetails("nRST", PinDirection.INPUT, 1, true, false),
      ];
      const element = makeElementWithPins("help", pins);
      const definition = makeDefinition("FF", "desc");

      const content = buildHelpContent(element, definition);

      expect(content.pinTable[0]!.isClock).toBe(true);
      expect(content.pinTable[0]!.isNegated).toBe(false);
      expect(content.pinTable[1]!.isNegated).toBe(true);
      expect(content.pinTable[1]!.isClock).toBe(false);
    });

    it("pinTable is empty when element has no pins", () => {
      const element = makeElementWithPins("help", []);
      const definition = makeDefinition("Comp", "desc");

      const content = buildHelpContent(element, definition);

      expect(content.pinTable).toHaveLength(0);
    });
  });

  describe("includesPropertyTable", () => {
    it("propertyTable has 2 entries for definition with 2 property defs", () => {
      const element = makeElementWithPins("help", []);
      const propDefs = [
        makePropDef("bitWidth", "Bit Width", PropertyType.BIT_WIDTH, 1),
        makePropDef("label", "Label", PropertyType.STRING, ""),
      ];
      const definition = makeDefinition("Comp", "desc", propDefs);

      const content = buildHelpContent(element, definition);

      expect(content.propertyTable).toHaveLength(2);
    });

    it("propertyTable entries have correct keys and labels", () => {
      const element = makeElementWithPins("help", []);
      const propDefs = [
        makePropDef("delay", "Gate Delay", PropertyType.INT, 10, "Propagation delay in ns"),
        makePropDef("active", "Active High", PropertyType.BOOLEAN, true),
      ];
      const definition = makeDefinition("Comp", "desc", propDefs);

      const content = buildHelpContent(element, definition);

      expect(content.propertyTable[0]!.key).toBe("delay");
      expect(content.propertyTable[0]!.label).toBe("Gate Delay");
      expect(content.propertyTable[1]!.key).toBe("active");
      expect(content.propertyTable[1]!.label).toBe("Active High");
    });

    it("propertyTable entries have correct type strings", () => {
      const element = makeElementWithPins("help", []);
      const propDefs = [
        makePropDef("bits", "Bits", PropertyType.BIT_WIDTH, 1),
        makePropDef("mode", "Mode", PropertyType.ENUM, "async"),
      ];
      const definition = makeDefinition("Comp", "desc", propDefs);

      const content = buildHelpContent(element, definition);

      expect(content.propertyTable[0]!.type).toBe(PropertyType.BIT_WIDTH);
      expect(content.propertyTable[1]!.type).toBe(PropertyType.ENUM);
    });

    it("propertyTable entries have defaultValue as string", () => {
      const element = makeElementWithPins("help", []);
      const propDefs = [
        makePropDef("count", "Count", PropertyType.INT, 42),
        makePropDef("name", "Name", PropertyType.STRING, "default"),
      ];
      const definition = makeDefinition("Comp", "desc", propDefs);

      const content = buildHelpContent(element, definition);

      expect(content.propertyTable[0]!.defaultValue).toBe("42");
      expect(content.propertyTable[1]!.defaultValue).toBe("default");
    });

    it("propertyTable includes description when present", () => {
      const element = makeElementWithPins("help", []);
      const propDefs = [
        makePropDef("delay", "Delay", PropertyType.INT, 0, "Propagation delay in nanoseconds"),
      ];
      const definition = makeDefinition("Comp", "desc", propDefs);

      const content = buildHelpContent(element, definition);

      expect(content.propertyTable[0]!.description).toBe(
        "Propagation delay in nanoseconds",
      );
    });

    it("propertyTable is empty when definition has no property defs", () => {
      const element = makeElementWithPins("help", []);
      const definition = makeDefinition("Comp", "desc", []);

      const content = buildHelpContent(element, definition);

      expect(content.propertyTable).toHaveLength(0);
    });
  });

  describe("includesHelpText", () => {
    it("helpText comes from element.getHelpText()", () => {
      const expectedText = "AND gate: output is 1 only when all inputs are 1.";
      const element = makeElementWithPins(expectedText, []);
      const definition = makeDefinition("And", "description from definition");

      const content = buildHelpContent(element, definition);

      expect(content.helpText).toBe(expectedText);
    });

    it("description comes from definition helpText, not element", () => {
      const element = makeElementWithPins("element help text", []);
      const definition = makeDefinition("And", "Definition-level description of AND gate");

      const content = buildHelpContent(element, definition);

      expect(content.description).toBe("Definition-level description of AND gate");
    });

    it("title comes from definition name", () => {
      const element = makeElementWithPins("help", []);
      const definition = makeDefinition("FlipflopD", "D flip-flop");

      const content = buildHelpContent(element, definition);

      expect(content.title).toBe("FlipflopD");
    });

    it("helpText is empty string when element returns empty help", () => {
      const element = makeElementWithPins("", []);
      const definition = makeDefinition("Comp", "desc");

      const content = buildHelpContent(element, definition);

      expect(content.helpText).toBe("");
    });

    it("returns all fields as a complete HelpContent record", () => {
      const pins = [makePin("IN", PinDirection.INPUT), makePin("OUT", PinDirection.OUTPUT)];
      const element = makeElementWithPins("Full help text here.", pins);
      const propDefs = [makePropDef("bits", "Bits", PropertyType.BIT_WIDTH, 1)];
      const definition = makeDefinition("SomeGate", "Gate description", propDefs);

      const content = buildHelpContent(element, definition);

      expect(content.title).toBe("SomeGate");
      expect(content.description).toBe("Gate description");
      expect(content.pinTable).toHaveLength(2);
      expect(content.propertyTable).toHaveLength(1);
      expect(content.helpText).toBe("Full help text here.");
    });
  });
});
