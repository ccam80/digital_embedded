/**
 * Tests for label-tools: autoNumberLabels, addLabelPrefix, removeLabelPrefix,
 * renameTunnel.
 */

import { describe, it, expect } from "vitest";
import {
  autoNumberLabels,
  addLabelPrefix,
  removeLabelPrefix,
  renameTunnel,
} from "../label-tools.js";
import { Circuit } from "@/core/circuit";
import { PropertyBag } from "@/core/properties";

// ---------------------------------------------------------------------------
// Stub element factory
// ---------------------------------------------------------------------------

function makeElement(typeId: string, label?: string) {
  const bag = new PropertyBag();
  if (label !== undefined) {
    bag.set("label", label);
  }
  return {
    typeId,
    instanceId: `${typeId}-${Math.random()}`,
    position: { x: 0, y: 0 },
    rotation: 0 as const,
    mirror: false,
    getPins: () => [],
    getProperties: () => bag,
    draw: () => {},
    getBoundingBox: () => ({ x: 0, y: 0, width: 2, height: 2 }),
    serialize: () => ({
      typeId,
      instanceId: "x",
      position: { x: 0, y: 0 },
      rotation: 0 as const,
      mirror: false,
      properties: {},
    }),
    getHelpText: () => "",
    getAttribute: (name: string) => (bag.has(name) ? bag.get(name) : undefined),
  };
}

function getLabel(el: ReturnType<typeof makeElement>): string {
  const bag = el.getProperties();
  return bag.has("label") ? String(bag.get("label")) : "";
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("LabelTools", () => {
  it("autoNumbersSequentially", () => {
    const elements = [
      makeElement("Register", "old0"),
      makeElement("Register", "old1"),
      makeElement("Register", "old2"),
    ];

    const cmd = autoNumberLabels(elements as any, "R", 1);
    cmd.execute();

    expect(getLabel(elements[0]!)).toBe("R1");
    expect(getLabel(elements[1]!)).toBe("R2");
    expect(getLabel(elements[2]!)).toBe("R3");
  });

  it("autoNumberUndoRestoresOriginals", () => {
    const elements = [
      makeElement("Register", "old0"),
      makeElement("Register", "old1"),
    ];

    const cmd = autoNumberLabels(elements as any, "R", 0);
    cmd.execute();
    cmd.undo();

    expect(getLabel(elements[0]!)).toBe("old0");
    expect(getLabel(elements[1]!)).toBe("old1");
  });

  it("addsPrefixToAllLabels", () => {
    const elements = [
      makeElement("Register", "Reg"),
      makeElement("Register", "Acc"),
    ];

    const cmd = addLabelPrefix(elements as any, "ALU_");
    cmd.execute();

    expect(getLabel(elements[0]!)).toBe("ALU_Reg");
    expect(getLabel(elements[1]!)).toBe("ALU_Acc");
  });

  it("addPrefixUndoRestores", () => {
    const elements = [makeElement("Register", "Reg")];

    const cmd = addLabelPrefix(elements as any, "X_");
    cmd.execute();
    cmd.undo();

    expect(getLabel(elements[0]!)).toBe("Reg");
  });

  it("removesPrefixFromLabels", () => {
    const elements = [
      makeElement("Register", "ALU_Reg"),
      makeElement("Register", "ALU_Acc"),
    ];

    const cmd = removeLabelPrefix(elements as any, "ALU_");
    cmd.execute();

    expect(getLabel(elements[0]!)).toBe("Reg");
    expect(getLabel(elements[1]!)).toBe("Acc");
  });

  it("removePrefixSkipsNonMatching", () => {
    const elements = [
      makeElement("Register", "ALU_Reg"),
      makeElement("Register", "Other"),
    ];

    const cmd = removeLabelPrefix(elements as any, "ALU_");
    cmd.execute();

    expect(getLabel(elements[0]!)).toBe("Reg");
    expect(getLabel(elements[1]!)).toBe("Other"); // unchanged
  });

  it("tunnelRenameAffectsAllInstances", () => {
    const t1 = makeElement("Tunnel", "Data");
    const t2 = makeElement("Tunnel", "Data");
    const t3 = makeElement("Tunnel", "Data");
    const other = makeElement("Tunnel", "Clock");

    const circuit = new Circuit();
    circuit.addElement(t1 as any);
    circuit.addElement(t2 as any);
    circuit.addElement(t3 as any);
    circuit.addElement(other as any);

    const cmd = renameTunnel(circuit, "Data", "DataBus");
    cmd.execute();

    expect(getLabel(t1)).toBe("DataBus");
    expect(getLabel(t2)).toBe("DataBus");
    expect(getLabel(t3)).toBe("DataBus");
    expect(getLabel(other)).toBe("Clock"); // not renamed
  });

  it("tunnelRenameUndoRestores", () => {
    const t1 = makeElement("Tunnel", "Data");
    const t2 = makeElement("Tunnel", "Data");

    const circuit = new Circuit();
    circuit.addElement(t1 as any);
    circuit.addElement(t2 as any);

    const cmd = renameTunnel(circuit, "Data", "DataBus");
    cmd.execute();
    cmd.undo();

    expect(getLabel(t1)).toBe("Data");
    expect(getLabel(t2)).toBe("Data");
  });
});
