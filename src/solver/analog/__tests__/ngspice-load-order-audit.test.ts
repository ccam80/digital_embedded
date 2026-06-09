import { describe, it, expect } from "vitest";

import { createDefaultRegistry } from "../../../components/register-all.js";
import { ComponentRegistry, type AnalogFactory } from "../../../core/registry.js";
import { auditNgspiceLoadOrderTables } from "../ngspice-load-order-audit.js";

// A throwaway inline factory: the audit only reads each model entry's `spice`
// block and never invokes the factory, so a stub is sufficient.
const STUB_FACTORY = (() => undefined) as unknown as AnalogFactory;

describe("ngspice netlist-device audit", () => {
  it("passes against the canonical default registry", () => {
    expect(() => createDefaultRegistry()).not.toThrow();
  });

  it("throws when an inline device model declares a family but no deckNodeTokens", () => {
    const reg = new ComponentRegistry();
    reg.register({
      name: "BadInlineDevice",
      typeId: -1,
      internalOnly: true,
      modelRegistry: {
        m: {
          kind: "inline",
          factory: STUB_FACTORY,
          paramDefs: [],
          params: {},
          spice: { device: "RES" }, // inline single-card device must list deckNodeTokens
        },
      },
    });
    expect(() => auditNgspiceLoadOrderTables(reg)).toThrow(/no spice\.deckNodeTokens/);
  });

  it("throws when a composite (netlist) model declares deckNodeTokens", () => {
    const reg = new ComponentRegistry();
    reg.register({
      name: "BadComposite",
      typeId: -1,
      internalOnly: true,
      modelRegistry: {
        m: {
          kind: "netlist",
          netlist: { ports: [], params: {}, elements: [], internalNetCount: 0, netlist: [] },
          paramDefs: [],
          params: {},
          // A composite is numbered by its sub-element expansion, so declaring a
          // single deck line's node tokens is a category error.
          spice: { device: "CAP", deckNodeTokens: ["pos", "neg"] },
        },
      },
    });
    expect(() => auditNgspiceLoadOrderTables(reg)).toThrow(/composite.*deckNodeTokens/);
  });
});
