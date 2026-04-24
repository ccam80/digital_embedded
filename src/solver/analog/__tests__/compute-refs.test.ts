import { describe, it } from "vitest";
import { cktTerr, cktTerrVoltage } from "../ckt-terr.js";

const defaultParams = { trtol: 7, reltol: 1e-3, abstol: 1e-6, chgtol: 1e-14 };

function r(v: number): string { return v.toPrecision(20); }

describe("compute_refs", () => {
  it("refs", () => {
    const dt = 1e-9;
    const q0 = 1e-12, q1 = 0.9e-12, q2 = 0.8e-12;
    const r01 = cktTerr(dt, [dt, dt], 1, "trapezoidal", q0, q1, q2, 0, q0, q1, defaultParams);
    console.log("T-01:", r(r01));

    const r02 = cktTerr(dt, [dt, dt], 2, "gear", 27e-12, 8e-12, 1e-12, 0, 27e-12, 8e-12, defaultParams);
    console.log("T-02:", r(r02));

    const q = 1e-12;
    const r03 = cktTerr(dt, [dt, dt], 1, "trapezoidal", q, q, q, q, q, q, defaultParams);
    console.log("T-03:", r(r03));

    const rTrap4 = cktTerr(1.0, [1.0, 1.0], 2, "trapezoidal", 27.0, 8.0, 1.0, 0.0, 27.0, 8.0, defaultParams);
    const rBdf24 = cktTerr(1.0, [1.0, 1.0], 2, "gear", 27.0, 8.0, 1.0, 0.0, 27.0, 8.0, defaultParams);
    console.log("T-04 trap:", r(rTrap4));
    console.log("T-04 gear:", r(rBdf24));

    const r05 = cktTerrVoltage(5.0, 5.0, 5.0, 5.0, dt, [dt, dt], 1, "trapezoidal", 1e-3, 1e-6, 7);
    console.log("T-05:", r(r05));

    const r06 = cktTerrVoltage(4.0, 3.0, 2.0, 1.0, dt, [dt, dt], 1, "trapezoidal", 1e-3, 1e-6, 7);
    console.log("T-06:", r(r06));

    const r07 = cktTerrVoltage(27, 8, 1, 0, 1.0, [1.0, 1.0], 2, "gear", 1e-3, 1e-6, 7);
    console.log("T-07:", r(r07));

    const r08 = cktTerrVoltage(4, 3, 2, 1, 1.0, [1.0, 1.0], 2, "gear", 1e-3, 1e-6, 7);
    console.log("T-08:", r(r08));

    const rTrap9 = cktTerrVoltage(27, 8, 1, 0, 1.0, [1.0, 1.0], 2, "trapezoidal", 1e-3, 1e-6, 7);
    const rBdf29 = cktTerrVoltage(27, 8, 1, 0, 1.0, [1.0, 1.0], 2, "gear", 1e-3, 1e-6, 7);
    console.log("T-09 trap:", r(rTrap9));
    console.log("T-09 gear:", r(rBdf29));
  });
});
