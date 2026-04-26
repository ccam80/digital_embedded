/**
 * PMOS tVbi sign audit — Task 6.3.1
 *
 * Verifies that digiTS computeTempParams produces a tVbi value that is
 * bit-exact with the ngspice mos1temp.c:170-174 formula for a PMOS device
 * with GAMMA != 0.
 *
 * The historical suspicion (fix #25) was that digiTS used |VTO| instead of
 * signed VTO, causing a tVbi divergence for PMOS. This test guards against
 * that regression.
 *
 * ngspice reference: ref/ngspice/src/spicelib/devices/mos1/mos1temp.c:170-174
 *   here->MOS1tVbi =
 *       model->MOS1vt0 - model->MOS1type * (model->MOS1gamma * sqrt(model->MOS1phi))
 *       + .5*(egfet1-egfet)
 *       + model->MOS1type * .5 * (here->MOS1tPhi - model->MOS1phi);
 *
 * Where MOS1type = -1 for PMOS, MOS1vt0 is the signed threshold voltage.
 */

import { describe, it, expect } from 'vitest';
import {
  computeTempParams,
  type ResolvedMosfetParams,
} from '../../../../components/semiconductors/mosfet.js';

// ---------------------------------------------------------------------------
// Physical constants (matching mosfet.ts / ngspice const.h)
// ---------------------------------------------------------------------------
const CONSTboltz = 1.3806226e-23;
const Q = 1.6021918e-19;
const KoverQ = CONSTboltz / Q;
const REFTEMP = 300.15;

/**
 * Implements the ngspice mos1temp.c tVbi formula directly.
 * This is the reference implementation the production code must match.
 *
 * mos1temp.c:170-174:
 *   phio = (phi - pbfact1) / fact1
 *   tPhi = fact2 * phio + pbfact
 *   tVbi = vt0 - type*(gamma*sqrt(phi)) + 0.5*(egfet1-egfet) + type*0.5*(tPhi-phi)
 */
function ngspiceTVbi(
  vt0: number,
  type: 1 | -1,
  gamma: number,
  phi: number,
  tnom: number,
  temp: number,
): number {
  // Model level (mos1temp.c:45-51)
  const fact1 = tnom / REFTEMP;
  const vtnom = tnom * KoverQ;
  const kt1 = CONSTboltz * tnom;
  const egfet1 = 1.16 - (7.02e-4 * tnom * tnom) / (tnom + 1108);
  const arg1 = -egfet1 / (kt1 + kt1) + 1.1150877 / (CONSTboltz * (REFTEMP + REFTEMP));
  const pbfact1 = -2 * vtnom * (1.5 * Math.log(fact1) + Q * arg1);

  // Instance level (mos1temp.c:135-142)
  const vt = temp * KoverQ;
  const fact2 = temp / REFTEMP;
  const kt = CONSTboltz * temp;
  const egfet = 1.16 - (7.02e-4 * temp * temp) / (temp + 1108);
  const arg = -egfet / (kt + kt) + 1.1150877 / (CONSTboltz * (REFTEMP + REFTEMP));
  const pbfact = -2 * vt * (1.5 * Math.log(fact2) + Q * arg);

  // mos1temp.c:168-174
  const phio = (phi - pbfact1) / fact1;
  const tPhi = fact2 * phio + pbfact;
  return vt0 - type * (gamma * Math.sqrt(phi))
    + 0.5 * (egfet1 - egfet)
    + type * 0.5 * (tPhi - phi);
}

/** Builds a minimal ResolvedMosfetParams for computeTempParams. */
function makePmosParams(overrides: Partial<ResolvedMosfetParams> = {}): ResolvedMosfetParams {
  return {
    VTO: -1.0,
    KP: 2e-5,
    LAMBDA: 0,
    PHI: 0.6,
    GAMMA: 0.5,
    W: 1e-6,
    L: 1e-6,
    CBD: 0, CBS: 0,
    CGDO: 0, CGSO: 0, CGBO: 0,
    RD: 0, RS: 0,
    IS: 1e-14, PB: 0.8,
    CJ: 0, MJ: 0.5, CJSW: 0, MJSW: 0.5,
    JS: 0, RSH: 0, FC: 0.5,
    AD: 0, AS: 0, PD: 0, PS: 0,
    TNOM: REFTEMP, TOX: 1e-7,
    TPG: 1, LD: 0, UO: 600,
    KF: 0, AF: 1,
    M: 1, OFF: 0,
    ICVDS: 0, ICVGS: 0, ICVBS: 0,
    TEMP: REFTEMP,
    ...overrides,
  };
}

describe('PMOS tVbi sign audit', () => {
  it('tVbi is bit-exact with ngspice mos1temp.c:170-174 for PMOS with GAMMA=0.5', () => {
    const params = makePmosParams({
      VTO: -1.0,
      GAMMA: 0.5,
      PHI: 0.6,
      TEMP: REFTEMP,
      TNOM: REFTEMP,
    });

    const tp = computeTempParams(params, -1);
    const expected = ngspiceTVbi(-1.0, -1, 0.5, 0.6, REFTEMP, REFTEMP);

    expect(tp.tVbi).toBe(expected);
  });

  it('tVbi is bit-exact with ngspice when TEMP != TNOM (thermal correction terms active)', () => {
    const TEMP = 400;
    const TNOM = REFTEMP;
    const params = makePmosParams({
      VTO: -1.0,
      GAMMA: 0.5,
      PHI: 0.6,
      TEMP,
      TNOM,
    });

    const tp = computeTempParams(params, -1);
    const expected = ngspiceTVbi(-1.0, -1, 0.5, 0.6, TNOM, TEMP);

    expect(tp.tVbi).toBe(expected);
  });

  it('PMOS tVbi has correct sign: tVbi < 0 for VTO=-1.0, GAMMA=0', () => {
    const params = makePmosParams({
      VTO: -1.0,
      GAMMA: 0,
      PHI: 0.6,
      TEMP: REFTEMP,
      TNOM: REFTEMP,
    });

    const tp = computeTempParams(params, -1);

    // With GAMMA=0 and TEMP=TNOM, corrections vanish: tVbi ≈ VTO = -1.0
    expect(tp.tVbi).toBeLessThan(0);
    const expected = ngspiceTVbi(-1.0, -1, 0, 0.6, REFTEMP, REFTEMP);
    expect(tp.tVbi).toBe(expected);
  });

  it('NMOS tVbi is unchanged: bit-exact with ngspice for polarity=+1', () => {
    const params = makePmosParams({
      VTO: 1.0,
      GAMMA: 0.5,
      PHI: 0.6,
      TEMP: REFTEMP,
      TNOM: REFTEMP,
    });

    const tp = computeTempParams(params, 1);
    const expected = ngspiceTVbi(1.0, 1, 0.5, 0.6, REFTEMP, REFTEMP);

    expect(tp.tVbi).toBe(expected);
  });
});
