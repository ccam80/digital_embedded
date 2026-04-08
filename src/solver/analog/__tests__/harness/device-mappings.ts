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
// MOSFET Level 1
// ---------------------------------------------------------------------------
// Our slots (FET_BASE_SCHEMA in fet-base.ts, 45 slots):
//   0: VGS, 1: VDS, 2: GM, 3: GDS, 4: IDS, 5: SWAPPED,
//   6: CAP_GEQ_GS, 7: CAP_IEQ_GS, 8: CAP_GEQ_GD, 9: CAP_IEQ_GD,
//   10: V_GS, 11: V_GD, 12: CAP_GEQ_DB, 13: CAP_IEQ_DB,
//   14: CAP_GEQ_SB, 15: CAP_IEQ_SB, 16: V_DB, 17: V_SB,
//   18: CAP_GEQ_GB, 19: CAP_IEQ_GB, 20: V_GB,
//   21: VSB, 22: GMBS, 23: GBD, 24: GBS, 25: CBD_I, 26: CBS_I, 27: VBD,
//   28: VON, 29: VBS_OLD, 30: VBD_OLD, 31: MODE,
//   32: Q_GS, 33: Q_GD, 34: Q_GB,
//   35: MEYER_GS, 36: MEYER_GD, 37: MEYER_GB,
//   38: CCAP_GS, 39: CCAP_GD, 40: CCAP_GB,
//   41: Q_DB, 42: Q_SB, 43: CCAP_DB, 44: CCAP_SB
// ngspice mos1 state offsets (mos1defs.h):
//   MOS1vbs=0, MOS1vgs=1, MOS1vds=2, MOS1capgs=3, MOS1qgs=4,
//   MOS1cqgs=5, MOS1capgd=6, MOS1qgd=7, MOS1cqgd=8,
//   MOS1capgb=9, MOS1qgb=10, MOS1cqgb=11, MOS1qbd=12,
//   MOS1cqbd=13, MOS1qbs=14, MOS1cqbs=15

export const MOSFET_MAPPING: DeviceMapping = {
  deviceType: "mosfet",
  slotToNgspice: {
    VGS: 1,           // MOS1vgs
    VDS: 2,           // MOS1vds
    GM: null,         // computed, not in ngspice state vector
    GDS: null,        // computed, not in ngspice state vector
    IDS: null,        // computed, not in ngspice state vector
    SWAPPED: null,    // internal flag, no ngspice equivalent
    CAP_GEQ_GS: null, // companion conductance — derived
    CAP_IEQ_GS: null, // companion current — derived
    CAP_GEQ_GD: null,
    CAP_IEQ_GD: null,
    V_GS: null,       // terminal voltage — read from solution vector
    V_GD: null,
    CAP_GEQ_DB: null,
    CAP_IEQ_DB: null,
    CAP_GEQ_SB: null,
    CAP_IEQ_SB: null,
    V_DB: null,
    V_SB: null,
    CAP_GEQ_GB: null,
    CAP_IEQ_GB: null,
    V_GB: null,
    VSB: 0,           // MOS1vbs
    GMBS: null,       // computed, not in ngspice state vector
    GBD: null,        // computed
    GBS: null,        // computed
    CBD_I: null,      // computed
    CBS_I: null,      // computed
    VBD: null,        // derived from vbs - vds
    VON: null,        // internal limiting state
    VBS_OLD: null,    // internal limiting state
    VBD_OLD: null,    // internal limiting state
    MODE: null,       // internal flag
    Q_GS: 4,          // MOS1qgs
    Q_GD: 7,          // MOS1qgd
    Q_GB: 10,         // MOS1qgb
    MEYER_GS: 3,      // MOS1capgs (Meyer half-cap)
    MEYER_GD: 6,      // MOS1capgd (Meyer half-cap)
    MEYER_GB: 9,      // MOS1capgb (Meyer half-cap)
    CCAP_GS: 5,       // MOS1cqgs
    CCAP_GD: 8,       // MOS1cqgd
    CCAP_GB: 11,      // MOS1cqgb
    Q_DB: 12,         // MOS1qbd
    Q_SB: 14,         // MOS1qbs
    CCAP_DB: 13,      // MOS1cqbd
    CCAP_SB: 15,      // MOS1cqbs
  },
  ngspiceToSlot: {
    0: "VSB",
    1: "VGS",
    2: "VDS",
    3: "MEYER_GS",
    4: "Q_GS",
    5: "CCAP_GS",
    6: "MEYER_GD",
    7: "Q_GD",
    8: "CCAP_GD",
    9: "MEYER_GB",
    10: "Q_GB",
    11: "CCAP_GB",
    12: "Q_DB",
    13: "CCAP_DB",
    14: "Q_SB",
    15: "CCAP_SB",
  },
};

// ---------------------------------------------------------------------------
// JFET (N-channel / P-channel)
// ---------------------------------------------------------------------------
// Our slots: FET_BASE_SCHEMA (45 slots) + 3 junction slots:
//   0: VGS, 1: VDS, 2: GM, 3: GDS, 4: IDS, 5: SWAPPED,
//   6-20: CAP_GEQ/IEQ, V for GS/GD/DB/SB/GB pairs,
//   21: VSB, 22: GMBS, 23: GBD, 24: GBS, 25: CBD_I, 26: CBS_I, 27: VBD,
//   28: VON, 29: VBS_OLD, 30: VBD_OLD, 31: MODE,
//   32-34: Q_GS, Q_GD, Q_GB, 35-37: MEYER_GS/GD/GB,
//   38-40: CCAP_GS/GD/GB, 41-42: Q_DB, Q_SB, 43-44: CCAP_DB, CCAP_SB,
//   45: VGS_JUNCTION, 46: GD_JUNCTION, 47: ID_JUNCTION
// ngspice jfet state offsets (jfetdefs.h):
//   JFETvgs=0, JFETvgd=1, JFETcg=2, JFETcd=3, JFETcgd=4,
//   JFETgm=5, JFETgds=6, JFETggs=7, JFETggd=8,
//   JFETqgs=9, JFETcqgs=10, JFETqgd=11, JFETcqgd=12
//
// NOTE: JFET is 3-terminal (no bulk), so MOSFET-specific slots
// (DB, SB, GB, MEYER, GMBS, etc.) have no ngspice equivalent.

export const JFET_MAPPING: DeviceMapping = {
  deviceType: "jfet",
  slotToNgspice: {
    VGS: 0,           // JFETvgs
    VDS: null,        // no direct ngspice state (vds = vgs - vgd)
    GM: 5,            // JFETgm
    GDS: 6,           // JFETgds
    IDS: 3,           // JFETcd (drain current)
    SWAPPED: null,
    CAP_GEQ_GS: null,
    CAP_IEQ_GS: null,
    CAP_GEQ_GD: null,
    CAP_IEQ_GD: null,
    V_GS: null,
    V_GD: null,
    CAP_GEQ_DB: null,
    CAP_IEQ_DB: null,
    CAP_GEQ_SB: null,
    CAP_IEQ_SB: null,
    V_DB: null,
    V_SB: null,
    CAP_GEQ_GB: null,
    CAP_IEQ_GB: null,
    V_GB: null,
    VSB: null,        // no bulk in JFET
    GMBS: null,
    GBD: null,
    GBS: null,
    CBD_I: null,
    CBS_I: null,
    VBD: null,
    VON: null,
    VBS_OLD: null,
    VBD_OLD: null,
    MODE: null,
    Q_GS: 9,          // JFETqgs
    Q_GD: 11,         // JFETqgd
    Q_GB: null,        // no bulk
    MEYER_GS: null,    // JFET doesn't use Meyer model
    MEYER_GD: null,
    MEYER_GB: null,
    CCAP_GS: 10,       // JFETcqgs
    CCAP_GD: 12,       // JFETcqgd
    CCAP_GB: null,
    Q_DB: null,
    Q_SB: null,
    CCAP_DB: null,
    CCAP_SB: null,
    // JFET-specific junction slots
    VGS_JUNCTION: null,  // our internal limiting state, not in ngspice state
    GD_JUNCTION: 7,      // JFETggs (gate-source junction conductance)
    ID_JUNCTION: 2,      // JFETcg (gate current)
  },
  ngspiceToSlot: {
    0: "VGS",
    2: "ID_JUNCTION",
    3: "IDS",
    5: "GM",
    6: "GDS",
    7: "GD_JUNCTION",
    9: "Q_GS",
    10: "CCAP_GS",
    11: "Q_GD",
    12: "CCAP_GD",
  },
};

// ---------------------------------------------------------------------------
// Tunnel Diode
// ---------------------------------------------------------------------------
// Our slots (TUNNEL_DIODE_STATE_SCHEMA, resistive, 4 slots):
//   0: VD, 1: GEQ, 2: IEQ, 3: ID
// Our slots (TUNNEL_DIODE_CAP_STATE_SCHEMA, with capacitance, 9 slots):
//   0: VD, 1: GEQ, 2: IEQ, 3: ID,
//   4: CAP_GEQ, 5: CAP_IEQ, 6: V, 7: Q, 8: CCAP
// ngspice does not have a dedicated tunnel diode model.
// It's modelled as a standard diode with extra current components.
// Map to the diode state offsets (diodefs.h) where applicable:
//   DIOvoltage=0, DIOcurrent=1, DIOconduct=2,
//   DIOcapCharge=3, DIOcapCurrent=4

export const TUNNEL_DIODE_MAPPING: DeviceMapping = {
  deviceType: "tunnel-diode",
  slotToNgspice: {
    VD: 0,         // DIOvoltage
    GEQ: 2,        // DIOconduct
    IEQ: null,     // Norton current — derived
    ID: 1,         // DIOcurrent
    CAP_GEQ: null, // companion conductance — derived
    CAP_IEQ: null, // companion current — derived
    V: null,       // terminal voltage — from solution vector
    Q: 3,          // DIOcapCharge
    CCAP: 4,       // DIOcapCurrent
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
// Varactor
// ---------------------------------------------------------------------------
// Our slots (VARACTOR_STATE_SCHEMA, 9 slots):
//   0: VD, 1: GEQ, 2: IEQ, 3: ID,
//   4: CAP_GEQ, 5: CAP_IEQ, 6: V, 7: Q, 8: CCAP
// ngspice: varactor is modelled as a diode — same state offsets as diode.

export const VARACTOR_MAPPING: DeviceMapping = {
  deviceType: "varactor",
  slotToNgspice: {
    VD: 0,         // DIOvoltage
    GEQ: 2,        // DIOconduct
    IEQ: null,     // Norton current — derived
    ID: 1,         // DIOcurrent
    CAP_GEQ: null, // companion conductance — derived
    CAP_IEQ: null, // companion current — derived
    V: null,       // terminal voltage — from solution vector
    Q: 3,          // DIOcapCharge
    CCAP: 4,       // DIOcapCurrent
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
// Registry
// ---------------------------------------------------------------------------

/** All device mappings keyed by device type. */
export const DEVICE_MAPPINGS: Record<string, DeviceMapping> = {
  capacitor: CAPACITOR_MAPPING,
  inductor: INDUCTOR_MAPPING,
  diode: DIODE_MAPPING,
  bjt: BJT_MAPPING,
  mosfet: MOSFET_MAPPING,
  jfet: JFET_MAPPING,
  "tunnel-diode": TUNNEL_DIODE_MAPPING,
  varactor: VARACTOR_MAPPING,
};
