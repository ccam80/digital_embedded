import { describe, it, expect } from "vitest";
import {
  defineStateSchema,
  applyInitialValues,
  assertPoolIsSoleMutableState,
  CAP_COMPANION_SLOTS,
  L_COMPANION_SLOTS,
  suffixed,
  type SlotDescriptor,
  type StateSchema,
  type SchemaViolation,
} from "../state-schema.js";
import type { StatePoolRef } from "../../../core/analog-types.js";

function makePool(size: number): StatePoolRef {
  return { state0: new Float64Array(size), state1: new Float64Array(size) } as unknown as StatePoolRef;
}

describe("defineStateSchema", () => {
  it("builds frozen schema with correct size and indexOf", () => {
    const schema = defineStateSchema("TestElement", [
      { name: "GEQ", doc: "conductance", init: { kind: "zero" } },
      { name: "IEQ", doc: "history current", init: { kind: "zero" } },
    ]);
    expect(schema.owner).toBe("TestElement");
    expect(schema.size).toBe(2);
    expect(schema.indexOf.get("GEQ")).toBe(0);
    expect(schema.indexOf.get("IEQ")).toBe(1);
  });

  it("schema object is frozen", () => {
    const schema = defineStateSchema("TestElement", [
      { name: "A", doc: "slot A", init: { kind: "zero" } },
    ]);
    expect(Object.isFrozen(schema)).toBe(true);
    expect(Object.isFrozen(schema.slots)).toBe(true);
  });

  it("throws on duplicate slot names", () => {
    expect(() =>
      defineStateSchema("BadElement", [
        { name: "GEQ", doc: "first", init: { kind: "zero" } },
        { name: "GEQ", doc: "duplicate", init: { kind: "zero" } },
      ])
    ).toThrow('defineStateSchema(BadElement): duplicate slot name "GEQ"');
  });

  it("size equals slots array length", () => {
    const slots: SlotDescriptor[] = [
      { name: "A", doc: "a", init: { kind: "zero" } },
      { name: "B", doc: "b", init: { kind: "constant", value: 1.5 } },
      { name: "C", doc: "c", init: { kind: "fromParams", compute: (p) => p["x"] ?? 0 } },
    ];
    const schema = defineStateSchema("Elem", slots);
    expect(schema.size).toBe(3);
  });
});

describe("applyInitialValues", () => {
  it("zero-initialises slots with kind zero", () => {
    const schema = defineStateSchema("E", [
      { name: "A", doc: "a", init: { kind: "zero" } },
      { name: "B", doc: "b", init: { kind: "zero" } },
    ]);
    const pool = makePool(4);
    pool.state0[0] = 99;
    pool.state0[1] = 88;
    applyInitialValues(schema, pool, 0, {});
    expect(pool.state0[0]).toBe(0);
    expect(pool.state0[1]).toBe(0);
  });

  it("sets constant initial values", () => {
    const schema = defineStateSchema("E", [
      { name: "A", doc: "a", init: { kind: "constant", value: 3.14 } },
    ]);
    const pool = makePool(2);
    applyInitialValues(schema, pool, 0, {});
    expect(pool.state0[0]).toBe(3.14);
  });

  it("uses fromParams compute for param-dependent slots", () => {
    const schema = defineStateSchema("E", [
      { name: "RB_EFF", doc: "effective base resistance", init: { kind: "fromParams", compute: (p) => p["RB"] ?? 0 } },
    ]);
    const pool = makePool(2);
    applyInitialValues(schema, pool, 0, { RB: 100.0 });
    expect(pool.state0[0]).toBe(100.0);
  });

  it("respects base offset when writing", () => {
    const schema = defineStateSchema("E", [
      { name: "A", doc: "a", init: { kind: "constant", value: 5 } },
      { name: "B", doc: "b", init: { kind: "constant", value: 7 } },
    ]);
    const pool = makePool(6);
    applyInitialValues(schema, pool, 2, {});
    expect(pool.state0[0]).toBe(0);
    expect(pool.state0[1]).toBe(0);
    expect(pool.state0[2]).toBe(5);
    expect(pool.state0[3]).toBe(7);
  });
});

describe("assertPoolIsSoleMutableState", () => {
  it("returns empty violations when no scalar fields mutate", () => {
    const obj = { stateBaseOffset: 0 };
    const violations = assertPoolIsSoleMutableState("E", obj, () => {});
    expect(violations).toHaveLength(0);
  });

  it("detects a mutated scalar field", () => {
    const obj = { myVar: 1.0, stateBaseOffset: 0 };
    const violations = assertPoolIsSoleMutableState("E", obj, () => {
      obj.myVar = 2.0;
    });
    expect(violations).toHaveLength(1);
    expect(violations[0].field).toBe("myVar");
    expect(violations[0].before).toBe(1.0);
    expect(violations[0].after).toBe(2.0);
    expect(violations[0].owner).toBe("E");
  });

  it("does not flag NaN to NaN transitions as violations", () => {
    const obj: { x: number } = { x: NaN };
    const violations = assertPoolIsSoleMutableState("E", obj, () => {
      obj.x = NaN;
    });
    expect(violations).toHaveLength(0);
  });

  it("returns SchemaViolation shape with owner field before after", () => {
    const obj = { val: 0 };
    const violations: SchemaViolation[] = assertPoolIsSoleMutableState("MyOwner", obj, () => {
      obj.val = 42;
    });
    expect(violations[0].owner).toBe("MyOwner");
    expect(violations[0].field).toBe("val");
    expect(violations[0].before).toBe(0);
    expect(violations[0].after).toBe(42);
  });
});

describe("CAP_COMPANION_SLOTS", () => {
  it("has exactly 3 slots GEQ IEQ V_PREV", () => {
    expect(CAP_COMPANION_SLOTS).toHaveLength(3);
    expect(CAP_COMPANION_SLOTS[0].name).toBe("GEQ");
    expect(CAP_COMPANION_SLOTS[1].name).toBe("IEQ");
    expect(CAP_COMPANION_SLOTS[2].name).toBe("V_PREV");
  });

  it("is frozen", () => {
    expect(Object.isFrozen(CAP_COMPANION_SLOTS)).toBe(true);
  });

  it("all slots have kind zero init", () => {
    for (const slot of CAP_COMPANION_SLOTS) {
      expect(slot.init.kind).toBe("zero");
    }
  });

  it("spreads correctly into defineStateSchema", () => {
    const schema = defineStateSchema("CapTest", [
      ...CAP_COMPANION_SLOTS,
      { name: "I_PREV", doc: "previous current", init: { kind: "zero" } },
    ]);
    expect(schema.size).toBe(4);
    expect(schema.indexOf.get("GEQ")).toBe(0);
    expect(schema.indexOf.get("IEQ")).toBe(1);
    expect(schema.indexOf.get("V_PREV")).toBe(2);
    expect(schema.indexOf.get("I_PREV")).toBe(3);
  });
});

describe("L_COMPANION_SLOTS", () => {
  it("has exactly 3 slots GEQ IEQ I_PREV", () => {
    expect(L_COMPANION_SLOTS).toHaveLength(3);
    expect(L_COMPANION_SLOTS[0].name).toBe("GEQ");
    expect(L_COMPANION_SLOTS[1].name).toBe("IEQ");
    expect(L_COMPANION_SLOTS[2].name).toBe("I_PREV");
  });

  it("is frozen", () => {
    expect(Object.isFrozen(L_COMPANION_SLOTS)).toBe(true);
  });
});

describe("suffixed", () => {
  it("appends suffix to each slot name", () => {
    const result = suffixed(CAP_COMPANION_SLOTS, "_CS");
    expect(result[0].name).toBe("GEQ_CS");
    expect(result[1].name).toBe("IEQ_CS");
    expect(result[2].name).toBe("V_PREV_CS");
  });

  it("returns a frozen array", () => {
    const result = suffixed(L_COMPANION_SLOTS, "_L");
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("does not mutate the original fragment", () => {
    suffixed(CAP_COMPANION_SLOTS, "_TEST");
    expect(CAP_COMPANION_SLOTS[0].name).toBe("GEQ");
  });

  it("preserves doc and init from original fragment", () => {
    const result = suffixed(CAP_COMPANION_SLOTS, "_X");
    expect(result[0].doc).toBe(CAP_COMPANION_SLOTS[0].doc);
    expect(result[0].init).toEqual(CAP_COMPANION_SLOTS[0].init);
  });

  it("supports crystal-style multi-fragment schema via suffixed spread", () => {
    const schema = defineStateSchema("Crystal", [
      ...suffixed(L_COMPANION_SLOTS, "_L"),
      ...suffixed(CAP_COMPANION_SLOTS, "_CS"),
      ...suffixed(CAP_COMPANION_SLOTS, "_C0"),
    ]);
    expect(schema.size).toBe(9);
    expect(schema.indexOf.get("GEQ_L")).toBe(0);
    expect(schema.indexOf.get("GEQ_CS")).toBe(3);
    expect(schema.indexOf.get("GEQ_C0")).toBe(6);
  });
});

describe("StateSchema type export", () => {
  it("StateSchema is usable at runtime via defineStateSchema return value", () => {
    const schema: StateSchema = defineStateSchema("TypeTest", [
      { name: "X", doc: "x", init: { kind: "zero" } },
    ]);
    expect(schema.owner).toBe("TypeTest");
  });
});
