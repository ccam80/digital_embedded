/**
 * Tests for Varactor Diode component.
 */

import { describe, it, expect } from "vitest";
import { VARACTOR_PARAM_DEFS } from "../varactor.js";

describe("VARACTOR_PARAM_DEFS partition layout", () => {
  it("AREA OFF IC have partition='instance'", () => {
    const areaDef = VARACTOR_PARAM_DEFS.find((d) => d.key === "AREA");
    const offDef = VARACTOR_PARAM_DEFS.find((d) => d.key === "OFF");
    const icDef = VARACTOR_PARAM_DEFS.find((d) => d.key === "IC");

    expect(areaDef).toBeDefined();
    expect(offDef).toBeDefined();
    expect(icDef).toBeDefined();

    expect(areaDef!.partition).toBe("instance");
    expect(offDef!.partition).toBe("instance");
    expect(icDef!.partition).toBe("instance");
  });

  it("CJO VJ M IS FC TT N RS BV IBV NBV IKF IKR EG XTI KF AF TNOM have partition='model'", () => {
    const modelKeys = ["CJO", "VJ", "M", "IS", "FC", "TT", "N", "RS", "BV", "IBV", "NBV", "IKF", "IKR", "EG", "XTI", "KF", "AF", "TNOM"];
    for (const key of modelKeys) {
      const def = VARACTOR_PARAM_DEFS.find((d) => d.key === key);
      expect(def).toBeDefined();
      expect(def!.partition).toBe("model");
    }
  });
});
