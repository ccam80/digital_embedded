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

// NOTE on non-derivable slots for Cap/Ind/MOS1:
//   Several quantities that LOOK derivable are not reachable from the per-
//   device Float64Array state alone:
//   - Cap GEQ = ag0 * CAPcapac       (needs ckt->CKTag[0] AND model.CAPcapac)
//   - Cap IEQ = NIintegrate result   (needs both above)
//   - Cap V   = rhsOld[pos]-rhsOld[neg] (needs the solution vector)
//   - Ind GEQ = ag0 * INDinduct      (same problem)
//   - Ind IEQ = NIintegrate result
//   - Ind I   = rhsOld[brEq]
//   - MOS1 gm/gds/gmbs/gbd/gbs/cd/cbd/cbs live on here->MOS1gm etc,
//     NOT in CKTstate at all, and are not emitted by the current C
//     instrumentation.
//   The DerivedNgspiceSlot interface only passes a Float64Array + offset.
//   To unblock these, extend the callback signature to also receive
//   (rhsOld, ag0, modelParams) and plumb those through RawNgspiceIterationEx
//   and RawNgspiceTopology (model params are per-device, topology-time data).
//   Tracked as future work — intentionally NOT patched here.

export const CAPACITOR_MAPPING: DeviceMapping = {
  deviceType: "capacitor",
  slotToNgspice: {
    GEQ: null,    // BLOCKED: needs CKTag[0] * CAPcapac (see note above).
    IEQ: null,    // BLOCKED: needs integration result + CKTag[0].
    V: null,      // BLOCKED: needs CKTrhsOld.
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
    CCAP: null,   // our-side slot, no ngspice equivalent
  },
  ngspiceToSlot: {
    0: "PHI",
    1: "NG_VOLT",  // inductor terminal voltage (diagnostic, ngspice-side only)
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
    IEQ: null,    // Norton current — derived via derivedNgspiceSlots below
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
  // Norton companion current — ngspice computes it locally in dioload.c
  // and stamps it without persisting to state. Mirrors dioload.c:429
  // `cdeq = cd - gd*vd`, i.e. `IEQ = ID - GEQ*VD`.
  derivedNgspiceSlots: {
    IEQ: {
      sourceOffsets: [0, 1, 2],
      doc: "Diode Norton current: ID - GEQ*VD (mirrors dioload.c:429)",
      compute: (s, b) => s[b + 1] - s[b + 2] * s[b + 0],
    },
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
    // BJTgx=16 is base-resistance conductance (1/rb_eff). We store rb_eff, not gx.
    // Leave as null — comparison would need a reciprocal transform.
    RB_EFF: null,
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
    CCAP_BE: 9,   // BJTcqbe — companion current for BE junction
    CCAP_BC: 11,  // BJTcqbc — companion current for BC junction
    CCAP_CS: 13,  // BJTcqcs — companion current for CS junction
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
    9: "CCAP_BE",
    10: "Q_BC",
    11: "CCAP_BC",
    12: "Q_CS",
    13: "CCAP_CS",
    // Offsets 14-20 have no direct slot in our schema; expose under
    // ngspice-native names so the raw values are visible in ngspice snapshots
    // and state-history reports (ourEs.slots[...] will be undefined so no
    // spurious comparison is generated).
    14: "NG_QBX",     // BJTqbx — B-X (external base-collector) junction charge
    15: "NG_CQBX",    // BJTcqbx — B-X junction companion current
    16: "NG_GX",      // BJTgx — base resistance conductance (1 / rb_eff)
    17: "CEXBC_NOW",
    18: "GEQCB",
    19: "NG_GCCS",    // BJTgccs — collector-substrate capacitance conductance
    20: "NG_GEQBX",   // BJTgeqbx — B-X junction companion conductance
  },
  // Computed quantities that ngspice does not store directly but which our
  // engine keeps as first-class slots. Formulas mirror ngspice bjtload.c so
  // the comparison is apples-to-apples with ngspice's own companion model.
  derivedNgspiceSlots: {
    // RB_EFF = 1 / BJTgx. When gx==0 (no base resistance) we fall back to
    // Infinity — any non-zero RB_EFF on our side then fails the comparison,
    // which is the right behavior.
    RB_EFF: {
      sourceOffsets: [16],
      doc: "Effective base resistance = 1 / BJTgx",
      compute: (s, b) => {
        const gx = s[b + 16];
        return gx !== 0 ? 1.0 / gx : Number.POSITIVE_INFINITY;
      },
    },
    // Norton companion currents — ngspice re-derives these inside BJTload
    // each iteration and discards them. Formulas match bjt.ts stampLoad
    // (which itself mirrors bjtload.c). State indices:
    //   0 vbe, 1 vbc, 2 cc (BJTcc = ic), 3 cb (BJTcb = ib),
    //   4 gpi, 5 gmu, 6 gm, 7 go, 18 geqcb
    IC_NORTON: {
      sourceOffsets: [0, 1, 2, 5, 6, 7],
      doc: "Collector Norton current: cc - (gm+go)*vbe + (gmu+go)*vbc",
      compute: (s, b) => {
        const vbe = s[b + 0];
        const vbc = s[b + 1];
        const cc  = s[b + 2];
        const gmu = s[b + 5];
        const gm  = s[b + 6];
        const go  = s[b + 7];
        return cc - (gm + go) * vbe + (gmu + go) * vbc;
      },
    },
    IB_NORTON: {
      sourceOffsets: [0, 1, 3, 4, 5, 18],
      doc: "Base Norton current: cb - gpi*vbe - gmu*vbc - geqcb*vbc",
      compute: (s, b) => {
        const vbe   = s[b + 0];
        const vbc   = s[b + 1];
        const cb    = s[b + 3];
        const gpi   = s[b + 4];
        const gmu   = s[b + 5];
        const geqcb = s[b + 18];
        return cb - gpi * vbe - gmu * vbc - geqcb * vbc;
      },
    },
    IE_NORTON: {
      sourceOffsets: [0, 1, 2, 3, 4, 6, 7, 18],
      doc: "Emitter Norton current: -(cc+cb) + (gm+go+gpi)*vbe - (go-geqcb)*vbc",
      compute: (s, b) => {
        const vbe   = s[b + 0];
        const vbc   = s[b + 1];
        const cc    = s[b + 2];
        const cb    = s[b + 3];
        const gpi   = s[b + 4];
        const gm    = s[b + 6];
        const go    = s[b + 7];
        const geqcb = s[b + 18];
        return -(cc + cb) + (gm + go + gpi) * vbe - (go - geqcb) * vbc;
      },
    },
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
// ngspice mos1 state offsets (mos1defs.h:269-292, MOS1numStates=17):
//   MOS1vbd=0,  MOS1vbs=1,  MOS1vgs=2,  MOS1vds=3,
//   MOS1capgs=4,  MOS1qgs=5,  MOS1cqgs=6,
//   MOS1capgd=7,  MOS1qgd=8,  MOS1cqgd=9,
//   MOS1capgb=10, MOS1qgb=11, MOS1cqgb=12,
//   MOS1qbd=13,   MOS1cqbd=14,
//   MOS1qbs=15,   MOS1cqbs=16
//
// FIXED 2026-04-09: previous mapping was off by one (had MOS1vbs at offset 0,
// ngspice actually has MOS1vbd there). Every MOS1 state comparison prior to
// this fix was reading the wrong slot. The shift propagated through the
// entire state vector.
//
// SIGN CONVENTION: our schema uses VSB (source-bulk), VBD (drain-bulk),
// Q_DB (drain-bulk charge), Q_SB (source-bulk charge). ngspice stores vbs,
// vbd, qbd, qbs — each with the opposite sign convention. Where the sign
// convention is inverted we map via derivedNgspiceSlots with a negation; a
// direct offset map would produce spurious mismatches.

export const MOSFET_MAPPING: DeviceMapping = {
  deviceType: "mosfet",
  slotToNgspice: {
    // Gate/drain/source voltages — same sign convention.
    VGS: 2,           // MOS1vgs
    VDS: 3,           // MOS1vds
    // Sign-inverted vs ngspice — mapped via derivedNgspiceSlots.
    VSB: null,        // our VSB = -MOS1vbs (see derivedNgspiceSlots)
    VBD: null,        // our VBD = -MOS1vbd (see derivedNgspiceSlots)
    // Instance-field quantities — not in CKTstate at all, not emitted by the
    // current C instrumentation (live on here->MOS1gm etc.). See the top-of-
    // file blocker note.
    GM: null, GDS: null, IDS: null,
    GMBS: null, GBD: null, GBS: null,
    CBD_I: null, CBS_I: null,
    SWAPPED: null,
    // Companion conductance/current for bulk junctions — derived from
    // NIintegrate in ngspice (needs ag0 + capbd/capbs), not in state.
    CAP_GEQ_GS: null, CAP_IEQ_GS: null,
    CAP_GEQ_GD: null, CAP_IEQ_GD: null,
    CAP_GEQ_DB: null, CAP_IEQ_DB: null,
    CAP_GEQ_SB: null, CAP_IEQ_SB: null,
    CAP_GEQ_GB: null, CAP_IEQ_GB: null,
    // Terminal voltages — from solution vector, not state.
    V_GS: null, V_GD: null, V_DB: null, V_SB: null, V_GB: null,
    // Internal limiting/mode state — no ngspice equivalent.
    VON: null, VBS_OLD: null, VBD_OLD: null, MODE: null,
    // Gate-oxide charges/caps — same sign on both sides (gate is reference).
    MEYER_GS: 4,      // MOS1capgs
    Q_GS: 5,          // MOS1qgs
    CCAP_GS: 6,       // MOS1cqgs
    MEYER_GD: 7,      // MOS1capgd
    Q_GD: 8,          // MOS1qgd
    CCAP_GD: 9,       // MOS1cqgd
    MEYER_GB: 10,     // MOS1capgb
    Q_GB: 11,         // MOS1qgb
    CCAP_GB: 12,      // MOS1cqgb
    // Bulk-junction charges and companion currents — direct-mapped.
    Q_DB: 13,         // MOS1qbd
    CCAP_DB: 14,      // MOS1cqbd
    Q_SB: 15,         // MOS1qbs
    CCAP_SB: 16,      // MOS1cqbs
  },
  ngspiceToSlot: {
    // Expose the two bulk-junction voltages ngspice stores directly under
    // NG_* names for diagnostic visibility — our side holds them via VSB/VBD
    // (sign-flipped) which live in derivedNgspiceSlots below.
    0: "NG_VBD",      // MOS1vbd (bulk-drain)
    1: "NG_VBS",      // MOS1vbs (bulk-source)
    2: "VGS",
    3: "VDS",
    4: "MEYER_GS",
    5: "Q_GS",
    6: "CCAP_GS",
    7: "MEYER_GD",
    8: "Q_GD",
    9: "CCAP_GD",
    10: "MEYER_GB",
    11: "Q_GB",
    12: "CCAP_GB",
    13: "Q_DB",
    14: "CCAP_DB",
    15: "Q_SB",
    16: "CCAP_SB",
  },
  // Sign-inverted voltages. VSB (source-bulk) = -VBS (bulk-source) and
  // VBD (drain-bulk) = -VBD_ng (bulk-drain). Both are exact negations of
  // the raw ngspice state.
  derivedNgspiceSlots: {
    VSB: {
      sourceOffsets: [1],
      doc: "Source-bulk voltage = -MOS1vbs (sign-flipped convention)",
      compute: (s, b) => -s[b + 1],
    },
    VBD: {
      sourceOffsets: [0],
      doc: "Bulk-drain voltage = MOS1vbd (same convention as our VBD slot)",
      compute: (s, b) => s[b + 0],
    },
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
    1: "NG_VGD",        // JFETvgd — no corresponding slot on our side; surface
                        //            as ngspice-native for diagnostics.
    2: "ID_JUNCTION",
    3: "IDS",
    4: "NG_CGD",        // JFETcgd — gate-drain junction current, same reason.
    5: "GM",
    6: "GDS",
    7: "GD_JUNCTION",
    8: "NG_GGD",        // JFETggd — gate-drain junction conductance.
    9: "Q_GS",
    10: "CCAP_GS",
    11: "Q_GD",
    12: "CCAP_GD",
  },
  // VDS is not stored directly in JFET state but trivially derivable from
  // JFETvgs - JFETvgd (the two state slots at offsets 0 and 1). This mirrors
  // the engine's own vds computation.
  derivedNgspiceSlots: {
    VDS: {
      sourceOffsets: [0, 1],
      doc: "Drain-source voltage: JFETvgs - JFETvgd",
      compute: (s, b) => s[b + 0] - s[b + 1],
    },
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
    IEQ: null,     // Norton current — derived via derivedNgspiceSlots below
    ID: 1,         // DIOcurrent
    CAP_GEQ: null, // companion conductance — needs integration coeffs
    CAP_IEQ: null, // companion current — needs integration coeffs
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
  // Same Norton formula as a regular diode. Tunnel diode adds extra current
  // components on top but its companion is still cd-gd*vd at the ngspice
  // level because it reuses the diode model.
  derivedNgspiceSlots: {
    IEQ: {
      sourceOffsets: [0, 1, 2],
      doc: "Diode Norton current: ID - GEQ*VD (mirrors dioload.c:429)",
      compute: (s, b) => s[b + 1] - s[b + 2] * s[b + 0],
    },
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
    IEQ: null,     // Norton current — derived via derivedNgspiceSlots below
    ID: 1,         // DIOcurrent
    CAP_GEQ: null, // companion conductance — needs integration coeffs
    CAP_IEQ: null, // companion current — needs integration coeffs
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
  // Varactor uses the plain diode model in ngspice, so Norton formula is
  // identical.
  derivedNgspiceSlots: {
    IEQ: {
      sourceOffsets: [0, 1, 2],
      doc: "Diode Norton current: ID - GEQ*VD (mirrors dioload.c:429)",
      compute: (s, b) => s[b + 1] - s[b + 2] * s[b + 0],
    },
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

// ---------------------------------------------------------------------------
// Type normalization
// ---------------------------------------------------------------------------

const TYPE_ID_TO_CANONICAL: Record<string, string> = {
  NpnBJT: "bjt",
  PnpBJT: "bjt",
  NMOS: "mosfet",
  PMOS: "mosfet",
  NJFET: "jfet",
  PJFET: "jfet",
  Diode: "diode",
  Zener: "diode",
  Varactor: "varactor",
  TunnelDiode: "tunnel-diode",
  Capacitor: "capacitor",
  Inductor: "inductor",
  Resistor: "resistor",
  DcVoltageSource: "vsource",
  AcVoltageSource: "vsource",
  DcCurrentSource: "isource",
  AcCurrentSource: "isource",
  SCR: "scr",
  Triac: "triac",
};

/**
 * Normalize a circuit element typeId to a canonical device type string
 * matching the keys in DEVICE_MAPPINGS.
 *
 * @param typeId - The typeId from CircuitElement (e.g. "NpnBJT", "NMOS")
 * @returns Canonical lowercase device type ("bjt", "mosfet", "diode", etc.)
 *          or "unknown" if unrecognized.
 */
export function normalizeDeviceType(typeId: string): string {
  return TYPE_ID_TO_CANONICAL[typeId] ?? "unknown";
}
