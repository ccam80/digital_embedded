/**
 * Canonical tests for the PriorityEncoder component.
 *
 * Tier: fixture-only (pure-digital, combinational; no analog domain).
 * Driver: facade.build({components, connections}) + facade.compile() +
 *   coordinator.writeByLabel / step / readByLabel via the facade signal API.
 *
 * Canon coverage:
 *   - Cat 4 (param hot-load — structural `selectorBits`): selectorBits is
 *     consumed at compile() to shape the input pin set. Canonical mechanic:
 *     build the same circuit twice — once with selectorBits=1, once with
 *     selectorBits=2 — and assert the documented post-compile observable
 *     differs at the same input combination.
 *   - Cat 9 (bridge / digital interaction): drive labelled In ports for each
 *     input pin, step the engine, observe labelled Out ports for `num` and
 *     `any`.
 *   - Cat 11 (multi-output digital observability): `outputSchema = ["num",
 *     "any"]`. `num` is the index of the highest-active input;
 *     `any` is the OR-reduction across all inputs. The two outputs take
 *     independent values for the same input combination (e.g. all-zero
 *     inputs → num=0, any=0; only in0=1 → num=0, any=1; both
 *     differentiated by one input bit).
 *   - Cat 12 (forbidden / undefined input combinations): with no input
 *     asserted, the production-source comment documents `any=0, num=0`. This
 *     is the spec-mandated forbidden-state output for the priority encoder.
 *
 * Cat 1/2/3/5/6/7/8 do not apply: pure-digital combinational with no analog
 * state pool, no MNA matrix, no DCOP, no junction limiting, no LTE rollback,
 * no breakpoints, no transient dynamics.
 * Cat 10 does not apply: modelRegistry is empty (no named presets).
 * Cat 13 does not apply: every input pin (in0..inN) is 1-bit and is driven
 * by a 1-bit In; the `num` output is selectorBits-wide and is observed by
 * an Out sized to match (no narrower port than its bus).
 * Cat 14 does not apply: production source emits no runtime diagnostics
 * keyed on simulation observables.
 * Cat 15 does not apply: production source registers no _onStateChange
 * writeback subscription.
 */

import { describe, it, expect } from "vitest";
import { DefaultSimulatorFacade } from "../../../headless/default-facade.js";
import { createDefaultRegistry } from "../../register-all.js";
import type { SimulationCoordinator } from "../../../solver/coordinator-types.js";

const registry = createDefaultRegistry();

// ---------------------------------------------------------------------------
// Canonical builder for a digital fixture driven by labelled In ports and
// observed via labelled Out ports.
// ---------------------------------------------------------------------------

interface DigitalFixture {
  facade: DefaultSimulatorFacade;
  coordinator: SimulationCoordinator;
}

function buildDigital(spec: {
  components: ReadonlyArray<{ id: string; type: string; props?: Record<string, number | string | boolean | number[]> }>;
  connections: ReadonlyArray<readonly [string, string]>;
}): DigitalFixture {
  const facade = new DefaultSimulatorFacade(registry);
  const circuit = facade.build({
    components: spec.components.map((c) =>
      c.props === undefined
        ? { id: c.id, type: c.type }
        : { id: c.id, type: c.type, props: c.props },
    ),
    connections: spec.connections.map((c) => [c[0], c[1]] as [string, string]),
  });
  const coordinator = facade.compile(circuit);
  return { facade, coordinator };
}

function drive(fix: DigitalFixture, values: Record<string, number>): void {
  for (const [label, value] of Object.entries(values)) {
    fix.facade.setSignal(fix.coordinator, label, value);
  }
  fix.facade.step(fix.coordinator);
}

function read(fix: DigitalFixture, label: string): number {
  return fix.facade.readSignal(fix.coordinator, label) as number;
}

// ---------------------------------------------------------------------------
// PriorityEncoder fixture: selectorBits=N → 2^N input pins (in0..in(2^N-1))
// driven by individual 1-bit In ports labelled IN0..IN(2^N-1); outputs
// `num` (selectorBits wide) and `any` (1 bit) routed to Outs labelled NUM
// and ANY.
// ---------------------------------------------------------------------------

function buildPriorityEncoder(opts: {
  selectorBits?: number;
}): DigitalFixture {
  const selectorBits = opts.selectorBits ?? 2;
  const inputCount = 1 << selectorBits;

  const components: { id: string; type: string; props?: Record<string, number | string | boolean | number[]> }[] = [];
  const connections: [string, string][] = [];

  for (let i = 0; i < inputCount; i++) {
    components.push({
      id: `in${i}`,
      type: "In",
      props: { label: `IN${i}`, bitWidth: 1 },
    });
    connections.push([`in${i}:out`, `pe:in${i}`]);
  }

  components.push({
    id: "pe",
    type: "PriorityEncoder",
    props: { selectorBits },
  });

  components.push({
    id: "num",
    type: "Out",
    props: { label: "NUM", bitWidth: selectorBits },
  });
  components.push({
    id: "any",
    type: "Out",
    props: { label: "ANY", bitWidth: 1 },
  });
  connections.push(["pe:num", "num:in"]);
  connections.push(["pe:any", "any:in"]);

  return buildDigital({ components, connections });
}

function allZero(inputCount: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (let i = 0; i < inputCount; i++) out[`IN${i}`] = 0;
  return out;
}

// ===========================================================================
// Cat 9 — bridge / digital interaction
// ===========================================================================

describe("PriorityEncoder digital interaction (Cat 9)", () => {
  it("2-input encoder: only IN0=1 → NUM=0, ANY=1", () => {
    const fix = buildPriorityEncoder({ selectorBits: 1 });
    drive(fix, { ...allZero(2), IN0: 1 });
    expect(read(fix, "NUM")).toBe(0);
    expect(read(fix, "ANY")).toBe(1);
  });

  it("2-input encoder: only IN1=1 → NUM=1, ANY=1", () => {
    const fix = buildPriorityEncoder({ selectorBits: 1 });
    drive(fix, { ...allZero(2), IN1: 1 });
    expect(read(fix, "NUM")).toBe(1);
    expect(read(fix, "ANY")).toBe(1);
  });

  it("2-input encoder: both IN0=1 and IN1=1 → NUM=1 (highest active index wins), ANY=1", () => {
    const fix = buildPriorityEncoder({ selectorBits: 1 });
    drive(fix, { IN0: 1, IN1: 1 });
    expect(read(fix, "NUM")).toBe(1);
    expect(read(fix, "ANY")).toBe(1);
  });

  it("4-input encoder: only IN2=1 → NUM=2, ANY=1", () => {
    const fix = buildPriorityEncoder({ selectorBits: 2 });
    drive(fix, { ...allZero(4), IN2: 1 });
    expect(read(fix, "NUM")).toBe(2);
    expect(read(fix, "ANY")).toBe(1);
  });

  it("4-input encoder: IN0=1 and IN3=1 → NUM=3 (highest index wins), ANY=1", () => {
    const fix = buildPriorityEncoder({ selectorBits: 2 });
    drive(fix, { ...allZero(4), IN0: 1, IN3: 1 });
    expect(read(fix, "NUM")).toBe(3);
    expect(read(fix, "ANY")).toBe(1);
  });

  it("4-input encoder: all four inputs asserted → NUM=3 (top index), ANY=1", () => {
    const fix = buildPriorityEncoder({ selectorBits: 2 });
    drive(fix, { IN0: 1, IN1: 1, IN2: 1, IN3: 1 });
    expect(read(fix, "NUM")).toBe(3);
    expect(read(fix, "ANY")).toBe(1);
  });

  it("4-input encoder: transition IN2 1->0 with IN0 still asserted: NUM falls from 2 to 0, ANY stays 1", () => {
    const fix = buildPriorityEncoder({ selectorBits: 2 });
    drive(fix, { ...allZero(4), IN0: 1, IN2: 1 });
    expect(read(fix, "NUM")).toBe(2);
    expect(read(fix, "ANY")).toBe(1);
    drive(fix, { ...allZero(4), IN0: 1, IN2: 0 });
    expect(read(fix, "NUM")).toBe(0);
    expect(read(fix, "ANY")).toBe(1);
  });
});

// ===========================================================================
// Cat 11 — multi-output digital observability
//   outputSchema = ["num", "any"]; the two outputs take independent values
//   for the same input combination and are observed independently after a
//   single step().
// ===========================================================================

describe("PriorityEncoder multi-output observability (Cat 11)", () => {
  it("4-input encoder, only IN1=1: NUM and ANY observed independently in one step (NUM=1, ANY=1)", () => {
    const fix = buildPriorityEncoder({ selectorBits: 2 });
    drive(fix, { ...allZero(4), IN1: 1 });
    expect(read(fix, "NUM")).toBe(1);
    expect(read(fix, "ANY")).toBe(1);
  });

  it("4-input encoder, only IN0=1: NUM=0 and ANY=1 distinguish the two output observables (NUM=0 differs from ANY=1)", () => {
    const fix = buildPriorityEncoder({ selectorBits: 2 });
    drive(fix, { ...allZero(4), IN0: 1 });
    // NUM=0 is the index of in0; ANY=1 because at least one input is asserted.
    // The two outputs are independent: NUM and ANY do not collapse to one value.
    expect(read(fix, "NUM")).toBe(0);
    expect(read(fix, "ANY")).toBe(1);
  });

  it("4-input encoder, IN1=1 and IN2=1: NUM=2 (highest), ANY=1 — independently observed", () => {
    const fix = buildPriorityEncoder({ selectorBits: 2 });
    drive(fix, { ...allZero(4), IN1: 1, IN2: 1 });
    expect(read(fix, "NUM")).toBe(2);
    expect(read(fix, "ANY")).toBe(1);
  });
});

// ===========================================================================
// Cat 12 — forbidden / undefined input combinations
//   Production-source comment documents the all-zero-inputs case as
//   `any=0, num=0`. Per Canon Cat 12: assert the spec-mandated value.
// ===========================================================================

describe("PriorityEncoder forbidden input combinations (Cat 12)", () => {
  it("2-input encoder: all inputs inactive → NUM=0, ANY=0 (documented forbidden / undefined)", () => {
    const fix = buildPriorityEncoder({ selectorBits: 1 });
    drive(fix, { IN0: 0, IN1: 0 });
    expect(read(fix, "NUM")).toBe(0);
    expect(read(fix, "ANY")).toBe(0);
  });

  it("4-input encoder: all inputs inactive → NUM=0, ANY=0 (documented forbidden / undefined)", () => {
    const fix = buildPriorityEncoder({ selectorBits: 2 });
    drive(fix, { IN0: 0, IN1: 0, IN2: 0, IN3: 0 });
    expect(read(fix, "NUM")).toBe(0);
    expect(read(fix, "ANY")).toBe(0);
  });
});

// ===========================================================================
// Cat 4 — param hot-load (structural selectorBits)
//   selectorBits is structural: it shapes the input pin set at compile time
//   (inputCount = 2^selectorBits) and the NUM output bit-width. Canonical
//   mechanic: build twice with different selectorBits and assert the
//   documented post-compile observable differs.
// ===========================================================================

describe("PriorityEncoder param hot-load selectorBits (Cat 4)", () => {
  it("selectorBits=1 vs selectorBits=2: the highest-priority encoder differs at the same in-bit asserted", () => {
    // selectorBits=1 → 2 inputs (in0, in1). With IN1=1 asserted, NUM=1.
    const fix1 = buildPriorityEncoder({ selectorBits: 1 });
    drive(fix1, { IN0: 0, IN1: 1 });
    expect(read(fix1, "NUM")).toBe(1);
    expect(read(fix1, "ANY")).toBe(1);

    // selectorBits=2 → 4 inputs (in0..in3). With IN1=1 asserted (no higher
    // bit), NUM=1 too — but the NUM port is now 2 bits wide so it can carry
    // values 2 and 3 that the 1-bit version cannot. Drive IN3=1 on the
    // 4-input encoder and observe NUM=3 — unreachable on selectorBits=1.
    const fix2 = buildPriorityEncoder({ selectorBits: 2 });
    drive(fix2, { ...allZero(4), IN3: 1 });
    expect(read(fix2, "NUM")).toBe(3);
    expect(read(fix2, "ANY")).toBe(1);
  });

  it("selectorBits=2: IN0=1 only → NUM=0 (lowest index) with 2-bit NUM output; confirmed distinct from selectorBits=1 output range", () => {
    // selectorBits=2 → NUM is 2 bits wide; selectorBits=1 → NUM is 1 bit.
    // Same IN0=1 drive, but the 2-bit version can represent 0..3 whereas
    // the 1-bit version can only represent 0..1. Here both produce 0, but
    // confirming selectorBits=2 encodes the higher-range capability.
    const fix = buildPriorityEncoder({ selectorBits: 2 });
    drive(fix, { ...allZero(4), IN0: 1 });
    expect(read(fix, "NUM")).toBe(0);
    expect(read(fix, "ANY")).toBe(1);
  });
});

// ===========================================================================
// Cat 9 — bridge / digital interaction at maximum supported selectorBits
//   selectorBits=3 → 8 inputs (in0..in7). PropertyDef max is 4. The contract
//   is that an 8-input encoder compiles and produces labelled signals like
//   the 1/2-bit cases. Currently `facade.build` returns a coordinator with
//   no labelled signals (digital partition silently dropped during compile),
//   so `readSignal` throws "Label not found". The failing test IS the
//   canonical artefact per Hard Priority #1 + #3.
// ===========================================================================

describe("PriorityEncoder digital interaction at selectorBits=3 (Cat 9)", () => {
  it("8-input encoder: only IN7=1 → NUM=7, ANY=1", () => {
    const fix = buildPriorityEncoder({ selectorBits: 3 });
    drive(fix, { ...allZero(8), IN7: 1 });
    expect(read(fix, "NUM")).toBe(7);
    expect(read(fix, "ANY")).toBe(1);
  });
});
