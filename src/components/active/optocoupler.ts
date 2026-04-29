/**
 * Optocoupler (opto-isolator) analog component — F4b composition.
 *
 * Decomposes into 4 sub-elements at compile time per PB-OPTO spec:
 *   dLed      (DIO)  — LED input diode, diosetup.c:198-238
 *   vSense    (VSRC) — 0-volt sense source in series with dLed, vsrcset.c:40-55
 *   cccsCouple(CCCS) — CTR × I_LED injected to phototransistor base, cccsset.c:30-50
 *   bjtPhoto  (BJT NPN) — phototransistor output, bjtsetup.c:347-465
 *
 * Internal nodes allocated in setup():
 *   _nSenseMid: mid-node between dLed cathode and vSense positive terminal
 *   _nBase:     phototransistor base node (no external pin)
 *
 * Galvanic isolation: no shared MNA nodes between input (anode/cathode) and
 * output (collector/emitter). The CCCS coupling is algebraic only.
 *
 * Setup order (NGSPICE_LOAD_ORDER ascending):
 *   1. ctx.makeVolt(label, "senseMid") — allocate LED/sense-source mid-node
 *   2. ctx.makeVolt(label, "base")     — allocate phototransistor base node
 *   3. dLed.setup(ctx)        — DIO TSTALLOC (diosetup.c:232-238, 7 entries)
 *   4. vSense.setup(ctx)      — VSRC TSTALLOC (vsrcset.c:52-55, 4 entries)
 *   5. cccsCouple.setup(ctx)  — CCCS TSTALLOC (cccsset.c:49-50, 2 entries)
 *   6. bjtPhoto.setup(ctx)    — BJT TSTALLOC (bjtsetup.c:435-464, 23 entries)
 */

import { AbstractCircuitElement } from "../../core/element.js";
import type { RenderContext, Rect } from "../../core/renderer-interface.js";
import type { PinVoltageAccess } from "../../core/pin-voltage-access.js";
import { drawColoredLead } from "../draw-helpers.js";
import type { Pin, PinDeclaration, Rotation } from "../../core/pin.js";
import { PinDirection } from "../../core/pin.js";
import { PropertyBag, PropertyType } from "../../core/properties.js";
import type { PropertyDefinition } from "../../core/properties.js";
import {
  ComponentCategory,
  type AttributeMapping,
  type ComponentDefinition,
} from "../../core/registry.js";
import type { AnalogElement } from "../../core/analog-types.js";
import { NGSPICE_LOAD_ORDER } from "../../core/analog-types.js";
import type { LoadContext } from "../../solver/analog/load-context.js";
import type { SetupContext } from "../../solver/analog/setup-context.js";
import { defineModelParams } from "../../core/model-params.js";
import { stampRHS } from "../../solver/analog/stamp-helpers.js";

import {
  createDiodeElement,
  DIODE_PARAM_DEFAULTS,
} from "../semiconductors/diode.js";
import {
  createBjtElement,
  BJT_NPN_DEFAULTS,
} from "../semiconductors/bjt.js";

// ---------------------------------------------------------------------------
// Model parameter declarations
// ---------------------------------------------------------------------------

export const { paramDefs: OPTOCOUPLER_PARAM_DEFS, defaults: OPTOCOUPLER_DEFAULTS } = defineModelParams({
  primary: {
    ctr: { default: 1.0,   description: "Current transfer ratio CTR = I_collector / I_LED" },
    Is:  { default: 1e-14, unit: "A", description: "LED saturation current (dioload.c IS)" },
    n:   { default: 1.0,              description: "LED emission coefficient (dioload.c N)" },
  },
});

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

function buildOptocouplerPinDeclarations(): PinDeclaration[] {
  return [
    {
      direction: PinDirection.INPUT,
      label: "anode",
      defaultBitWidth: 1,
      position: { x: 0, y: -1 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.INPUT,
      label: "cathode",
      defaultBitWidth: 1,
      position: { x: 0, y: 1 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.OUTPUT,
      label: "collector",
      defaultBitWidth: 1,
      position: { x: 4, y: -1 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.OUTPUT,
      label: "emitter",
      defaultBitWidth: 1,
      position: { x: 4, y: 1 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
  ];
}

// ---------------------------------------------------------------------------
// Helpers to build PropertyBag for sub-elements
// ---------------------------------------------------------------------------

function makeLedProps(Is: number, n: number): PropertyBag {
  const bag = new PropertyBag(new Map<string, number>().entries());
  const merged: Record<string, number> = { ...DIODE_PARAM_DEFAULTS, IS: Is, N: n };
  bag.replaceModelParams(merged);
  return bag;
}

function makeBjtProps(): PropertyBag {
  const bag = new PropertyBag(new Map<string, number>().entries());
  bag.replaceModelParams({ ...BJT_NPN_DEFAULTS });
  return bag;
}

// ---------------------------------------------------------------------------
// VsenseSubElement — 0-volt sense source in series with dLed
//
// Inline implementation per PB-VSRC-DC (vsrcset.c:40-55, vsrcload.c).
// Instantiated only inside OptocouplerCompositeElement. The sense source
// measures I_LED via its branch variable; cccsCouple reads that branch.
// ---------------------------------------------------------------------------

class VsenseSubElement implements AnalogElement {
  label: string = "";
  branchIndex: number = -1;
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.VSRC;
  _stateBase: number = -1;
  _pinNodes: Map<string, number>;

  private _hPosBr: number = -1;
  private _hNegBr: number = -1;
  private _hBrNeg: number = -1;
  private _hBrPos: number = -1;

  constructor(label: string, posNode: number, negNode: number) {
    this.label = label;
    this._pinNodes = new Map([["pos", posNode], ["neg", negNode]]);
  }

  setPinNode(label: string, node: number): void {
    this._pinNodes.set(label, node);
  }

  setup(ctx: SetupContext): void {
    const posNode = this._pinNodes.get("pos")!;
    const negNode = this._pinNodes.get("neg")!;

    // vsrcset.c:40-43 — idempotent branch allocation
    if (this.branchIndex === -1) {
      this.branchIndex = ctx.makeCur(this.label, "branch");
    }
    const branchNode = this.branchIndex;

    // vsrcset.c:52-55 — TSTALLOC sequence (line-for-line)
    this._hPosBr = ctx.solver.allocElement(posNode,    branchNode);
    this._hNegBr = ctx.solver.allocElement(negNode,    branchNode);
    this._hBrNeg = ctx.solver.allocElement(branchNode, negNode);
    this._hBrPos = ctx.solver.allocElement(branchNode, posNode);
  }

  findBranchFor(_name: string, ctx: SetupContext): number {
    // Mirrors VSRCfindBr (vsrc/vsrcfbr.c:26-39). Lazily allocates branch.
    if (this.branchIndex === -1) {
      this.branchIndex = ctx.makeCur(this.label, "branch");
    }
    return this.branchIndex;
  }

  load(ctx: LoadContext): void {
    const branchNode = this.branchIndex;

    // vsrcload.c:43-46 — KVL/KCL matrix stamps via cached handles
    ctx.solver.stampElement(this._hPosBr, +1.0);
    ctx.solver.stampElement(this._hNegBr, -1.0);
    ctx.solver.stampElement(this._hBrPos, +1.0);
    ctx.solver.stampElement(this._hBrNeg, -1.0);

    // vsrcload.c RHS — 0-volt source: no RHS contribution (V=0)
    // Suppress unused-variable warning — branchNode used for clarity only.
    void branchNode;
  }

  setParam(_key: string, _value: number): void {
    // No user-settable params on the 0-volt sense source.
  }

  getPinCurrents(rhs: Float64Array): number[] {
    const I = rhs[this.branchIndex];
    return [-I, I];
  }
}

// ---------------------------------------------------------------------------
// CccsSubElement — CTR × I_LED CCCS coupling into phototransistor base
//
// Inline implementation per PB-CCCS (cccsset.c:30-50, cccsload.c).
// Reads the sense branch current from vSense and injects CTR * I_LED
// into the phototransistor base node.
// ---------------------------------------------------------------------------

class CccsSubElement implements AnalogElement {
  label: string = "";
  branchIndex: number = -1;
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.CCCS;
  _stateBase: number = -1;
  _pinNodes: Map<string, number>;
  private readonly _gain: number;
  private readonly _senseLabel: string;

  private _contBranch: number = -1;
  private _hPCtBr: number = -1;
  private _hNCtBr: number = -1;

  constructor(label: string, posNode: number, negNode: number, gain: number, senseLabel: string) {
    this.label = label;
    this._gain = gain;
    this._senseLabel = senseLabel;
    this._pinNodes = new Map([["pos", posNode], ["neg", negNode]]);
  }

  setPinNode(label: string, node: number): void {
    this._pinNodes.set(label, node);
  }

  setup(ctx: SetupContext): void {
    const posNode = this._pinNodes.get("pos")!;
    const negNode = this._pinNodes.get("neg")!;

    // cccsset.c:36 — resolve controlling branch (lazy-allocating via findBranchFor)
    const contBranch = ctx.findBranch(this._senseLabel);
    if (contBranch === 0) {
      throw new Error(
        `CCCS '${this.label}': unknown controlling source '${this._senseLabel}'`,
      );
    }
    this._contBranch = contBranch;

    // cccsset.c:49-50 — TSTALLOC sequence (line-for-line)
    this._hPCtBr = ctx.solver.allocElement(posNode, contBranch);
    this._hNCtBr = ctx.solver.allocElement(negNode, contBranch);
  }

  load(ctx: LoadContext): void {
    const iSense = ctx.rhsOld[this._contBranch];
    const gm = this._gain;
    const iNR = gm * iSense - gm * iSense;  // NR constant = 0 for linear CCCS

    ctx.solver.stampElement(this._hPCtBr, -gm);
    ctx.solver.stampElement(this._hNCtBr, +gm);

    const posNode = this._pinNodes.get("pos")!;
    const negNode = this._pinNodes.get("neg")!;
    if (iNR !== 0) {
      stampRHS(ctx.rhs, posNode,  iNR);
      stampRHS(ctx.rhs, negNode, -iNR);
    }
  }

  setParam(_key: string, _value: number): void {
    // No user-settable params on the composite-internal CCCS.
  }

  getPinCurrents(_rhs: Float64Array): number[] {
    return [0, 0];
  }
}

// ---------------------------------------------------------------------------
// OptocouplerCompositeElement — composite AnalogElement
// ---------------------------------------------------------------------------

class OptocouplerCompositeElement implements AnalogElement {
  label: string = "";
  branchIndex: number = -1;
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.DIO;
  _stateBase: number = -1;
  _pinNodes: Map<string, number>;

  private _internalLabels: string[] = [];

  getInternalNodeLabels(): readonly string[] {
    return this._internalLabels;
  }

  readonly _dLed: ReturnType<typeof createDiodeElement>;
  readonly _vSense: VsenseSubElement;
  readonly _cccsCouple: CccsSubElement;
  readonly _bjtPhoto: ReturnType<typeof createBjtElement>;

  constructor(
    pinNodes: ReadonlyMap<string, number>,
    dLed: ReturnType<typeof createDiodeElement>,
    vSense: VsenseSubElement,
    cccsCouple: CccsSubElement,
    bjtPhoto: ReturnType<typeof createBjtElement>,
  ) {
    this._pinNodes = new Map(pinNodes);
    this._dLed = dLed;
    this._vSense = vSense;
    this._cccsCouple = cccsCouple;
    this._bjtPhoto = bjtPhoto;
  }

  setup(ctx: SetupContext): void {
    const nAnode     = this._pinNodes.get("anode")!;
    const nCathode   = this._pinNodes.get("cathode")!;
    const nCollector = this._pinNodes.get("collector")!;
    const nEmitter   = this._pinNodes.get("emitter")!;

    // Allocate internal nodes; record labels for getInternalNodeLabels()
    this._internalLabels = [];
    const deviceLabel = this._vSense.label.replace(/_vSense$/, "") || this.label || "optocoupler";
    const nSenseMid = ctx.makeVolt(deviceLabel, "senseMid");
    this._internalLabels.push("senseMid");
    const nBase     = ctx.makeVolt(deviceLabel, "base");
    this._internalLabels.push("base");

    // Wire dLed: anode → senseMid (K = senseMid, was 0 at construction)
    (this._dLed as any)._pinNodes.set("K", nSenseMid);

    // Wire vSense: senseMid → cathode (0-volt sense source)
    this._vSense.setPinNode("pos", nSenseMid);
    this._vSense.setPinNode("neg", nCathode);

    // Wire cccsCouple output: nBase → emitter
    this._cccsCouple.setPinNode("pos", nBase);
    this._cccsCouple.setPinNode("neg", nEmitter);

    // Wire bjtPhoto base
    (this._bjtPhoto as any)._pinNodes.set("B", nBase);

    // Suppress unused variable warnings for nodes used only in wiring
    void nAnode; void nCollector;

    // Sub-element setup in NGSPICE_LOAD_ORDER (ascending):
    // DIO(7) < VSRC(8) < CCCS(15) < BJT(40)
    this._dLed.setup(ctx);         // DIO: diosetup.c:232-238, 7 entries
    this._vSense.setup(ctx);       // VSRC: vsrcset.c:52-55, 4 entries
    this._cccsCouple.setup(ctx);   // CCCS: cccsset.c:49-50, 2 entries (after vSense branch allocated)
    this._bjtPhoto.setup(ctx);     // BJT: bjtsetup.c:435-464, 23 entries
  }

  load(ctx: LoadContext): void {
    // 1. LED diode stamp — dioload.c:120-441
    this._dLed.load(ctx);

    // 2. Zero-volt sense source stamp — vsrcload.c
    this._vSense.load(ctx);

    // 3. CCCS coupling: CTR × I_vSense injected as photo-current to bjtPhoto base
    this._cccsCouple.load(ctx);

    // 4. BJT phototransistor stamp — bjtload.c
    this._bjtPhoto.load(ctx);
  }

  setParam(_key: string, _value: number): void {
    // Optocoupler-level param update; sub-element params are fixed at construction.
  }

  getPinCurrents(_rhs: Float64Array): number[] {
    // Pin order: [anode, cathode, collector, emitter]
    return [0, 0, 0, 0];
  }

  /** Sub-elements in dependency order. _vSense allocates the controlling
   *  branch that _cccsCouple references via findBranch during setup(); the
   *  diode and BJT are independent. Order matches setup() body. */
  getSubElements(): readonly AnalogElement[] {
    return [
      this._dLed as unknown as AnalogElement,
      this._vSense,
      this._cccsCouple,
      this._bjtPhoto as unknown as AnalogElement,
    ];
  }
}

// ---------------------------------------------------------------------------
// createOptocouplerElement factory — PB-OPTO F4b composition
// ---------------------------------------------------------------------------

function createOptocouplerElement(
  pinNodes: ReadonlyMap<string, number>,
  props: PropertyBag,
  _getTime: () => number,
): OptocouplerCompositeElement {
  const ctr = props.getModelParam<number>("ctr");
  const Is  = props.getModelParam<number>("Is");
  const n   = props.getModelParam<number>("n");

  const nAnode     = pinNodes.get("anode")!;
  const nCathode   = pinNodes.get("cathode")!;
  const nCollector = pinNodes.get("collector")!;
  const nEmitter   = pinNodes.get("emitter")!;

  const instanceLabel = "Optocoupler";

  // dLed: anode → _nSenseMid (K overwritten in setup() once _nSenseMid is allocated)
  const ledProps = makeLedProps(Is, n);
  const dLed = createDiodeElement(
    new Map([["A", nAnode], ["K", 0]]),
    ledProps,
    _getTime,
  );
  (dLed as any).label = `${instanceLabel}_dLed`;

  // vSense: 0-volt sense source; pos/_nSenseMid overwritten in setup()
  const vSenseLbl = `${instanceLabel}_vSense`;
  const vSense = new VsenseSubElement(vSenseLbl, 0, nCathode);

  // cccsCouple: sense = vSense branch; output pos/_nBase overwritten in setup()
  const cccsCoupLbl = `${instanceLabel}_cccsCouple`;
  const cccsCouple = new CccsSubElement(cccsCoupLbl, 0, nEmitter, ctr, vSenseLbl);

  // bjtPhoto: base/_nBase overwritten in setup(); C = collector, E = emitter
  const bjtProps = makeBjtProps();
  const bjtPhoto = createBjtElement(new Map([
    ["B", 0],
    ["C", nCollector],
    ["E", nEmitter],
  ]), bjtProps, _getTime);
  (bjtPhoto as any).label = `${instanceLabel}_bjtPhoto`;

  return new OptocouplerCompositeElement(pinNodes, dLed, vSense, cccsCouple, bjtPhoto);
}

// ---------------------------------------------------------------------------
// OptocouplerElement — CircuitElement
// ---------------------------------------------------------------------------

export class OptocouplerElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("Optocoupler", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildOptocouplerPinDeclarations(), []);
  }

  getBoundingBox(): Rect {
    return {
      x: this.position.x,
      y: this.position.y - 2,
      width: 4,
      height: 4,
    };
  }

  draw(ctx: RenderContext, signals?: PinVoltageAccess): void {
    const PX = 1 / 16;

    const vAnode     = signals?.getPinVoltage("anode");
    const vCathode   = signals?.getPinVoltage("cathode");
    const vCollector = signals?.getPinVoltage("collector");
    const vEmitter   = signals?.getPinVoltage("emitter");

    ctx.save();
    ctx.setLineWidth(1);

    ctx.setColor("COMPONENT");
    ctx.drawRect(0, -2, 4, 4, false);
    ctx.drawLine(2, -2, 2, 2);

    const ledHs = 8 * PX;
    const triTop  = { x: 0.5, y: -ledHs };
    const triBtm  = { x: 0.5, y: ledHs };
    const triTip  = { x: 1.5, y: 0 };
    ctx.drawPolygon([triTop, triBtm, triTip], false);
    ctx.drawLine(triTip.x - ledHs, triTip.y + ledHs,
                 triTip.x + ledHs, triTip.y - ledHs);

    for (let i = 0; i < 2; i++) {
      const ay = -0.2 + i * 0.4;
      const aBase = { x: 1.7, y: ay };
      const aTip = { x: 2.1, y: ay - 0.3 };
      const dx = aTip.x - aBase.x;
      const dy = aTip.y - aBase.y;
      const len = Math.sqrt(dx * dx + dy * dy);
      const al = 5 * PX;
      const aw = 3 * PX;
      const f = 1 - al / len;
      const cx = aBase.x * (1 - f) + aTip.x * f;
      const cy = aBase.y * (1 - f) + aTip.y * f;
      const gx = (dy / len) * aw;
      const gy = (-dx / len) * aw;
      ctx.drawPolygon(
        [{ x: aTip.x, y: aTip.y }, { x: cx + gx, y: cy + gy }, { x: cx - gx, y: cy - gy }],
        true,
      );
      ctx.drawLine(aBase.x, aBase.y, aTip.x - 5 * PX * 0.7, aTip.y + 5 * PX * 0.7);
    }

    ctx.drawCircle(3, 0, 0.7, false);
    ctx.drawLine(2.75, -0.5, 2.75, 0.5);
    ctx.drawLine(2, 0, 2.75, 0);

    const emDx = 4 - 2.75;
    const emDy = 1 - 0.5;
    const emLen = Math.sqrt(emDx * emDx + emDy * emDy);
    const emAl = 8 * PX;
    const emAw = 3 * PX;
    const emF = 1 - emAl / emLen;
    const emCx = 2.75 * (1 - emF) + 4 * emF;
    const emCy = 0.5 * (1 - emF) + 1 * emF;
    const emGx = (emDy / emLen) * emAw;
    const emGy = (-emDx / emLen) * emAw;
    ctx.drawPolygon(
      [{ x: 4, y: 1 }, { x: emCx + emGx, y: emCy + emGy }, { x: emCx - emGx, y: emCy - emGy }],
      true,
    );

    drawColoredLead(ctx, signals, vAnode, 0, -1, triTop.x, triTop.y);
    drawColoredLead(ctx, signals, vCathode, 0, 1, triBtm.x, triBtm.y);
    drawColoredLead(ctx, signals, vCollector, 2.75, -0.5, 4, -1);
    drawColoredLead(ctx, signals, vEmitter, 2.75, 0.5, 4, 1);

    ctx.setColor("TEXT");
    ctx.setFont({ family: "sans-serif", size: 0.5 });
    ctx.drawText("A", 0.15, -1.4, { horizontal: "left", vertical: "bottom" });
    ctx.drawText("K", 0.15, 1.4, { horizontal: "left", vertical: "top" });
    ctx.drawText("C", 3.85, -1.4, { horizontal: "right", vertical: "bottom" });
    ctx.drawText("E", 3.85, 1.4, { horizontal: "right", vertical: "top" });

    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const OPTOCOUPLER_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "vceSat",
    type: PropertyType.FLOAT,
    label: "V_CE saturation (V)",
    defaultValue: 0.3,
    min: 0,
    description: "Phototransistor saturation voltage V_CE in volts. Default: 0.3 V.",
  },
  {
    key: "bandwidth",
    type: PropertyType.FLOAT,
    label: "Bandwidth (Hz)",
    defaultValue: 50000,
    min: 1,
    description: "Optocoupler bandwidth in Hz. Default: 50 kHz.",
  },
  {
    key: "label",
    type: PropertyType.STRING,
    label: "Label",
    defaultValue: "",
    description: "Optional display label.",
  },
];

// ---------------------------------------------------------------------------
// Attribute mappings
// ---------------------------------------------------------------------------

const OPTOCOUPLER_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  { xmlName: "ctr",       propertyKey: "ctr",       convert: (v) => parseFloat(v), modelParam: true },
  { xmlName: "Is",        propertyKey: "Is",         convert: (v) => parseFloat(v), modelParam: true },
  { xmlName: "n",         propertyKey: "n",          convert: (v) => parseFloat(v), modelParam: true },
  { xmlName: "vceSat",    propertyKey: "vceSat",     convert: (v) => parseFloat(v) },
  { xmlName: "bandwidth", propertyKey: "bandwidth",  convert: (v) => parseFloat(v) },
  { xmlName: "Label",     propertyKey: "label",      convert: (v) => v },
];

// ---------------------------------------------------------------------------
// OptocouplerDefinition
// ---------------------------------------------------------------------------

export const OptocouplerDefinition: ComponentDefinition = {
  name: "Optocoupler",
  typeId: -1,
  category: ComponentCategory.ACTIVE,

  pinLayout: buildOptocouplerPinDeclarations(),
  propertyDefs: OPTOCOUPLER_PROPERTY_DEFS,
  attributeMap: OPTOCOUPLER_ATTRIBUTE_MAPPINGS,

  helpText:
    "Optocoupler — 4-terminal element (anode, cathode, collector, emitter). " +
    "LED input (dioload.c) + 0V sense source (vsrcload.c) + CCCS coupling (CTR) + phototransistor output (bjtload.c). " +
    "I_collector ≈ CTR * I_LED. Galvanic isolation between LED and phototransistor.",

  factory(props: PropertyBag): OptocouplerElement {
    return new OptocouplerElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
  },

  models: {},
  modelRegistry: {
    "behavioral": {
      kind: "inline",
      factory: createOptocouplerElement,
      paramDefs: OPTOCOUPLER_PARAM_DEFS,
      params: OPTOCOUPLER_DEFAULTS,
    },
  },
  defaultModel: "behavioral",
};
