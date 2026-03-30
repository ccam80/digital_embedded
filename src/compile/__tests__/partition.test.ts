import { describe, it, expect } from "vitest";
import { partitionByDomain } from "../partition.js";
import type { ModelAssignment } from "../partition.js";
import type { ConnectivityGroup, ResolvedGroupPin } from "../types.js";
import { PinDirection } from "@/core/pin.js";
import type { CircuitElement } from "@/core/element.js";
import type { ComponentDefinition, ComponentRegistry, DigitalModel, MnaModel } from "@/core/registry.js";

// ---------------------------------------------------------------------------
// Minimal stubs
// ---------------------------------------------------------------------------

function makeElement(typeId: string, index: number): CircuitElement {
  return {
    typeId,
    instanceId: `inst-${index}`,
    position: { x: 0, y: 0 },
    rotation: 0 as never,
    mirror: false,
    getPins: () => [],
    getProps: () => ({ get: () => undefined } as never),
    draw: () => {},
    getBoundingBox: () => ({ x: 0, y: 0, width: 0, height: 0 }),
    serialize: () => ({ typeId, instanceId: `inst-${index}`, position: { x: 0, y: 0 }, rotation: 0 as never, mirror: false, properties: {} }),
  } as unknown as CircuitElement;
}

const DIGITAL_MODEL: DigitalModel = {
  executeFn: () => {},
};

const ANALOG_MODEL: MnaModel = {};

function makeDigitalDef(name: string): ComponentDefinition {
  return {
    name,
    typeId: 0,
    factory: () => { throw new Error("not used"); },
    pinLayout: [],
    propertyDefs: [],
    attributeMap: [],
    category: "LOGIC" as never,
    helpText: "",
    models: { digital: DIGITAL_MODEL },
  };
}

function makeAnalogDef(name: string): ComponentDefinition {
  return {
    name,
    typeId: 0,
    factory: () => { throw new Error("not used"); },
    pinLayout: [],
    propertyDefs: [],
    attributeMap: [],
    category: "PASSIVES" as never,
    helpText: "",
    pinElectrical: { vOH: 3.3, vOL: 0, vIH: 2.0, vIL: 0.8 },
    models: {},
    modelRegistry: { behavioral: { kind: 'inline' as const, factory: () => { throw new Error("not used"); }, paramDefs: [], params: {} } },
  };
}

function makeBothDef(name: string): ComponentDefinition {
  return {
    name,
    typeId: 0,
    factory: () => { throw new Error("not used"); },
    pinLayout: [],
    propertyDefs: [],
    attributeMap: [],
    category: "SEMICONDUCTORS" as never,
    helpText: "",
    pinElectrical: { vOH: 3.3, vOL: 0, vIH: 2.0, vIL: 0.8 },
    models: { digital: DIGITAL_MODEL },
    modelRegistry: { behavioral: { kind: 'inline' as const, factory: () => { throw new Error("not used"); }, paramDefs: [], params: {} } },
  };
}

function makeRegistry(defs: ComponentDefinition[]): ComponentRegistry {
  const map = new Map<string, ComponentDefinition>();
  for (const d of defs) map.set(d.name, d);
  return {
    get: (name: string) => map.get(name),
  } as unknown as ComponentRegistry;
}

function makePin(
  elementIndex: number,
  pinIndex: number,
  domain: string,
  direction: PinDirection = PinDirection.OUTPUT,
  bitWidth = 1,
): ResolvedGroupPin {
  return {
    elementIndex,
    pinIndex,
    pinLabel: `p${pinIndex}`,
    direction,
    bitWidth,
    worldPosition: { x: 0, y: 0 },
    wireVertex: null,
    domain,
    kind: "signal",
  };
}

function makeGroup(
  groupId: number,
  pins: ResolvedGroupPin[],
  bitWidth?: number,
): ConnectivityGroup {
  const domains = new Set(pins.map((p) => p.domain));
  return { groupId, pins, wires: [], domains, bitWidth };
}


// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("partitionByDomain", () => {
  describe("pure digital circuit", () => {
    it("routes all digital components to digital partition", () => {
      const el0 = makeElement("And", 0);
      const el1 = makeElement("Or", 1);
      const registry = makeRegistry([makeDigitalDef("And"), makeDigitalDef("Or")]);

      const pinA = makePin(0, 0, "digital", PinDirection.OUTPUT);
      const pinB = makePin(1, 0, "digital", PinDirection.INPUT);
      const group = makeGroup(0, [pinA, pinB]);

      const assignments: ModelAssignment[] = [
        { elementIndex: 0, modelKey: "digital", model: DIGITAL_MODEL },
        { elementIndex: 1, modelKey: "digital", model: DIGITAL_MODEL },
      ];

      const result = partitionByDomain([group], [el0, el1], registry, assignments);

      expect(result.digital.components).toHaveLength(2);
      expect(result.analog.components).toHaveLength(0);
    });

    it("analog partition is empty — not null", () => {
      const el0 = makeElement("And", 0);
      const registry = makeRegistry([makeDigitalDef("And")]);
      const group = makeGroup(0, [makePin(0, 0, "digital")]);
      const assignments: ModelAssignment[] = [
        { elementIndex: 0, modelKey: "digital", model: DIGITAL_MODEL },
      ];

      const result = partitionByDomain([group], [el0], registry, assignments);

      expect(result.analog).toBeDefined();
      expect(result.analog.components).toHaveLength(0);
      expect(result.analog.groups).toHaveLength(0);
      expect(result.bridges).toHaveLength(0);
    });

    it("all groups go to digital partition", () => {
      const el0 = makeElement("And", 0);
      const registry = makeRegistry([makeDigitalDef("And")]);
      const g0 = makeGroup(0, [makePin(0, 0, "digital", PinDirection.OUTPUT)]);
      const g1 = makeGroup(1, [makePin(0, 1, "digital", PinDirection.INPUT)]);
      const assignments: ModelAssignment[] = [
        { elementIndex: 0, modelKey: "digital", model: DIGITAL_MODEL },
      ];

      const result = partitionByDomain([g0, g1], [el0], registry, assignments);

      expect(result.digital.groups).toHaveLength(2);
      expect(result.analog.groups).toHaveLength(0);
    });
  });

  describe("pure analog circuit", () => {
    it("routes all analog components to analog partition", () => {
      const el0 = makeElement("Resistor", 0);
      const el1 = makeElement("Capacitor", 1);
      const registry = makeRegistry([makeAnalogDef("Resistor"), makeAnalogDef("Capacitor")]);

      const group = makeGroup(0, [
        makePin(0, 0, "analog", PinDirection.BIDIRECTIONAL),
        makePin(1, 0, "analog", PinDirection.BIDIRECTIONAL),
      ]);
      const assignments: ModelAssignment[] = [
        { elementIndex: 0, modelKey: "analog", model: ANALOG_MODEL },
        { elementIndex: 1, modelKey: "analog", model: ANALOG_MODEL },
      ];

      const result = partitionByDomain([group], [el0, el1], registry, assignments);

      expect(result.analog.components).toHaveLength(2);
      expect(result.digital.components).toHaveLength(0);
    });

    it("digital partition is empty — not null", () => {
      const el0 = makeElement("Resistor", 0);
      const registry = makeRegistry([makeAnalogDef("Resistor")]);
      const group = makeGroup(0, [makePin(0, 0, "analog")]);
      const assignments: ModelAssignment[] = [
        { elementIndex: 0, modelKey: "analog", model: ANALOG_MODEL },
      ];

      const result = partitionByDomain([group], [el0], registry, assignments);

      expect(result.digital).toBeDefined();
      expect(result.digital.components).toHaveLength(0);
      expect(result.digital.groups).toHaveLength(0);
      expect(result.bridges).toHaveLength(0);
    });
  });

  describe("mixed circuit", () => {
    it("produces both populated partitions and a bridge at boundary group", () => {
      const elD = makeElement("And", 0);  // digital
      const elA = makeElement("Resistor", 1);  // analog
      const registry = makeRegistry([makeDigitalDef("And"), makeAnalogDef("Resistor")]);

      // Pure digital group
      const gDigital = makeGroup(0, [makePin(0, 0, "digital", PinDirection.OUTPUT)]);
      // Boundary group: digital output → analog input
      const gBoundary = makeGroup(1, [
        makePin(0, 1, "digital", PinDirection.OUTPUT),
        makePin(1, 0, "analog", PinDirection.BIDIRECTIONAL),
      ]);
      // Pure analog group
      const gAnalog = makeGroup(2, [makePin(1, 1, "analog", PinDirection.BIDIRECTIONAL)]);

      const assignments: ModelAssignment[] = [
        { elementIndex: 0, modelKey: "digital", model: DIGITAL_MODEL },
        { elementIndex: 1, modelKey: "analog", model: ANALOG_MODEL },
      ];

      const result = partitionByDomain(
        [gDigital, gBoundary, gAnalog],
        [elD, elA],
        registry,
        assignments,
      );

      expect(result.digital.components).toHaveLength(1);
      expect(result.analog.components).toHaveLength(1);
      expect(result.bridges).toHaveLength(1);
    });

    it("bridge direction is digital-to-analog when digital output pin present", () => {
      const elD = makeElement("And", 0);
      const elA = makeElement("Resistor", 1);
      const registry = makeRegistry([makeDigitalDef("And"), makeAnalogDef("Resistor")]);

      const gBoundary = makeGroup(1, [
        makePin(0, 0, "digital", PinDirection.OUTPUT),
        makePin(1, 0, "analog", PinDirection.BIDIRECTIONAL),
      ]);

      const assignments: ModelAssignment[] = [
        { elementIndex: 0, modelKey: "digital", model: DIGITAL_MODEL },
        { elementIndex: 1, modelKey: "analog", model: ANALOG_MODEL },
      ];

      const result = partitionByDomain([gBoundary], [elD, elA], registry, assignments);

      expect(result.bridges[0].direction).toBe("digital-to-analog");
    });

    it("bridge direction is analog-to-digital when no digital output pin", () => {
      const elD = makeElement("And", 0);
      const elA = makeElement("Resistor", 1);
      const registry = makeRegistry([makeDigitalDef("And"), makeAnalogDef("Resistor")]);

      // Digital INPUT pin at boundary — analog drives digital
      const gBoundary = makeGroup(1, [
        makePin(0, 0, "digital", PinDirection.INPUT),
        makePin(1, 0, "analog", PinDirection.BIDIRECTIONAL),
      ]);

      const assignments: ModelAssignment[] = [
        { elementIndex: 0, modelKey: "digital", model: DIGITAL_MODEL },
        { elementIndex: 1, modelKey: "analog", model: ANALOG_MODEL },
      ];

      const result = partitionByDomain([gBoundary], [elD, elA], registry, assignments);

      expect(result.bridges[0].direction).toBe("analog-to-digital");
    });

    it("bridge stub is added to both digital and analog partitions", () => {
      const elD = makeElement("And", 0);
      const elA = makeElement("Resistor", 1);
      const registry = makeRegistry([makeDigitalDef("And"), makeAnalogDef("Resistor")]);

      const gBoundary = makeGroup(5, [
        makePin(0, 0, "digital", PinDirection.OUTPUT),
        makePin(1, 0, "analog", PinDirection.BIDIRECTIONAL),
      ]);

      const assignments: ModelAssignment[] = [
        { elementIndex: 0, modelKey: "digital", model: DIGITAL_MODEL },
        { elementIndex: 1, modelKey: "analog", model: ANALOG_MODEL },
      ];

      const result = partitionByDomain([gBoundary], [elD, elA], registry, assignments);

      expect(result.digital.bridgeStubs).toHaveLength(1);
      expect(result.analog.bridgeStubs).toHaveLength(1);
      expect(result.digital.bridgeStubs[0].boundaryGroupId).toBe(5);
      expect(result.analog.bridgeStubs[0].boundaryGroupId).toBe(5);
    });

    it("bridge bitWidth comes from group.bitWidth", () => {
      const elD = makeElement("And", 0);
      const elA = makeElement("Resistor", 1);
      const registry = makeRegistry([makeDigitalDef("And"), makeAnalogDef("Resistor")]);

      const gBoundary = makeGroup(1, [
        makePin(0, 0, "digital", PinDirection.OUTPUT, 4),
        makePin(1, 0, "analog", PinDirection.BIDIRECTIONAL, 4),
      ], 4);

      const assignments: ModelAssignment[] = [
        { elementIndex: 0, modelKey: "digital", model: DIGITAL_MODEL },
        { elementIndex: 1, modelKey: "analog", model: ANALOG_MODEL },
      ];

      const result = partitionByDomain([gBoundary], [elD, elA], registry, assignments);

      expect(result.bridges[0].bitWidth).toBe(4);
    });

    it("boundary group appears in both partition group lists", () => {
      const elD = makeElement("And", 0);
      const elA = makeElement("Resistor", 1);
      const registry = makeRegistry([makeDigitalDef("And"), makeAnalogDef("Resistor")]);

      const gBoundary = makeGroup(7, [
        makePin(0, 0, "digital", PinDirection.OUTPUT),
        makePin(1, 0, "analog", PinDirection.BIDIRECTIONAL),
      ]);

      const assignments: ModelAssignment[] = [
        { elementIndex: 0, modelKey: "digital", model: DIGITAL_MODEL },
        { elementIndex: 1, modelKey: "analog", model: ANALOG_MODEL },
      ];

      const result = partitionByDomain([gBoundary], [elD, elA], registry, assignments);

      const dGroupIds = result.digital.groups.map((g) => g.groupId);
      const aGroupIds = result.analog.groups.map((g) => g.groupId);
      expect(dGroupIds).toContain(7);
      expect(aGroupIds).toContain(7);
    });
  });

  describe("ID assignment", () => {
    it("does not assign net IDs or node IDs to groups", () => {
      const el0 = makeElement("And", 0);
      const registry = makeRegistry([makeDigitalDef("And")]);
      const group = makeGroup(42, [makePin(0, 0, "digital")]);
      const assignments: ModelAssignment[] = [
        { elementIndex: 0, modelKey: "digital", model: DIGITAL_MODEL },
      ];

      const result = partitionByDomain([group], [el0], registry, assignments);

      // groupId is preserved as-is; no extra id field is attached
      expect(result.digital.groups[0].groupId).toBe(42);
    });
  });

  describe("infrastructure components (no model assignment)", () => {
    it("components without a model assignment are not included in either partition", () => {
      // Element 0 is a Tunnel (infrastructure) — no ModelAssignment
      // Element 1 is digital
      const elTunnel = makeElement("Tunnel", 0);
      const elAnd = makeElement("And", 1);
      const registry = makeRegistry([makeDigitalDef("And")]);

      const group = makeGroup(0, [makePin(1, 0, "digital")]);
      const assignments: ModelAssignment[] = [
        { elementIndex: 1, modelKey: "digital", model: DIGITAL_MODEL },
        // elementIndex 0 (Tunnel) intentionally omitted
      ];

      const result = partitionByDomain([group], [elTunnel, elAnd], registry, assignments);

      expect(result.digital.components).toHaveLength(1);
      expect(result.digital.components[0].element.typeId).toBe("And");
    });
  });

  describe("unknown model key fallback", () => {
    it("routes unknown-key component to analog partition via domain resolution", () => {
      const el0 = makeElement("And", 0);
      const registry = makeRegistry([makeDigitalDef("And")]);
      const group = makeGroup(0, [makePin(0, 0, "digital")]);
      const assignments: ModelAssignment[] = [
        { elementIndex: 0, modelKey: "somethingElse", model: DIGITAL_MODEL },
      ];

      const result = partitionByDomain([group], [el0], registry, assignments);

      expect(result.analog.components).toHaveLength(1);
      expect(result.digital.components).toHaveLength(0);
    });

    it("routes unknown-key component with analog model to analog partition", () => {
      const el0 = makeElement("Resistor", 0);
      const registry = makeRegistry([makeAnalogDef("Resistor")]);
      const group = makeGroup(0, [makePin(0, 0, "analog")]);
      const assignments: ModelAssignment[] = [
        { elementIndex: 0, modelKey: "somethingElse", model: ANALOG_MODEL },
      ];

      const result = partitionByDomain([group], [el0], registry, assignments);

      expect(result.analog.components).toHaveLength(1);
      expect(result.digital.components).toHaveLength(0);
    });
  });

  describe("empty circuit", () => {
    it("returns empty partitions for an empty groups and elements list", () => {
      const registry = makeRegistry([]);

      const result = partitionByDomain([], [], registry, []);

      expect(result.digital.components).toHaveLength(0);
      expect(result.digital.groups).toHaveLength(0);
      expect(result.analog.components).toHaveLength(0);
      expect(result.analog.groups).toHaveLength(0);
      expect(result.bridges).toHaveLength(0);
    });
  });

  describe("electrical spec on bridge", () => {
    it("picks electricalSpec from component definition pinElectrical", () => {
      const analogModel: MnaModel = {};
      const analogDef: ComponentDefinition = {
        name: "SpecResistor",
        typeId: 0,
        factory: () => { throw new Error(); },
        pinLayout: [],
        propertyDefs: [],
        attributeMap: [],
        category: "PASSIVES" as never,
        helpText: "",
        pinElectrical: { vOH: 5.0, vOL: 0.1, rOut: 100 },
        models: {},
        modelRegistry: { behavioral: { kind: 'inline' as const, factory: () => { throw new Error(); }, paramDefs: [], params: {} } },
      };
      const el0 = makeElement("And", 0);
      const el1 = makeElement("SpecResistor", 1);
      const registry = makeRegistry([makeDigitalDef("And"), analogDef]);

      const gBoundary = makeGroup(1, [
        makePin(0, 0, "digital", PinDirection.OUTPUT),
        makePin(1, 0, "analog", PinDirection.BIDIRECTIONAL),
      ]);
      const assignments: ModelAssignment[] = [
        { elementIndex: 0, modelKey: "digital", model: DIGITAL_MODEL },
        { elementIndex: 1, modelKey: "analog", model: analogModel },
      ];

      const result = partitionByDomain([gBoundary], [el0, el1], registry, assignments);

      expect(result.bridges[0].electricalSpec).toEqual({ vOH: 5.0, vOL: 0.1, rOut: 100 });
    });

    it("returns empty spec when no analog electrical override is present", () => {
      const el0 = makeElement("And", 0);
      const el1 = makeElement("Resistor", 1);
      const registry = makeRegistry([makeDigitalDef("And"), makeAnalogDef("Resistor")]);

      const gBoundary = makeGroup(1, [
        makePin(0, 0, "digital", PinDirection.OUTPUT),
        makePin(1, 0, "analog", PinDirection.BIDIRECTIONAL),
      ]);
      const assignments: ModelAssignment[] = [
        { elementIndex: 0, modelKey: "digital", model: DIGITAL_MODEL },
        { elementIndex: 1, modelKey: "analog", model: ANALOG_MODEL },
      ];

      const result = partitionByDomain([gBoundary], [el0, el1], registry, assignments);

      expect(result.bridges[0].electricalSpec).toEqual(
        expect.objectContaining({ vOH: 3.3, vOL: 0, vIH: 2.0, vIL: 0.8 }),
      );
    });
  });

  describe("resolvedPins on PartitionedComponents", () => {
    it("each partitioned component carries its resolved pins from the groups", () => {
      const el0 = makeElement("And", 0);
      const registry = makeRegistry([makeDigitalDef("And")]);

      const pin0 = makePin(0, 0, "digital", PinDirection.INPUT);
      const pin1 = makePin(0, 1, "digital", PinDirection.OUTPUT);
      const g0 = makeGroup(0, [pin0]);
      const g1 = makeGroup(1, [pin1]);

      const assignments: ModelAssignment[] = [
        { elementIndex: 0, modelKey: "digital", model: DIGITAL_MODEL },
      ];

      const result = partitionByDomain([g0, g1], [el0], registry, assignments);

      const comp = result.digital.components[0];
      expect(comp.resolvedPins).toHaveLength(2);
      const labels = comp.resolvedPins.map((p) => p.pinLabel);
      expect(labels).toContain("p0");
      expect(labels).toContain("p1");
    });
  });

  describe("neutral component routing by connected net domain (H6/H7)", () => {
    function makeNeutralDef(name: string): ComponentDefinition {
      return {
        name,
        typeId: 0,
        factory: () => { throw new Error("not used"); },
        pinLayout: [],
        propertyDefs: [],
        attributeMap: [],
        category: "IO" as never,
        helpText: "",
        models: {},
      };
    }

    it("neutral component touching only analog groups goes to analog and digital partitions", () => {
      const elNeutral = makeElement("Ground", 0);
      const elAnalog = makeElement("Resistor", 1);
      const registry = makeRegistry([makeNeutralDef("Ground"), makeAnalogDef("Resistor")]);

      const gAnalog = makeGroup(0, [
        makePin(0, 0, "analog", PinDirection.BIDIRECTIONAL),
        makePin(1, 0, "analog", PinDirection.BIDIRECTIONAL),
      ]);

      const assignments: ModelAssignment[] = [
        { elementIndex: 0, modelKey: "neutral", model: null as never },
        { elementIndex: 1, modelKey: "analog", model: ANALOG_MODEL },
      ];

      const result = partitionByDomain([gAnalog], [elNeutral, elAnalog], registry, assignments);

      expect(result.analog.components.some((c) => c.element.typeId === "Ground")).toBe(true);
      expect(result.digital.components.some((c) => c.element.typeId === "Ground")).toBe(true);
    });

    it("neutral component touching only digital groups goes only to digital partition", () => {
      const elNeutral = makeElement("Ground", 0);
      const elDigital = makeElement("And", 1);
      const registry = makeRegistry([makeNeutralDef("Ground"), makeDigitalDef("And")]);

      const gDigital = makeGroup(0, [
        makePin(0, 0, "digital", PinDirection.BIDIRECTIONAL),
        makePin(1, 0, "digital", PinDirection.OUTPUT),
      ]);

      const assignments: ModelAssignment[] = [
        { elementIndex: 0, modelKey: "neutral", model: null as never },
        { elementIndex: 1, modelKey: "digital", model: DIGITAL_MODEL },
      ];

      const result = partitionByDomain([gDigital], [elNeutral, elDigital], registry, assignments);

      expect(result.digital.components.some((c) => c.element.typeId === "Ground")).toBe(true);
      expect(result.analog.components.some((c) => c.element.typeId === "Ground")).toBe(false);
    });

    it("neutral component touching both analog and digital groups goes to both partitions", () => {
      const elNeutral = makeElement("Ground", 0);
      const elAnalog = makeElement("Resistor", 1);
      const elDigital = makeElement("And", 2);
      const registry = makeRegistry([
        makeNeutralDef("Ground"),
        makeAnalogDef("Resistor"),
        makeDigitalDef("And"),
      ]);

      const gAnalog = makeGroup(0, [
        makePin(0, 0, "analog", PinDirection.BIDIRECTIONAL),
        makePin(1, 0, "analog", PinDirection.BIDIRECTIONAL),
      ]);
      const gDigital = makeGroup(1, [
        makePin(0, 1, "digital", PinDirection.BIDIRECTIONAL),
        makePin(2, 0, "digital", PinDirection.OUTPUT),
      ]);

      const assignments: ModelAssignment[] = [
        { elementIndex: 0, modelKey: "neutral", model: null as never },
        { elementIndex: 1, modelKey: "analog", model: ANALOG_MODEL },
        { elementIndex: 2, modelKey: "digital", model: DIGITAL_MODEL },
      ];

      const result = partitionByDomain([gAnalog, gDigital], [elNeutral, elAnalog, elDigital], registry, assignments);

      expect(result.analog.components.some((c) => c.element.typeId === "Ground")).toBe(true);
      expect(result.digital.components.some((c) => c.element.typeId === "Ground")).toBe(true);
    });

    it("neutral component not connected to any group goes only to digital partition", () => {
      const elNeutral = makeElement("Ground", 0);
      const registry = makeRegistry([makeNeutralDef("Ground")]);

      const assignments: ModelAssignment[] = [
        { elementIndex: 0, modelKey: "neutral", model: null as never },
      ];

      const result = partitionByDomain([], [elNeutral], registry, assignments);

      expect(result.digital.components.some((c) => c.element.typeId === "Ground")).toBe(true);
      expect(result.analog.components.some((c) => c.element.typeId === "Ground")).toBe(false);
    });
  });
});
