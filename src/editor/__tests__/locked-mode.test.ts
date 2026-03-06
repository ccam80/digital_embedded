import { describe, it, expect } from "vitest";
import { LockedModeGuard } from "../locked-mode.js";
import type { CircuitElement } from "@/core/element";
import type { Rect } from "@/core/renderer-interface";
import type { Pin } from "@/core/pin";
import { PropertyBag } from "@/core/properties";
import type { PropertyValue } from "@/core/properties";
import type { RenderContext } from "@/core/renderer-interface";

// ---------------------------------------------------------------------------
// Minimal CircuitElement stub for locked-mode tests
// ---------------------------------------------------------------------------

function makeElement(typeId: string): CircuitElement {
  return {
    typeId,
    instanceId: `inst-${typeId}`,
    position: { x: 0, y: 0 },
    rotation: 0,
    mirror: false,
    getPins(): Pin[] {
      return [];
    },
    getBoundingBox(): Rect {
      return { x: 0, y: 0, width: 10, height: 10 };
    },
    getProperties(): PropertyBag {
      return new PropertyBag();
    },
    draw(_ctx: RenderContext): void {},
    serialize() {
      return {
        typeId,
        instanceId: `inst-${typeId}`,
        position: { x: 0, y: 0 },
        rotation: 0 as const,
        mirror: false,
        properties: {},
      };
    },
    getHelpText(): string {
      return "";
    },
    getAttribute(_name: string): PropertyValue | undefined {
      return undefined;
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("LockedMode", () => {
  it("preventsEditing", () => {
    const guard = new LockedModeGuard();
    guard.setLocked(true);
    expect(() => guard.guardMutation("move")).toThrow(
      "Circuit is locked. Unlock to edit.",
    );
  });

  it("allowsInteraction", () => {
    const guard = new LockedModeGuard();
    guard.setLocked(true);
    const inElement = makeElement("In");
    expect(guard.canInteract(inElement)).toBe(true);
  });

  it("blocksNonInteractive", () => {
    const guard = new LockedModeGuard();
    guard.setLocked(true);
    const andElement = makeElement("And");
    expect(guard.canInteract(andElement)).toBe(false);
  });

  it("unlockAllowsEditing", () => {
    const guard = new LockedModeGuard();
    guard.setLocked(true);
    guard.setLocked(false);
    expect(() => guard.guardMutation("move")).not.toThrow();
  });
});
