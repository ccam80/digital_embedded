/**
 * Tests for the shared voltage-limiting primitives in `newton-raphson.ts`:
 *
 *   - `_computeVtstlo` (Alan Gillespie's `vtstlo` coefficient for `fetlim`)
 *   - `fetlim`         (MOSFET gate-source voltage limiting)
 *   - `limvds`         (MOSFET drain-source voltage limiting)
 *
 * Each test asserts exact numerical equality against ngspice `devsup.c`.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import * as nrModule from "../newton-raphson.js";
import { _computeVtstlo, fetlim, limvds } from "../newton-raphson.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("_computeVtstlo", () => {
  it("matches ngspice Gillespie formula", () => {
    // ngspice devsup.c:102 — vtstlo = fabs(vold - vto) + 1
    expect(_computeVtstlo(1.0, 1.5)).toBe(0.5 + 1);
    expect(_computeVtstlo(5.0, 0.5)).toBe(5.5);
    expect(_computeVtstlo(0.0, 0.0)).toBe(1.0);
    expect(_computeVtstlo(-2.0, 0.5)).toBe(3.5);
  });

  it("rejects spice3f vtsthi/2+2 formula", () => {
    expect(_computeVtstlo(1.0, 1.5)).not.toBe(3.5);
  });
});

describe("fetlim", () => {
  it("preserves vtsthi as abs(2*(vold-vto))+2", () => {
    // vold=5.0, vto=0.5 — ON, vold >= vtox=4.0, delv=5 > 0, delv < vtsthi=11,
    // so vnew is not clamped and returns the input unchanged.
    expect(fetlim(10.0, 5.0, 0.5)).toBe(10.0);
  });

  it("routes through _computeVtstlo", () => {
    // Spy on the module namespace so the spy intercepts the intra-module
    // call in `fetlim`. Inputs: (vnew=0.9, vold=0.0, vto=0.5) — OFF,
    // delv=0.9 > 0, vtemp=1.0, vnew <= vtemp, which is the branch that
    // consumes `vtstlo`. The spy must be called exactly once with
    // (vold, vto) = (0.0, 0.5).
    const spy = vi.spyOn(nrModule, "_computeVtstlo");
    fetlim(0.9, 0.0, 0.5);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(0.0, 0.5);
  });
});

describe("limvds", () => {
  it("clamps high-Vds increasing to 3*vold+2", () => {
    // devsup.c:25-26 — vold >= 3.5, vnew > vold → min(vnew, 3*vold+2)
    expect(limvds(50, 10)).toBe(32);
  });

  it("floors high-Vds decreasing below 3.5 at 2", () => {
    // devsup.c:28-29 — vold >= 3.5, vnew <= vold, vnew < 3.5 → max(vnew, 2)
    expect(limvds(1.0, 5.0)).toBe(2);
  });

  it("does not clamp high-Vds decreasing staying above 3.5", () => {
    // devsup.c:28 — vold >= 3.5, vnew <= vold, vnew >= 3.5 → unchanged
    expect(limvds(4.0, 5.0)).toBe(4.0);
  });

  it("clamps low-Vds increasing to 4", () => {
    // devsup.c:33-34 — vold < 3.5, vnew > vold → min(vnew, 4)
    expect(limvds(10, 2)).toBe(4);
  });

  it("clamps low-Vds decreasing to -0.5", () => {
    // devsup.c:35-36 — vold < 3.5, vnew <= vold → max(vnew, -0.5)
    expect(limvds(-10, 2)).toBe(-0.5);
  });

  it("handles vold=3.5 boundary via >=", () => {
    // devsup.c:24 — the gate is `vold >= 3.5`, not `vold > 3.5`.
    // vnew=4.0, vold=3.5: vold >= 3.5 branch, vnew > vold → min(4.0, 3*3.5+2=12.5)=4.0
    expect(limvds(4.0, 3.5)).toBe(4.0);
  });
});
