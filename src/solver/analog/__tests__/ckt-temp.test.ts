/**
 * Unit tests for the temperature pass wiring (Phase 3).
 *
 * Verifies that:
 *   1. _setup() invokes computeTemperature exactly once per element that
 *      declares it (via the default temperature handler and cktTemp dispatcher).
 *   2. setCircuitTemp(K) invokes computeTemperature exactly once more per
 *      such element, with the updated temperature in ctx.cktTemp.
 *   3. ctx.cktTemp reflects the new temperature after setCircuitTemp(350).
 */

import { describe, it, expect, afterEach } from "vitest";
import { buildFixture } from "./fixtures/build-fixture.js";
import { AnalogElement } from "../element.js";
import { NGSPICE_LOAD_ORDER, type DeviceFamily } from "../ngspice-load-order.js";
import type { SetupContext } from "../setup-context.js";
import type { LoadContext } from "../load-context.js";
import type { TempContext } from "../temp-context.js";
import { ComponentCategory, type StandaloneComponentDefinition } from "../../../core/registry.js";
import { AbstractCircuitElement } from "../../../core/element.js";
import { PropertyBag } from "../../../core/properties.js";
import { PinDirection } from "../../../core/pin.js";

// ---------------------------------------------------------------------------
// Minimal CircuitElement for the StandaloneComponentDefinition factory.
// The editor layer requires a CircuitElement; the simulator layer reads
// pinLayout from the definition, not getPins(), so this is a stub.
// ---------------------------------------------------------------------------

class ProbeCircuitElement extends AbstractCircuitElement {
  constructor(typeId: string, props: PropertyBag) {
    super(typeId, crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
  }

  getPins() {
    return [
      {
        position: { x: 0, y: 0 },
        label: "pos",
        direction: PinDirection.BIDIRECTIONAL,
        isNegated: false,
        isClock: false,
        kind: "signal" as const,
        bitWidth: 1,
      },
      {
        position: { x: 4, y: 0 },
        label: "neg",
        direction: PinDirection.BIDIRECTIONAL,
        isNegated: false,
        isClock: false,
        kind: "signal" as const,
        bitWidth: 1,
      },
    ];
  }

  getBoundingBox() {
    return { x: 0, y: 0, width: 40, height: 10 };
  }

  draw() { /* no-op */ }
}

// ---------------------------------------------------------------------------
// Observable analog element -- stamps as a 1 MΩ resistor and records
// each computeTemperature(ctx) invocation into a shared array.
// ---------------------------------------------------------------------------

class ObservableElement extends AnalogElement {
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.RES;
  readonly deviceFamily: DeviceFamily = "RES";

  private readonly _invocations: TempContext[];

  // Cached matrix handles allocated in setup(), consumed by load() via stampElement.
  // Mirror ngspice RES instance pointers RESposPosptr / RESnegNegptr / RESposNegptr / RESnegPosptr.
  private _hPP: number = -1;
  private _hNN: number = -1;
  private _hPN: number = -1;
  private _hNP: number = -1;

  constructor(
    pinNodes: ReadonlyMap<string, number>,
    invocations: TempContext[],
  ) {
    super(pinNodes);
    this._invocations = invocations;
  }

  setup(ctx: SetupContext): void {
    const solver = ctx.solver;
    const posNode = this.pinNodes.get("pos")!;
    const negNode = this.pinNodes.get("neg")!;
    this._hPP = solver.allocElement(posNode, posNode);
    this._hNN = solver.allocElement(negNode, negNode);
    this._hPN = solver.allocElement(posNode, negNode);
    this._hNP = solver.allocElement(negNode, posNode);
  }

  load(ctx: LoadContext): void {
    const G = 1e-6; // 1 MΩ conductance -- keeps matrix well-conditioned
    ctx.solver.stampElement(this._hPP,  G);
    ctx.solver.stampElement(this._hNN,  G);
    ctx.solver.stampElement(this._hPN, -G);
    ctx.solver.stampElement(this._hNP, -G);
  }

  getPinCurrents(rhs: Float64Array): number[] {
    const G = 1e-6;
    const posNode = this.pinNodes.get("pos")!;
    const negNode = this.pinNodes.get("neg")!;
    const v = rhs[posNode] - rhs[negNode];
    const i = G * v;
    return [i, -i];
  }

  setParam(_key: string, _value: number): void { /* no mutable params */ }

  computeTemperature(ctx: TempContext): void {
    this._invocations.push(ctx);
  }
}

// ---------------------------------------------------------------------------
// Shared invocation log -- reset in afterEach
// ---------------------------------------------------------------------------

let invocations: TempContext[] = [];

afterEach(() => {
  invocations = [];
});

// ---------------------------------------------------------------------------
// Helper: build a minimal component definition for ObservableElement
// ---------------------------------------------------------------------------

function makeProbeDefinition(
  name: string,
  invocationsTarget: TempContext[],
): StandaloneComponentDefinition {
  return {
    name,
    typeId: -1,
    defaultModel: "behavioral",
    factory: (props) => new ProbeCircuitElement(name, props),
    pinLayout: [
      {
        direction: PinDirection.BIDIRECTIONAL,
        label: "pos",
        defaultBitWidth: 1,
        position: { x: 0, y: 0 },
        isNegatable: false,
        isClockCapable: false,
        kind: "signal",
      },
      {
        direction: PinDirection.BIDIRECTIONAL,
        label: "neg",
        defaultBitWidth: 1,
        position: { x: 4, y: 0 },
        isNegatable: false,
        isClockCapable: false,
        kind: "signal",
      },
    ],
    propertyDefs: [
      { key: "label", label: "Label", type: "string" as const, defaultValue: "", description: "" },
    ],
    attributeMap: [],
    category: ComponentCategory.MISC,
    helpText: "Test temperature probe",
    models: {},
    modelRegistry: {
      behavioral: {
        kind: "inline",
        factory: (pinNodes) =>
          new ObservableElement(pinNodes, invocationsTarget),
        paramDefs: [],
        params: {},
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ckt-temp -- temperature pass observability", () => {
  it("_setup() invokes computeTemperature exactly once per ObservableElement", () => {
    const N = 3;
    const capturedInvocations: TempContext[] = [];

    const fix = buildFixture({
      build: (registry, facade) => {
        registry.register(makeProbeDefinition("TempProbe", capturedInvocations));

        return facade.build({
          components: [
            { id: "V1", type: "DcVoltageSource", props: { voltage: 5 } },
            { id: "P1", type: "TempProbe" },
            { id: "P2", type: "TempProbe" },
            { id: "P3", type: "TempProbe" },
          ],
          connections: [
            ["V1:pos", "P1:pos"],
            ["P1:pos", "P2:pos"],
            ["P2:pos", "P3:pos"],
            ["V1:neg", "P1:neg"],
            ["P1:neg", "P2:neg"],
            ["P2:neg", "P3:neg"],
          ],
        });
      },
    });

    // buildFixture runs coordinator.step() which calls _setup().
    // _setup() calls cktTemp() once at its end (task 3.1.2).
    // Each ObservableElement.computeTemperature is called once per cktTemp().
    expect(capturedInvocations.length).toBe(N);

    invocations = capturedInvocations;
    void fix.coordinator;
  });

  it("setCircuitTemp(350) invokes computeTemperature exactly once more per element", () => {
    const N = 2;
    const capturedInvocations: TempContext[] = [];

    const fix = buildFixture({
      build: (registry, facade) => {
        registry.register(makeProbeDefinition("TempProbe2", capturedInvocations));

        return facade.build({
          components: [
            { id: "V1", type: "DcVoltageSource", props: { voltage: 5 } },
            { id: "P1", type: "TempProbe2" },
            { id: "P2", type: "TempProbe2" },
          ],
          connections: [
            ["V1:pos", "P1:pos"],
            ["P1:pos", "P2:pos"],
            ["V1:neg", "P1:neg"],
            ["P1:neg", "P2:neg"],
          ],
        });
      },
    });

    // After warm-start: _setup() -> cktTemp() -> N calls
    expect(capturedInvocations.length).toBe(N);

    // setCircuitTemp triggers cktTemp() once more -> N additional calls
    fix.facade.setCircuitTemp(350);
    expect(capturedInvocations.length).toBe(2 * N);

    invocations = capturedInvocations;
    void fix.coordinator;
  });

  it("ctx.cktTemp reflects the temperature set by setCircuitTemp(350)", () => {
    const capturedInvocations: TempContext[] = [];

    const fix = buildFixture({
      build: (registry, facade) => {
        registry.register(makeProbeDefinition("TempProbe3", capturedInvocations));

        return facade.build({
          components: [
            { id: "V1", type: "DcVoltageSource", props: { voltage: 5 } },
            { id: "P1", type: "TempProbe3" },
          ],
          connections: [
            ["V1:pos", "P1:pos"],
            ["V1:neg", "P1:neg"],
          ],
        });
      },
    });

    // _setup() call uses default temperature (300.15 K = REFTEMP)
    expect(capturedInvocations[0]?.cktTemp).toBe(300.15);

    // After setCircuitTemp, the ctx passed to computeTemperature carries 350 K
    fix.facade.setCircuitTemp(350);
    expect(capturedInvocations[1]?.cktTemp).toBe(350);

    invocations = capturedInvocations;
    void fix.coordinator;
  });
});
