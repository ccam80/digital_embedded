import { it } from "vitest";
import { MNAEngine } from "../analog-engine.js";
import { Timer555Definition } from "../../../components/active/timer-555.js";
import { PropertyBag } from "../../../core/properties.js";
import type { AnalogElement } from "../element.js";

it("dump timer555 tstalloc", () => {
  const entry = Timer555Definition.modelRegistry!["bipolar"]!;
  if (entry.kind !== "inline") throw new Error("Expected inline");
  const factory = entry.factory;
  const pinNodes = new Map([["DIS",1],["TRIG",2],["THR",3],["VCC",4],["CTRL",5],["OUT",6],["RST",7],["GND",8]]);
  const props = new PropertyBag();
  props.replaceModelParams({ vDrop: 1.5, rDischarge: 10 });
  const core = factory(pinNodes, props, () => 0);
  const el = Object.assign(core, { pinNodeIds:[1,2,3,4,5,6,7,8], allNodeIds:[1,2,3,4,5,6,7,8] }) as unknown as AnalogElement;
  const circuit = {
    nodeCount:8, elements:[el], labelToNodeId:new Map(), labelPinNodes:new Map(),
    wireToNodeId:new Map(), models:new Map(), statePool:null, componentCount:1,
    netCount:8, diagnostics:[], branchCount:0, matrixSize:8,
    bridgeOutputAdapters:[], bridgeInputAdapters:[],
    elementToCircuitElement:new Map(), resolvedPins:[],
  } as any;
  const engine = new MNAEngine();
  engine.init(circuit);
  (engine as any)._setup();
  const order = (engine as any)._solver._getInsertionOrder();
  console.log("COUNT:", order.length);
  order.forEach((e: {extRow:number,extCol:number}, i: number) => console.log(i+1, `(${e.extRow},${e.extCol})`));
});
