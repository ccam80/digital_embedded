/**
 * setup-stamp-order.test.ts
 *
 * Invariant: each ngspice-anchored component's setup() must call
 * solver.allocElement() in exactly the order the corresponding ngspice
 * *setup.c file calls TSTALLOC — position-for-position.
 *
 * W3 implementation pattern (for reference when implementing each row):
 *   const engine = new MNAEngine(/* ... *\/);
 *   engine.init(compiled);
 *   (engine as any)._setup();   // private-method bypass, test-only
 *   const order = (engine as any)._solver._getInsertionOrder();
 *   expect(order).toEqual(EXPECTED_TSTALLOC_SEQUENCE);
 *
 * Gate: every row exists with it.todo before any W3 component lands.
 * Initially all rows are red (todo). Turns green as W3 components land.
 *
 * Behavioral elements are excluded per spec/setup-load-split/02-behavioral.md
 * ("There is no setup-stamp-order.test.ts row for behavioral elements").
 */

import { describe } from "vitest";

describe("setup-stamp-order", () => {
  it.todo("PB-ADC TSTALLOC sequence");
  it.todo("PB-AFUSE TSTALLOC sequence");
  it.todo("PB-ANALOG_SWITCH TSTALLOC sequence");
  it.todo("PB-BJT TSTALLOC sequence");
  it.todo("PB-CAP TSTALLOC sequence");
  it.todo("PB-CCCS TSTALLOC sequence");
  it.todo("PB-CCVS TSTALLOC sequence");
  it.todo("PB-COMPARATOR TSTALLOC sequence");
  it.todo("PB-CRYSTAL TSTALLOC sequence");
  it.todo("PB-DAC TSTALLOC sequence");
  it.todo("PB-DIAC TSTALLOC sequence");
  it.todo("PB-DIO TSTALLOC sequence");
  it.todo("PB-FGNFET TSTALLOC sequence");
  it.todo("PB-FGPFET TSTALLOC sequence");
  it.todo("PB-FUSE TSTALLOC sequence");
  it.todo("PB-IND TSTALLOC sequence");
  it.todo("PB-ISRC TSTALLOC sequence");
  it.todo("PB-LDR TSTALLOC sequence");
  it.todo("PB-MEMR TSTALLOC sequence");
  it.todo("PB-NFET TSTALLOC sequence");
  it.todo("PB-NJFET TSTALLOC sequence");
  it.todo("PB-NMOS TSTALLOC sequence");
  it.todo("PB-NTC TSTALLOC sequence");
  it.todo("PB-OPAMP TSTALLOC sequence");
  it.todo("PB-OPTO TSTALLOC sequence");
  it.todo("PB-OTA TSTALLOC sequence");
  it.todo("PB-PFET TSTALLOC sequence");
  it.todo("PB-PJFET TSTALLOC sequence");
  it.todo("PB-PMOS TSTALLOC sequence");
  it.todo("PB-POLCAP TSTALLOC sequence");
  it.todo("PB-POT TSTALLOC sequence");
  it.todo("PB-REAL_OPAMP TSTALLOC sequence");
  it.todo("PB-RELAY TSTALLOC sequence");
  it.todo("PB-RELAY-DT TSTALLOC sequence");
  it.todo("PB-RES TSTALLOC sequence");
  it.todo("PB-SCR TSTALLOC sequence");
  it.todo("PB-SCHMITT TSTALLOC sequence");
  it.todo("PB-SCHOTTKY TSTALLOC sequence");
  it.todo("PB-SPARK TSTALLOC sequence");
  it.todo("PB-SUBCKT TSTALLOC sequence");
  it.todo("PB-SW TSTALLOC sequence");
  it.todo("PB-SW-DT TSTALLOC sequence");
  it.todo("PB-TAPXFMR TSTALLOC sequence");
  it.todo("PB-TIMER555 TSTALLOC sequence");
  it.todo("PB-TLINE TSTALLOC sequence");
  it.todo("PB-TRANSGATE TSTALLOC sequence");
  it.todo("PB-TRIAC TSTALLOC sequence");
  it.todo("PB-TRIODE TSTALLOC sequence");
  it.todo("PB-TUNNEL TSTALLOC sequence");
  it.todo("PB-VARACTOR TSTALLOC sequence");
  it.todo("PB-VCCS TSTALLOC sequence");
  it.todo("PB-VCVS TSTALLOC sequence");
  it.todo("PB-VSRC-AC TSTALLOC sequence");
  it.todo("PB-VSRC-DC TSTALLOC sequence");
  it.todo("PB-VSRC-VAR TSTALLOC sequence");
  it.todo("PB-XFMR TSTALLOC sequence");
  it.todo("PB-ZENER TSTALLOC sequence");
});
