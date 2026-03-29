/**
 * Tests for digitalPinLoading and digitalPinLoadingOverrides round-trip
 * across both the JSON (save.ts / load.ts) and DTS (dts-serializer.ts /
 * dts-deserializer.ts) formats.
 */

import { describe, it, expect } from "vitest";
import { serializeCircuit as serializeJson } from "../save.js";
import { deserializeCircuit as deserializeJson } from "../load.js";
import { serializeCircuit as serializeDts } from "../dts-serializer.js";
import { deserializeDts } from "../dts-deserializer.js";
import { Circuit } from "../../core/circuit.js";
import { AbstractCircuitElement } from "../../core/element.js";
import { PropertyBag } from "../../core/properties.js";
import { ComponentRegistry, ComponentCategory } from "../../core/registry.js";
import type { RenderContext, Rect } from "../../core/renderer-interface.js";
import type { Pin } from "../../core/pin.js";

// ---------------------------------------------------------------------------
// Minimal stub element
// ---------------------------------------------------------------------------

class StubElement extends AbstractCircuitElement {
  getPins(): readonly Pin[] {
    return [];
  }
  draw(_ctx: RenderContext): void {
    // no-op
  }
  getBoundingBox(): Rect {
    return { x: this.position.x, y: this.position.y, width: 4, height: 4 };
  }
}

function makeRegistry(...names: string[]): ComponentRegistry {
  const registry = new ComponentRegistry();
  for (const name of names) {
    registry.register({
      name,
      typeId: -1,
      factory: (props: PropertyBag) =>
        new StubElement(name, crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props),
      pinLayout: [],
      propertyDefs: [],
      attributeMap: [],
      category: ComponentCategory.LOGIC,
      helpText: name,
      models: {
        digital: { executeFn: () => {} },
      },
    });
  }
  return registry;
}

// ---------------------------------------------------------------------------
// JSON format (save.ts / load.ts) round-trip tests
// ---------------------------------------------------------------------------

describe("JSON format: digitalPinLoading round-trip", () => {
  it("preserves digitalPinLoading=all on save/load", () => {
    const circuit = new Circuit({ name: "PinLoadingAll" });
    circuit.metadata.digitalPinLoading = "all";

    const registry = makeRegistry();
    const json = serializeJson(circuit);
    const loaded = deserializeJson(json, registry);

    expect(loaded.metadata.digitalPinLoading).toBe("all");
  });

  it("preserves digitalPinLoading=none on save/load", () => {
    const circuit = new Circuit({ name: "PinLoadingNone" });
    circuit.metadata.digitalPinLoading = "none";

    const registry = makeRegistry();
    const json = serializeJson(circuit);
    const loaded = deserializeJson(json, registry);

    expect(loaded.metadata.digitalPinLoading).toBe("none");
  });

  it("preserves digitalPinLoading=cross-domain on save/load", () => {
    const circuit = new Circuit({ name: "PinLoadingCross" });
    circuit.metadata.digitalPinLoading = "cross-domain";

    const registry = makeRegistry();
    const json = serializeJson(circuit);
    const loaded = deserializeJson(json, registry);

    expect(loaded.metadata.digitalPinLoading).toBe("cross-domain");
  });

  it("absent digitalPinLoading on load defaults to undefined", () => {
    const circuit = new Circuit({ name: "NoLoading" });
    // digitalPinLoading deliberately not set

    const registry = makeRegistry();
    const json = serializeJson(circuit);
    const loaded = deserializeJson(json, registry);

    expect(loaded.metadata.digitalPinLoading).toBeUndefined();
  });

  it("preserves digitalPinLoadingOverrides with label anchor on save/load", () => {
    const circuit = new Circuit({ name: "OverridesLabel" });
    circuit.metadata.digitalPinLoadingOverrides = [
      { anchor: { type: "label", label: "CLK" }, loading: "loaded" },
      { anchor: { type: "label", label: "DATA" }, loading: "ideal" },
    ];

    const registry = makeRegistry();
    const json = serializeJson(circuit);
    const loaded = deserializeJson(json, registry);

    expect(loaded.metadata.digitalPinLoadingOverrides).toHaveLength(2);
    expect(loaded.metadata.digitalPinLoadingOverrides![0]).toEqual({
      anchor: { type: "label", label: "CLK" },
      loading: "loaded",
    });
    expect(loaded.metadata.digitalPinLoadingOverrides![1]).toEqual({
      anchor: { type: "label", label: "DATA" },
      loading: "ideal",
    });
  });

  it("preserves digitalPinLoadingOverrides with pin anchor on save/load", () => {
    const circuit = new Circuit({ name: "OverridesPin" });
    circuit.metadata.digitalPinLoadingOverrides = [
      {
        anchor: { type: "pin", instanceId: "uuid-123", pinLabel: "Q" },
        loading: "loaded",
      },
    ];

    const registry = makeRegistry();
    const json = serializeJson(circuit);
    const loaded = deserializeJson(json, registry);

    expect(loaded.metadata.digitalPinLoadingOverrides).toHaveLength(1);
    expect(loaded.metadata.digitalPinLoadingOverrides![0]).toEqual({
      anchor: { type: "pin", instanceId: "uuid-123", pinLabel: "Q" },
      loading: "loaded",
    });
  });

  it("preserves both digitalPinLoading and overrides together", () => {
    const circuit = new Circuit({ name: "BothFields" });
    circuit.metadata.digitalPinLoading = "all";
    circuit.metadata.digitalPinLoadingOverrides = [
      { anchor: { type: "label", label: "NET1" }, loading: "ideal" },
    ];

    const registry = makeRegistry();
    const json = serializeJson(circuit);
    const loaded = deserializeJson(json, registry);

    expect(loaded.metadata.digitalPinLoading).toBe("all");
    expect(loaded.metadata.digitalPinLoadingOverrides).toHaveLength(1);
    expect(loaded.metadata.digitalPinLoadingOverrides![0].anchor).toEqual({
      type: "label",
      label: "NET1",
    });
    expect(loaded.metadata.digitalPinLoadingOverrides![0].loading).toBe("ideal");
  });

  it("strips engineType field present in old files", () => {
    // Simulate an old file that has engineType in it
    const doc = {
      version: 1,
      metadata: {
        name: "OldFormat",
        description: "",
        measurementOrdering: [],
        isGeneric: false,
        engineType: "analog",
      },
      elements: [],
      wires: [],
    };

    const registry = makeRegistry();
    const loaded = deserializeJson(JSON.stringify(doc), registry);

    // engineType must not be on the metadata object at all
    expect("engineType" in loaded.metadata).toBe(false);
  });

  it("old file with engineType still loads name and description correctly", () => {
    const doc = {
      version: 1,
      metadata: {
        name: "OldWithEngine",
        description: "legacy circuit",
        measurementOrdering: ["A"],
        isGeneric: false,
        engineType: "digital",
      },
      elements: [],
      wires: [],
    };

    const registry = makeRegistry();
    const loaded = deserializeJson(JSON.stringify(doc), registry);

    expect(loaded.metadata.name).toBe("OldWithEngine");
    expect(loaded.metadata.description).toBe("legacy circuit");
    expect(loaded.metadata.measurementOrdering).toEqual(["A"]);
  });
});

// ---------------------------------------------------------------------------
// DTS format (dts-serializer.ts / dts-deserializer.ts) round-trip tests
// ---------------------------------------------------------------------------

describe("DTS format: digitalPinLoading round-trip", () => {
  it("preserves digitalPinLoading=all on DTS save/load", () => {
    const circuit = new Circuit({ name: "DtsPinLoadingAll" });
    circuit.metadata.digitalPinLoading = "all";

    const registry = makeRegistry();
    const dts = serializeDts(circuit);
    const { circuit: loaded } = deserializeDts(dts, registry);

    expect(loaded.metadata.digitalPinLoading).toBe("all");
  });

  it("preserves digitalPinLoading=none on DTS save/load", () => {
    const circuit = new Circuit({ name: "DtsPinLoadingNone" });
    circuit.metadata.digitalPinLoading = "none";

    const registry = makeRegistry();
    const dts = serializeDts(circuit);
    const { circuit: loaded } = deserializeDts(dts, registry);

    expect(loaded.metadata.digitalPinLoading).toBe("none");
  });

  it("preserves digitalPinLoading=cross-domain on DTS save/load", () => {
    const circuit = new Circuit({ name: "DtsPinLoadingCross" });
    circuit.metadata.digitalPinLoading = "cross-domain";

    const registry = makeRegistry();
    const dts = serializeDts(circuit);
    const { circuit: loaded } = deserializeDts(dts, registry);

    expect(loaded.metadata.digitalPinLoading).toBe("cross-domain");
  });

  it("absent digitalPinLoading on DTS load defaults to undefined", () => {
    const circuit = new Circuit({ name: "DtsNoLoading" });

    const registry = makeRegistry();
    const dts = serializeDts(circuit);
    const { circuit: loaded } = deserializeDts(dts, registry);

    expect(loaded.metadata.digitalPinLoading).toBeUndefined();
  });

  it("stores digitalPinLoading in DTS attributes field", () => {
    const circuit = new Circuit({ name: "DtsAttrCheck" });
    circuit.metadata.digitalPinLoading = "none";

    const dts = serializeDts(circuit);
    const parsed = JSON.parse(dts) as {
      circuit: { attributes?: Record<string, string> };
    };

    expect(parsed.circuit.attributes).toBeDefined();
    expect(parsed.circuit.attributes!["digitalPinLoading"]).toBe("none");
  });

  it("preserves digitalPinLoadingOverrides with label anchor on DTS save/load", () => {
    const circuit = new Circuit({ name: "DtsOverridesLabel" });
    circuit.metadata.digitalPinLoadingOverrides = [
      { anchor: { type: "label", label: "CLK" }, loading: "loaded" },
    ];

    const registry = makeRegistry();
    const dts = serializeDts(circuit);
    const { circuit: loaded } = deserializeDts(dts, registry);

    expect(loaded.metadata.digitalPinLoadingOverrides).toHaveLength(1);
    expect(loaded.metadata.digitalPinLoadingOverrides![0]).toEqual({
      anchor: { type: "label", label: "CLK" },
      loading: "loaded",
    });
  });

  it("stores overrides as JSON string in DTS attributes field", () => {
    const circuit = new Circuit({ name: "DtsOverridesAttr" });
    circuit.metadata.digitalPinLoadingOverrides = [
      { anchor: { type: "label", label: "CLK" }, loading: "loaded" },
    ];

    const dts = serializeDts(circuit);
    const parsed = JSON.parse(dts) as {
      circuit: { attributes?: Record<string, string> };
    };

    expect(parsed.circuit.attributes).toBeDefined();
    const overridesStr = parsed.circuit.attributes!["digitalPinLoadingOverrides"];
    expect(typeof overridesStr).toBe("string");
    const overrides = JSON.parse(overridesStr) as unknown[];
    expect(overrides).toHaveLength(1);
    expect((overrides[0] as { anchor: { label: string } }).anchor.label).toBe("CLK");
  });

  it("preserves pin-anchor overrides on DTS round-trip", () => {
    const circuit = new Circuit({ name: "DtsPinAnchor" });
    circuit.metadata.digitalPinLoadingOverrides = [
      {
        anchor: { type: "pin", instanceId: "abc-123", pinLabel: "OUT" },
        loading: "ideal",
      },
    ];

    const registry = makeRegistry();
    const dts = serializeDts(circuit);
    const { circuit: loaded } = deserializeDts(dts, registry);

    expect(loaded.metadata.digitalPinLoadingOverrides).toHaveLength(1);
    expect(loaded.metadata.digitalPinLoadingOverrides![0]).toEqual({
      anchor: { type: "pin", instanceId: "abc-123", pinLabel: "OUT" },
      loading: "ideal",
    });
  });

  it("no attributes field when neither digitalPinLoading nor overrides set", () => {
    const circuit = new Circuit({ name: "DtsNoAttrs" });

    const dts = serializeDts(circuit);
    const parsed = JSON.parse(dts) as {
      circuit: { attributes?: Record<string, string> };
    };

    expect(parsed.circuit.attributes).toBeUndefined();
  });
});
