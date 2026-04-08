/**
 * Hand-written device mappings from our state-pool slot names to
 * ngspice CKTstate0 offsets.
 *
 * ngspice state offsets are from the device's `here->...` state base.
 * Our offsets are the slot index in the StateSchema (0-based).
 *
 * Sources:
 *   Capacitor: ngspice src/spicelib/devices/cap/capdefs.h
 *   Inductor:  ngspice src/spicelib/devices/ind/inddefs.h
 *   Diode:     ngspice src/spicelib/devices/dio/diodefs.h
 *   BJT:       ngspice src/spicelib/devices/bjt/bjtdefs.h
 *   MOSFET:    ngspice src/spicelib/devices/mos1/mos1defs.h (Level 1)
 */

import type { DeviceMapping } from "./types.js";

// ---------------------------------------------------------------------------
// Capacitor
// ---------------------------------------------------------------------------
// Our slots (CAPACITOR_SCHEMA):
//   0: GEQ, 1: IEQ, 2: V, 3: Q, 4: CCAP
// ngspice cap state offsets (capdefs.h):
//   qcap=0, ccap=1  (charge, companion current)

export const CAPACITOR_MAPPING: DeviceMapping = {
  deviceType: "capacitor",
  slotToNgspice: {
    GEQ: null,    // companion conductance — computed, not stored in ngspice state
    IEQ: null,    // companion current — computed, not stored in ngspice state
    V: null,      // terminal voltage — read from CKTrhs, not state
    Q: 0,         // qcap — charge
    CCAP: 1,      // ccap — companion current
  },
  ngspiceToSlot: {
    0: "Q",
    1: "CCAP",
  },
};

// ---------------------------------------------------------------------------
// Inductor
// ---------------------------------------------------------------------------
// Our slots (INDUCTOR_SCHEMA):
//   0: GEQ, 1: IEQ, 2: I, 3: PHI, 4: CCAP
// ngspice ind state offsets (inddefs.h):
//   flux=0, ccap=1  (flux linkage, companion current)

export const INDUCTOR_MAPPING: DeviceMapping = {
  deviceType: "inductor",
  slotToNgspice: {
    GEQ: null,
    IEQ: null,
    I: null,      // branch current — read from solution vector
    PHI: 0,       // flux
    CCAP: 1,      // ccap
  },
  ngspiceToSlot: {
    0: "PHI",
    1: "CCAP",
  },
};

// ---------------------------------------------------------------------------
// Diode (with capacitance)
// ---------------------------------------------------------------------------
// Our slots (DIODE_CAP_SCHEMA):
//   0: VD, 1: GEQ, 2: IEQ, 3: ID,
//   4: CAP_GEQ, 5: CAP_IEQ, 6: V, 7: Q, 8: CCAP
// ngspice dio state offsets (diodefs.h):
//   DIOvoltage=0, DIOcurrent=1, DIOconduct=2,
//   DIOcapCharge=3, DIOcapCurrent=4,
//   DIOinitCond=5 (not compared)

export const DIODE_MAPPING: DeviceMapping = {
  deviceType: "diode",
  slotToNgspice: {
    VD: 0,        // junction voltage
    GEQ: 2,       // conductance
    IEQ: null,    // Norton current — derived, not directly stored
    ID: 1,        // diode current
    CAP_GEQ: null,
    CAP_IEQ: null,
    V: null,
    Q: 3,         // junction charge
    CCAP: 4,      // junction cap current
  },
  ngspiceToSlot: {
    0: "VD",
    1: "ID",
    2: "GEQ",
    3: "Q",
    4: "CCAP",
  },
};

// ---------------------------------------------------------------------------
// BJT (SPICE L1 — Gummel-Poon)
// ---------------------------------------------------------------------------
// Our slots (BJT_L1_SCHEMA) — first 10 match simple, then extended:
//   0: VBE, 1: VBC, 2: GPI, 3: GMU, 4: GM, 5: GO,
//   6: IC, 7: IB, 8: IC_NORTON, 9: IB_NORTON, 10: RB_EFF,
//   11: IE_NORTON, 12: GEQCB,
//   13-20: CAP_GEQ/IEQ for BE/BC_INT/BC_EXT/CS,
//   21: V_BE, 22: V_BC, 23: V_CS,
//   24: Q_BE, 25: Q_BC, 26: Q_CS,
//   27: CTOT_BE, 28: CTOT_BC, 29: CTOT_CS, ...
// ngspice bjt state offsets (bjtdefs.h):
//   BJTvbe=0, BJTvbc=1, BJTcc=2, BJTcb=3, BJTgpi=4, BJTgmu=5,
//   BJTgm=6, BJTgo=7, BJTqbe=8, BJTcqbe=9, BJTqbc=10, BJTcqbc=11,
//   BJTqcs=12, BJTcqcs=13, BJTqbx=14, BJTcqbx=15, BJTgx=16,
//   BJTcexbc=17, BJTgeqcb=18, BJTgccs=19, BJTgeqbx=20

export const BJT_MAPPING: DeviceMapping = {
  deviceType: "bjt",
  slotToNgspice: {
    VBE: 0,       // BJTvbe
    VBC: 1,       // BJTvbc
    GPI: 4,       // BJTgpi
    GMU: 5,       // BJTgmu
    GM: 6,        // BJTgm
    GO: 7,        // BJTgo
    IC: 2,        // BJTcc (collector current)
    IB: 3,        // BJTcb (base current)
    IC_NORTON: null,
    IB_NORTON: null,
    RB_EFF: null, // computed from gx = 1/RB_EFF → ngspice BJTgx=16
    IE_NORTON: null,
    GEQCB: 18,    // BJTgeqcb
    CAP_GEQ_BE: null,
    CAP_IEQ_BE: null,
    CAP_GEQ_BC_INT: null,
    CAP_IEQ_BC_INT: null,
    CAP_GEQ_BC_EXT: null,
    CAP_IEQ_BC_EXT: null,
    CAP_GEQ_CS: null,
    CAP_IEQ_CS: null,
    V_BE: null,
    V_BC: null,
    V_CS: null,
    Q_BE: 8,      // BJTqbe
    Q_BC: 10,     // BJTqbc
    Q_CS: 12,     // BJTqcs
    CTOT_BE: null,
    CTOT_BC: null,
    CTOT_CS: null,
    CEXBC_NOW: 17,  // BJTcexbc
    CEXBC_PREV: null,
    CEXBC_PREV2: null,
    DT_PREV: null,
  },
  ngspiceToSlot: {
    0: "VBE",
    1: "VBC",
    2: "IC",
    3: "IB",
    4: "GPI",
    5: "GMU",
    6: "GM",
    7: "GO",
    8: "Q_BE",
    10: "Q_BC",
    12: "Q_CS",
    17: "CEXBC_NOW",
    18: "GEQCB",
  },
};

// ---------------------------------------------------------------------------
// MOSFET Level 1 — placeholder
// ---------------------------------------------------------------------------
// Our MOSFET does not yet use the pool-backed state schema (no
// defineStateSchema call found in mosfet.ts). This mapping is a
// placeholder for when pool migration is complete.
// ngspice mos1 state offsets (mos1defs.h):
//   MOS1vbs=0, MOS1vgs=1, MOS1vds=2, MOS1capgs=3, MOS1qgs=4,
//   MOS1cqgs=5, MOS1capgd=6, MOS1qgd=7, MOS1cqgd=8,
//   MOS1capgb=9, MOS1qgb=10, MOS1cqgb=11, MOS1qbd=12,
//   MOS1cqbd=13, MOS1qbs=14, MOS1cqbs=15

export const MOSFET_MAPPING: DeviceMapping = {
  deviceType: "mosfet",
  slotToNgspice: {},   // populated after pool migration
  ngspiceToSlot: {},
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/** All device mappings keyed by device type. */
export const DEVICE_MAPPINGS: Record<string, DeviceMapping> = {
  capacitor: CAPACITOR_MAPPING,
  inductor: INDUCTOR_MAPPING,
  diode: DIODE_MAPPING,
  bjt: BJT_MAPPING,
  mosfet: MOSFET_MAPPING,
};
