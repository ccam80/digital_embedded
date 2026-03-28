import { describe, it, expect } from 'vitest';
import { ComponentRegistry } from '../core/registry.js';
import { loadDig } from '../io/dig-loader.js';
import { compileUnified } from '../compile/compile.js';
import { resolveModelAssignments } from '../compile/extract-connectivity.js';
import { ResistorDefinition } from '../components/passives/resistor.js';
import { CapacitorDefinition } from '../components/passives/capacitor.js';
import { GroundDefinition } from '../components/io/ground.js';
import { AcVoltageSourceDefinition } from '../components/sources/ac-voltage-source.js';

const ANALOG_RC_XML = `<?xml version="1.0" encoding="utf-8"?>
<circuit><version>2</version><attributes><entry><string>romContent</string><romList><roms/></romList></entry></attributes><visualElements><visualElement><elementName>AcVoltageSource</elementName><elementAttributes><entry><string>Label</string><string>Vs</string></entry><entry><string>Amplitude</string><int>5</int></entry><entry><string>Frequency</string><int>100</int></entry></elementAttributes><pos x="140" y="260"/></visualElement><visualElement><elementName>Resistor</elementName><elementAttributes><entry><string>Label</string><string>R1</string></entry><entry><string>resistance</string><int>1000</int></entry></elementAttributes><pos x="300" y="200"/></visualElement><visualElement><elementName>Capacitor</elementName><elementAttributes><entry><string>Label</string><string>C1</string></entry><entry><string>capacitance</string><double>1.0E-6</double></entry></elementAttributes><pos x="460" y="200"/></visualElement><visualElement><elementName>Ground</elementName><elementAttributes/><pos x="220" y="300"/></visualElement><visualElement><elementName>Ground</elementName><elementAttributes/><pos x="540" y="300"/></visualElement></visualElements><wires><wire><p1 x="140" y="260"/><p2 x="140" y="200"/></wire><wire><p1 x="140" y="200"/><p2 x="300" y="200"/></wire><wire><p1 x="380" y="200"/><p2 x="460" y="200"/></wire><wire><p1 x="540" y="200"/><p2 x="540" y="300"/></wire><wire><p1 x="220" y="260"/><p2 x="220" y="300"/></wire></wires></circuit>`;

describe('RC XML partition diagnostics', () => {
  it('check model assignments and partition', () => {
    const registry = new ComponentRegistry();
    registry.register(ResistorDefinition);
    registry.register(CapacitorDefinition);
    registry.register(GroundDefinition);
    registry.register(AcVoltageSourceDefinition);

    const circuit = loadDig(ANALOG_RC_XML, registry);
    circuit.normalizeWires();
    
    console.log('Elements:');
    for (let i = 0; i < circuit.elements.length; i++) {
      const el = circuit.elements[i];
      console.log(`  [${i}] typeId=${el.typeId} pos=(${el.position.x},${el.position.y})`);
    }
    console.log('Wires:');
    for (const w of circuit.wires) {
      console.log(`  (${w.start.x},${w.start.y}) -> (${w.end.x},${w.end.y})`);
    }
    
    const assignments = resolveModelAssignments(circuit.elements, registry);
    console.log('Model assignments:');
    for (const a of assignments) {
      console.log(`  [${a.elementIndex}] modelKey=${a.modelKey} model=${a.model !== null}`);
    }
    
    const unified = compileUnified(circuit, registry);
    console.log('hasDigital:', unified.digital !== null);
    console.log('hasAnalog:', unified.analog !== null);
    if (unified.analog) {
      console.log('analog elements:', unified.analog.elements.length);
      console.log('analog matrixSize:', unified.analog.matrixSize);
      console.log('analog nodeCount:', unified.analog.nodeCount);
      for (let i = 0; i < unified.analog.elements.length; i++) {
        const el = unified.analog.elements[i];
        console.log(`  analog el[${i}]: pinNodeIds=[${el.pinNodeIds}] isReactive=${el.isReactive}`);
      }
    }
    
    expect(true).toBe(true);
  });
});
