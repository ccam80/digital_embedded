import { describe, it, expect } from "vitest";
import { getParamMeta } from "../model-param-meta.js";
import {
  DIODE_DEFAULTS,
  BJT_NPN_DEFAULTS,
  BJT_PNP_DEFAULTS,
  MOSFET_NMOS_DEFAULTS,
  MOSFET_PMOS_DEFAULTS,
  JFET_N_DEFAULTS,
  JFET_P_DEFAULTS,
  TUNNEL_DIODE_DEFAULTS,
} from "../model-defaults.js";

describe("getParamMeta", () => {
  it("returns [] for an unrecognized device type", () => {
    expect(getParamMeta("UNKNOWN")).toEqual([]);
    expect(getParamMeta("")).toEqual([]);
    expect(getParamMeta("resistor")).toEqual([]);
  });

  describe("D (diode)", () => {
    const meta = getParamMeta("D");

    it("returns 14 params", () => {
      expect(meta).toHaveLength(14);
    });

    it("covers all keys in DIODE_DEFAULTS", () => {
      const metaKeys = meta.map((m) => m.key);
      for (const key of Object.keys(DIODE_DEFAULTS)) {
        expect(metaKeys).toContain(key);
      }
    });

    it("every entry has non-empty key, label, and description", () => {
      for (const entry of meta) {
        expect(entry.key.length).toBeGreaterThan(0);
        expect(entry.label.length).toBeGreaterThan(0);
        expect(entry.description.length).toBeGreaterThan(0);
      }
    });

    it("IS entry has correct label and unit", () => {
      const is = meta.find((m) => m.key === "IS");
      expect(is).toBeDefined();
      expect(is!.label).toBe("Saturation Current");
      expect(is!.unit).toBe("A");
    });
  });

  describe("NPN (BJT NPN)", () => {
    const meta = getParamMeta("NPN");

    it("returns 26 params", () => {
      expect(meta).toHaveLength(26);
    });

    it("covers all keys in BJT_NPN_DEFAULTS", () => {
      const metaKeys = meta.map((m) => m.key);
      for (const key of Object.keys(BJT_NPN_DEFAULTS)) {
        expect(metaKeys).toContain(key);
      }
    });

    it("IS entry has unit A", () => {
      const is = meta.find((m) => m.key === "IS");
      expect(is!.unit).toBe("A");
    });

    it("VAF entry has unit V", () => {
      const vaf = meta.find((m) => m.key === "VAF");
      expect(vaf!.unit).toBe("V");
    });
  });

  describe("PNP (BJT PNP)", () => {
    const meta = getParamMeta("PNP");

    it("returns 26 params", () => {
      expect(meta).toHaveLength(26);
    });

    it("covers all keys in BJT_PNP_DEFAULTS", () => {
      const metaKeys = meta.map((m) => m.key);
      for (const key of Object.keys(BJT_PNP_DEFAULTS)) {
        expect(metaKeys).toContain(key);
      }
    });
  });

  describe("NMOS (MOSFET NMOS)", () => {
    const meta = getParamMeta("NMOS");

    it("returns 25 params", () => {
      expect(meta).toHaveLength(25);
    });

    it("covers all keys in MOSFET_NMOS_DEFAULTS", () => {
      const metaKeys = meta.map((m) => m.key);
      for (const key of Object.keys(MOSFET_NMOS_DEFAULTS)) {
        expect(metaKeys).toContain(key);
      }
    });

    it("VTO entry has unit V", () => {
      const vto = meta.find((m) => m.key === "VTO");
      expect(vto!.unit).toBe("V");
    });

    it("KP entry has unit A/V²", () => {
      const kp = meta.find((m) => m.key === "KP");
      expect(kp!.unit).toBe("A/V²");
    });
  });

  describe("PMOS (MOSFET PMOS)", () => {
    const meta = getParamMeta("PMOS");

    it("returns 25 params", () => {
      expect(meta).toHaveLength(25);
    });

    it("covers all keys in MOSFET_PMOS_DEFAULTS", () => {
      const metaKeys = meta.map((m) => m.key);
      for (const key of Object.keys(MOSFET_PMOS_DEFAULTS)) {
        expect(metaKeys).toContain(key);
      }
    });
  });

  describe("NJFET (N-channel JFET)", () => {
    const meta = getParamMeta("NJFET");

    it("returns 12 params", () => {
      expect(meta).toHaveLength(12);
    });

    it("covers all keys in JFET_N_DEFAULTS", () => {
      const metaKeys = meta.map((m) => m.key);
      for (const key of Object.keys(JFET_N_DEFAULTS)) {
        expect(metaKeys).toContain(key);
      }
    });

    it("VTO entry has unit V", () => {
      const vto = meta.find((m) => m.key === "VTO");
      expect(vto!.unit).toBe("V");
    });
  });

  describe("PJFET (P-channel JFET)", () => {
    const meta = getParamMeta("PJFET");

    it("returns 12 params", () => {
      expect(meta).toHaveLength(12);
    });

    it("covers all keys in JFET_P_DEFAULTS", () => {
      const metaKeys = meta.map((m) => m.key);
      for (const key of Object.keys(JFET_P_DEFAULTS)) {
        expect(metaKeys).toContain(key);
      }
    });
  });

  describe("TUNNEL (tunnel diode)", () => {
    const meta = getParamMeta("TUNNEL");

    it("returns 6 params", () => {
      expect(meta).toHaveLength(6);
    });

    it("covers all keys in TUNNEL_DIODE_DEFAULTS", () => {
      const metaKeys = meta.map((m) => m.key);
      for (const key of Object.keys(TUNNEL_DIODE_DEFAULTS)) {
        expect(metaKeys).toContain(key);
      }
    });

    it("IP entry has unit A", () => {
      const ip = meta.find((m) => m.key === "IP");
      expect(ip!.unit).toBe("A");
    });

    it("VP entry has unit V", () => {
      const vp = meta.find((m) => m.key === "VP");
      expect(vp!.unit).toBe("V");
    });
  });

  it("each call returns a new array (no shared mutable state)", () => {
    const a = getParamMeta("D");
    const b = getParamMeta("D");
    expect(a).not.toBe(b);
  });
});
