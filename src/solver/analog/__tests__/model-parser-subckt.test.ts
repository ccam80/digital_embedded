import { describe, it, expect } from "vitest";
import {
  parseSubcircuit,
  type ParsedSubcircuit,
  type ParsedElement,
} from "../model-parser.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getElement(sc: ParsedSubcircuit, name: string): ParsedElement {
  const el = sc.elements.find((e) => e.name === name.toUpperCase());
  if (!el) throw new Error(`Element "${name}" not found in parsed subcircuit`);
  return el;
}

// ---------------------------------------------------------------------------
// Basic structure
// ---------------------------------------------------------------------------

describe("parseSubcircuit — basic structure", () => {
  const TEXT = `
.SUBCKT myopamp inp inn out vcc vee
R1 inp 1 10k
R2 inn 2 10k
.ENDS myopamp
`.trim();

  it("returns the correct subcircuit name", () => {
    const sc = parseSubcircuit(TEXT);
    expect(sc.name).toBe("myopamp");
  });

  it("returns ports in declaration order", () => {
    const sc = parseSubcircuit(TEXT);
    expect(sc.ports).toEqual(["inp", "inn", "out", "vcc", "vee"]);
  });

  it("returns two elements", () => {
    const sc = parseSubcircuit(TEXT);
    expect(sc.elements).toHaveLength(2);
  });

  it("starts with empty models and params when none present", () => {
    const sc = parseSubcircuit(TEXT);
    expect(sc.models).toHaveLength(0);
    expect(sc.params).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Comments and blank lines
// ---------------------------------------------------------------------------

describe("parseSubcircuit — comments and blank lines", () => {
  const TEXT = `
.SUBCKT demo a b

* This is a comment
R1 a b 1k
; semicolon comment
R2 a b 2k

.ENDS demo
`.trim();

  it("ignores full-line * comments", () => {
    const sc = parseSubcircuit(TEXT);
    expect(sc.elements).toHaveLength(2);
  });

  it("ignores full-line ; comments", () => {
    const sc = parseSubcircuit(TEXT);
    const names = sc.elements.map((e) => e.name);
    expect(names).not.toContain(";");
    expect(names).not.toContain("*");
  });

  it("ignores blank lines", () => {
    const sc = parseSubcircuit(TEXT);
    expect(sc.elements).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Element type R (resistor)
// ---------------------------------------------------------------------------

describe("parseSubcircuit — R element", () => {
  const TEXT = `.SUBCKT test a b\nR1 a b 10k\n.ENDS`;

  it("parses R type correctly", () => {
    const sc = parseSubcircuit(TEXT);
    const r = getElement(sc, "R1");
    expect(r.type).toBe("R");
  });

  it("captures two nodes", () => {
    const sc = parseSubcircuit(TEXT);
    const r = getElement(sc, "R1");
    expect(r.nodes).toEqual(["a", "b"]);
  });

  it("parses value with k suffix", () => {
    const sc = parseSubcircuit(TEXT);
    const r = getElement(sc, "R1");
    expect(r.value).toBeCloseTo(10000);
  });
});

// ---------------------------------------------------------------------------
// Element type C (capacitor)
// ---------------------------------------------------------------------------

describe("parseSubcircuit — C element", () => {
  const TEXT = `.SUBCKT test a b\nC1 a b 100n\n.ENDS`;

  it("parses C type correctly", () => {
    const sc = parseSubcircuit(TEXT);
    const c = getElement(sc, "C1");
    expect(c.type).toBe("C");
  });

  it("parses value with n suffix", () => {
    const sc = parseSubcircuit(TEXT);
    const c = getElement(sc, "C1");
    expect(c.value).toBeCloseTo(100e-9);
  });
});

// ---------------------------------------------------------------------------
// Element type L (inductor)
// ---------------------------------------------------------------------------

describe("parseSubcircuit — L element", () => {
  const TEXT = `.SUBCKT test a b\nL1 a b 1u\n.ENDS`;

  it("parses L type correctly", () => {
    const sc = parseSubcircuit(TEXT);
    const l = getElement(sc, "L1");
    expect(l.type).toBe("L");
  });

  it("parses value with u suffix", () => {
    const sc = parseSubcircuit(TEXT);
    const l = getElement(sc, "L1");
    expect(l.value).toBeCloseTo(1e-6);
  });
});

// ---------------------------------------------------------------------------
// Element type D (diode)
// ---------------------------------------------------------------------------

describe("parseSubcircuit — D element", () => {
  const TEXT = `.SUBCKT test a b\nD1 a b 1N4148\n.ENDS`;

  it("parses D type correctly", () => {
    const sc = parseSubcircuit(TEXT);
    const d = getElement(sc, "D1");
    expect(d.type).toBe("D");
  });

  it("captures anode and cathode nodes", () => {
    const sc = parseSubcircuit(TEXT);
    const d = getElement(sc, "D1");
    expect(d.nodes).toEqual(["a", "b"]);
  });

  it("stores model name in uppercase", () => {
    const sc = parseSubcircuit(TEXT);
    const d = getElement(sc, "D1");
    expect(d.modelName).toBe("1N4148");
  });
});

// ---------------------------------------------------------------------------
// Element type Q (BJT)
// ---------------------------------------------------------------------------

describe("parseSubcircuit — Q element", () => {
  const TEXT = `.SUBCKT test c b e\nQ1 c b e NPN\n.ENDS`;

  it("parses Q type correctly", () => {
    const sc = parseSubcircuit(TEXT);
    const q = getElement(sc, "Q1");
    expect(q.type).toBe("Q");
  });

  it("captures c/b/e nodes", () => {
    const sc = parseSubcircuit(TEXT);
    const q = getElement(sc, "Q1");
    expect(q.nodes).toEqual(["c", "b", "e"]);
  });

  it("stores model name", () => {
    const sc = parseSubcircuit(TEXT);
    const q = getElement(sc, "Q1");
    expect(q.modelName).toBe("NPN");
  });
});

describe("parseSubcircuit — Q element with substrate", () => {
  const TEXT = `.SUBCKT test c b e sub\nQ1 c b e sub NPN\n.ENDS`;

  it("captures all four nodes with substrate", () => {
    const sc = parseSubcircuit(TEXT);
    const q = getElement(sc, "Q1");
    expect(q.nodes).toEqual(["c", "b", "e", "sub"]);
  });

  it("stores model name as last token", () => {
    const sc = parseSubcircuit(TEXT);
    const q = getElement(sc, "Q1");
    expect(q.modelName).toBe("NPN");
  });
});

// ---------------------------------------------------------------------------
// Element type M (MOSFET)
// ---------------------------------------------------------------------------

describe("parseSubcircuit — M element", () => {
  const TEXT = `.SUBCKT test d g s b\nM1 d g s b NMOS W=10u L=1u\n.ENDS`;

  it("parses M type correctly", () => {
    const sc = parseSubcircuit(TEXT);
    const m = getElement(sc, "M1");
    expect(m.type).toBe("M");
  });

  it("captures d/g/s/b nodes", () => {
    const sc = parseSubcircuit(TEXT);
    const m = getElement(sc, "M1");
    expect(m.nodes).toEqual(["d", "g", "s", "b"]);
  });

  it("stores model name", () => {
    const sc = parseSubcircuit(TEXT);
    const m = getElement(sc, "M1");
    expect(m.modelName).toBe("NMOS");
  });

  it("captures W parameter", () => {
    const sc = parseSubcircuit(TEXT);
    const m = getElement(sc, "M1");
    expect(m.params?.["W"]).toBeCloseTo(10e-6);
  });

  it("captures L parameter", () => {
    const sc = parseSubcircuit(TEXT);
    const m = getElement(sc, "M1");
    expect(m.params?.["L"]).toBeCloseTo(1e-6);
  });
});

// ---------------------------------------------------------------------------
// Element type J (JFET)
// ---------------------------------------------------------------------------

describe("parseSubcircuit — J element", () => {
  const TEXT = `.SUBCKT test d g s\nJ1 d g s NJFET\n.ENDS`;

  it("parses J type correctly", () => {
    const sc = parseSubcircuit(TEXT);
    const j = getElement(sc, "J1");
    expect(j.type).toBe("J");
  });

  it("captures d/g/s nodes", () => {
    const sc = parseSubcircuit(TEXT);
    const j = getElement(sc, "J1");
    expect(j.nodes).toEqual(["d", "g", "s"]);
  });

  it("stores model name", () => {
    const sc = parseSubcircuit(TEXT);
    const j = getElement(sc, "J1");
    expect(j.modelName).toBe("NJFET");
  });
});

// ---------------------------------------------------------------------------
// Element type V (voltage source)
// ---------------------------------------------------------------------------

describe("parseSubcircuit — V element", () => {
  it("parses plain numeric value", () => {
    const sc = parseSubcircuit(`.SUBCKT test p n\nV1 p n 5\n.ENDS`);
    const v = getElement(sc, "V1");
    expect(v.type).toBe("V");
    expect(v.nodes).toEqual(["p", "n"]);
    expect(v.value).toBeCloseTo(5);
  });

  it("parses DC keyword followed by value", () => {
    const sc = parseSubcircuit(`.SUBCKT test p n\nV1 p n DC 3.3\n.ENDS`);
    const v = getElement(sc, "V1");
    expect(v.value).toBeCloseTo(3.3);
  });

  it("captures nodes without value", () => {
    const sc = parseSubcircuit(`.SUBCKT test p n\nV1 p n\n.ENDS`);
    const v = getElement(sc, "V1");
    expect(v.nodes).toEqual(["p", "n"]);
    expect(v.value).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Element type I (current source)
// ---------------------------------------------------------------------------

describe("parseSubcircuit — I element", () => {
  it("parses current source with DC value", () => {
    const sc = parseSubcircuit(`.SUBCKT test p n\nI1 p n DC 1m\n.ENDS`);
    const i = getElement(sc, "I1");
    expect(i.type).toBe("I");
    expect(i.value).toBeCloseTo(1e-3);
  });
});

// ---------------------------------------------------------------------------
// Element type X (subcircuit instance)
// ---------------------------------------------------------------------------

describe("parseSubcircuit — X element", () => {
  const TEXT = `.SUBCKT test a b c\nX1 a b c MySubckt\n.ENDS`;

  it("parses X type correctly", () => {
    const sc = parseSubcircuit(TEXT);
    const x = getElement(sc, "X1");
    expect(x.type).toBe("X");
  });

  it("captures all connection nodes", () => {
    const sc = parseSubcircuit(TEXT);
    const x = getElement(sc, "X1");
    expect(x.nodes).toEqual(["a", "b", "c"]);
  });

  it("stores subcircuit model name", () => {
    const sc = parseSubcircuit(TEXT);
    const x = getElement(sc, "X1");
    expect(x.modelName).toBe("MYSUBCKT");
  });
});

// ---------------------------------------------------------------------------
// Inline .MODEL statements
// ---------------------------------------------------------------------------

describe("parseSubcircuit — inline .MODEL", () => {
  const TEXT = `
.SUBCKT myopamp inp inn out vcc vee
Q1 3 1 4 NPN
Q2 3 2 5 NPN
.MODEL NPN NPN(IS=1e-14 BF=200)
.ENDS myopamp
`.trim();

  it("captures one inline model", () => {
    const sc = parseSubcircuit(TEXT);
    expect(sc.models).toHaveLength(1);
  });

  it("stores model name", () => {
    const sc = parseSubcircuit(TEXT);
    expect(sc.models[0].name).toBe("NPN");
  });

  it("stores device type", () => {
    const sc = parseSubcircuit(TEXT);
    expect(sc.models[0].deviceType).toBe("NPN");
  });

  it("parses IS parameter", () => {
    const sc = parseSubcircuit(TEXT);
    expect(sc.models[0].params["IS"]).toBeCloseTo(1e-14);
  });

  it("parses BF parameter", () => {
    const sc = parseSubcircuit(TEXT);
    expect(sc.models[0].params["BF"]).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// .PARAM defaults
// ---------------------------------------------------------------------------

describe("parseSubcircuit — .PARAM", () => {
  const TEXT = `
.SUBCKT amp in out
.PARAM gm=0.01 rout=1k
R1 in out rout
.ENDS amp
`.trim();

  it("captures GM param", () => {
    const sc = parseSubcircuit(TEXT);
    expect(sc.params["GM"]).toBeCloseTo(0.01);
  });

  it("captures ROUT param with suffix", () => {
    const sc = parseSubcircuit(TEXT);
    expect(sc.params["ROUT"]).toBeCloseTo(1000);
  });
});

// ---------------------------------------------------------------------------
// Value suffix parsing
// ---------------------------------------------------------------------------

describe("parseSubcircuit — value suffixes", () => {
  const suffixCases: Array<[string, string, number]> = [
    ["R1 a b 10k", "R1", 10e3],
    ["R2 a b 1m", "R2", 1e-3],
    ["C1 a b 100n", "C1", 100e-9],
    ["C2 a b 10u", "C2", 10e-6],
    ["L1 a b 1p", "L1", 1e-12],
    ["L2 a b 47f", "L2", 47e-15],
    ["R3 a b 1.5meg", "R3", 1.5e6],
  ];

  for (const [line, elName, expected] of suffixCases) {
    it(`parses "${line}" → ${expected}`, () => {
      const sc = parseSubcircuit(`.SUBCKT test a b\n${line}\n.ENDS`);
      const el = getElement(sc, elName);
      expect(el.value).toBeCloseTo(expected, 20);
    });
  }
});

// ---------------------------------------------------------------------------
// Full opamp example
// ---------------------------------------------------------------------------

describe("parseSubcircuit — full opamp example", () => {
  const TEXT = `
.SUBCKT myopamp inp inn out vcc vee
* Internal bias network
R1 inp 1 10k
R2 inn 2 10k
Q1 3 1 4 NPN
Q2 3 2 5 NPN
M1 6 7 8 9 NMOS W=10u L=1u
V1 vcc 0 DC 5
.MODEL NPN NPN(IS=1e-14 BF=200)
.PARAM gm=0.01
.ENDS myopamp
`.trim();

  it("returns correct name", () => {
    const sc = parseSubcircuit(TEXT);
    expect(sc.name).toBe("myopamp");
  });

  it("returns 5 ports", () => {
    const sc = parseSubcircuit(TEXT);
    expect(sc.ports).toHaveLength(5);
  });

  it("returns 6 elements", () => {
    const sc = parseSubcircuit(TEXT);
    expect(sc.elements).toHaveLength(6);
  });

  it("returns 1 inline model", () => {
    const sc = parseSubcircuit(TEXT);
    expect(sc.models).toHaveLength(1);
  });

  it("returns gm param", () => {
    const sc = parseSubcircuit(TEXT);
    expect(sc.params["GM"]).toBeCloseTo(0.01);
  });

  it("Q1 has correct nodes and model", () => {
    const sc = parseSubcircuit(TEXT);
    const q = getElement(sc, "Q1");
    expect(q.nodes).toEqual(["3", "1", "4"]);
    expect(q.modelName).toBe("NPN");
  });

  it("M1 has W and L params", () => {
    const sc = parseSubcircuit(TEXT);
    const m = getElement(sc, "M1");
    expect(m.params?.["W"]).toBeCloseTo(10e-6);
    expect(m.params?.["L"]).toBeCloseTo(1e-6);
  });
});

// ---------------------------------------------------------------------------
// Error cases
// ---------------------------------------------------------------------------

describe("parseSubcircuit — error: missing .ENDS", () => {
  it("throws with message about missing .ENDS", () => {
    expect(() =>
      parseSubcircuit(`.SUBCKT test a b\nR1 a b 1k`)
    ).toThrow();

    try {
      parseSubcircuit(`.SUBCKT test a b\nR1 a b 1k`);
    } catch (e: unknown) {
      expect((e as { message: string }).message).toMatch(/\.ENDS/i);
    }
  });
});

describe("parseSubcircuit — error: no .SUBCKT", () => {
  it("throws with message about missing .SUBCKT", () => {
    expect(() =>
      parseSubcircuit(`R1 a b 1k\n.ENDS`)
    ).toThrow();

    try {
      parseSubcircuit(`R1 a b 1k\n.ENDS`);
    } catch (e: unknown) {
      expect((e as { message: string }).message).toMatch(/\.SUBCKT/i);
    }
  });
});

describe("parseSubcircuit — error: no ports", () => {
  it("throws when .SUBCKT declares no ports", () => {
    expect(() =>
      parseSubcircuit(`.SUBCKT noports\nR1 a b 1k\n.ENDS`)
    ).toThrow();

    try {
      parseSubcircuit(`.SUBCKT noports\nR1 a b 1k\n.ENDS`);
    } catch (e: unknown) {
      expect((e as { message: string }).message).toMatch(/port/i);
    }
  });
});

describe("parseSubcircuit — error: unknown element prefix", () => {
  it("throws on unrecognised element prefix", () => {
    expect(() =>
      parseSubcircuit(`.SUBCKT test a b\nZ1 a b 1k\n.ENDS`)
    ).toThrow();

    try {
      parseSubcircuit(`.SUBCKT test a b\nZ1 a b 1k\n.ENDS`);
    } catch (e: unknown) {
      expect((e as { message: string }).message).toMatch(/Z/);
    }
  });
});

// ---------------------------------------------------------------------------
// Case-insensitive directive matching
// ---------------------------------------------------------------------------

describe("parseSubcircuit — case-insensitive directives", () => {
  it("accepts lowercase .subckt and .ends", () => {
    const sc = parseSubcircuit(`.subckt test a b\nr1 a b 1k\n.ends test`);
    expect(sc.name).toBe("test");
    expect(sc.elements).toHaveLength(1);
  });

  it("accepts mixed-case .Subckt", () => {
    const sc = parseSubcircuit(`.Subckt test a b\nR1 a b 1k\n.Ends`);
    expect(sc.name).toBe("test");
  });
});
