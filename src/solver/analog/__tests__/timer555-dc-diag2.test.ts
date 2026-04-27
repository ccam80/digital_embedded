import { it } from "vitest";
import { MNAEngine } from "../analog-engine.js";
import { Timer555Definition } from "../../../components/active/timer-555.js";
import { PropertyBag } from "../../../core/properties.js";
import { ConcreteCompiledAnalogCircuit } from "../compiled-analog-circuit.js";
import { StatePool } from "../state-pool.js";
import type { AnalogElement } from "../element.js";
import { makeVoltageSource } from "./test-helpers.js";
import type { SetupContext } from "../setup-context.js";

it("timer555 dc diag - internal_divider exact nodes", () => {
  const entry = Timer555Definition.modelRegistry!["bipolar"]!;
  if (entry.kind !== "inline") throw new Error();
  const factory = entry.factory;
  const VCC = 5;
  const nVcc = 1, nCtrl = 2, nOut = 3;
  const nRst = 1;
  const brVcc = 3;

  const pinNodes = new Map([["DIS",0],["TRIG",0],["THR",0],["VCC",nVcc],["CTRL",nCtrl],["OUT",nOut],["RST",nRst],["GND",0]]);
  const props = new PropertyBag();
  props.replaceModelParams({ vDrop: 1.5, rDischarge: 10 });
  const core = factory(pinNodes, props, () => 0);
  const timer = Object.assign(core, {
    pinNodeIds:[0,0,0,1,2,3,1,0],
    allNodeIds:[0,0,0,1,2,3,1,0]
  }) as unknown as AnalogElement;

  const vsBase = makeVoltageSource(nVcc, 0, brVcc, VCC);
  const vsVcc = Object.assign(vsBase, { _stateBase:-1, _pinNodes:new Map(), setup(_ctx:SetupContext){} });

  const compiled = new ConcreteCompiledAnalogCircuit({
    nodeCount: 3,
    elements: [timer, vsVcc as any],
    labelToNodeId: new Map(),
    wireToNodeId: new Map() as any,
    models: new Map(),
    elementToCircuitElement: new Map(),
    statePool: new StatePool(0),
  });
  const engine = new MNAEngine();
  engine.init(compiled);
  const result = engine.dcOperatingPoint();
  console.log("converged:", result.converged, "iterations:", result.iterations);
  console.log("nodeVoltages length:", result.nodeVoltages.length);
  for(let i = 0; i < Math.min(result.nodeVoltages.length, 15); i++) {
    console.log(`  v[${i}] = ${result.nodeVoltages[i]}`);
  }
  console.log("CTRL at nCtrl=2:", result.nodeVoltages[nCtrl]);
});
