import { describe, it, expect } from "vitest";
import { Circuit, Wire } from "../circuit.js";

describe("splitWiresAtJunctions", () => {
  it("splits vertical wire at horizontal wire endpoint (T-junction)", () => {
    const c = new Circuit();
    c.addWire(new Wire({ x: 440, y: 180 }, { x: 440, y: 420 }));
    c.addWire(new Wire({ x: 440, y: 280 }, { x: 520, y: 280 }));
    expect(c.wires.length).toBe(2);

    c.splitWiresAtJunctions();

    // Vertical wire should be split into two at y=280
    expect(c.wires.length).toBe(3);
    // All three wires should share endpoints properly
    const endpoints = c.wires.flatMap(w => [`${w.start.x},${w.start.y}`, `${w.end.x},${w.end.y}`]);
    expect(endpoints.filter(e => e === "440,280").length).toBe(3); // shared by all 3
  });

  it("does not split when no T-junction exists", () => {
    const c = new Circuit();
    c.addWire(new Wire({ x: 0, y: 0 }, { x: 100, y: 0 }));
    c.addWire(new Wire({ x: 200, y: 0 }, { x: 300, y: 0 }));
    c.splitWiresAtJunctions();
    expect(c.wires.length).toBe(2);
  });

  it("splits wire at multiple interior points", () => {
    const c = new Circuit();
    // Long vertical wire
    c.addWire(new Wire({ x: 0, y: 0 }, { x: 0, y: 300 }));
    // Two horizontal wires touching its interior
    c.addWire(new Wire({ x: 0, y: 100 }, { x: 50, y: 100 }));
    c.addWire(new Wire({ x: 0, y: 200 }, { x: 50, y: 200 }));
    c.splitWiresAtJunctions();
    // Vertical wire split into 3 segments + 2 horizontal = 5
    expect(c.wires.length).toBe(5);
  });
});
