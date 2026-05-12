import { describe, it, expect } from "vitest";

import { createDefaultRegistry } from "../../../components/register-all.js";
import { ComponentRegistry } from "../../../core/registry.js";
import { auditNgspiceLoadOrderTables } from "../ngspice-load-order-audit.js";

describe("ngspice-load-order audit", () => {
  it("passes against the canonical default registry", () => {
    expect(() => createDefaultRegistry()).not.toThrow();
  });

  it("throws when a typeId in the load-order tables is not registered", () => {
    const empty = new ComponentRegistry();
    expect(() => auditNgspiceLoadOrderTables(empty)).toThrow(
      /not a registered component/,
    );
  });
});
