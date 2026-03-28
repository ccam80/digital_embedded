import { test, expect } from '@playwright/test';

const ANALOG_RC_XML = `<?xml version="1.0" encoding="utf-8"?>
<circuit><version>2</version><attributes><entry><string>romContent</string><romList><roms/></romList></entry></attributes><visualElements><visualElement><elementName>AcVoltageSource</elementName><elementAttributes><entry><string>Label</string><string>Vs</string></entry><entry><string>Amplitude</string><int>5</int></entry><entry><string>Frequency</string><int>100</int></entry></elementAttributes><pos x="140" y="200"/></visualElement><visualElement><elementName>Resistor</elementName><elementAttributes><entry><string>Label</string><string>R1</string></entry><entry><string>resistance</string><int>1000</int></entry></elementAttributes><pos x="300" y="200"/></visualElement><visualElement><elementName>Capacitor</elementName><elementAttributes><entry><string>Label</string><string>C1</string></entry><entry><string>capacitance</string><double>1.0E-6</double></entry></elementAttributes><pos x="460" y="200"/></visualElement><visualElement><elementName>Ground</elementName><elementAttributes/><pos x="220" y="300"/></visualElement><visualElement><elementName>Ground</elementName><elementAttributes/><pos x="540" y="300"/></visualElement></visualElements><wires><wire><p1 x="140" y="200"/><p2 x="300" y="200"/></wire><wire><p1 x="380" y="200"/><p2 x="460" y="200"/></wire><wire><p1 x="540" y="200"/><p2 x="540" y="300"/></wire><wire><p1 x="220" y="200"/><p2 x="220" y="300"/></wire></wires></circuit>`;

test('diagnostic: use import to create headless facade', async ({ page }) => {
  await page.goto('/simulator.html');
  await page.locator('#sim-canvas').waitFor({ state: 'visible' });
  await page.waitForTimeout(500);

  const result = await page.evaluate(async (xml) => {
    const { DefaultSimulatorFacade } = await import('/src/headless/default-facade.ts');
    const { loadDig } = await import('/src/io/dig-loader.ts');
    const { ComponentRegistry } = await import('/src/core/registry.ts');
    const { registerAllComponents } = await import('/src/components/register-all.ts');
    
    const registry = new ComponentRegistry();
    registerAllComponents(registry);
    const facade = new DefaultSimulatorFacade(registry);
    const circuit = loadDig(xml, registry);
    circuit.normalizeWires();
    
    const coordinator = facade.compile(circuit);
    
    const info = {
      timingModel: coordinator.timingModel,
      simTimeBefore: coordinator.simTime,
      stateBefore: coordinator.getState(),
      hasAnalog: coordinator.simTime !== null,
    };
    
    // Step
    let stepErr: string | null = null;
    try {
      coordinator.step();
    } catch (e: any) {
      stepErr = e.message;
    }
    
    const info2 = {
      simTimeAfterStep: coordinator.simTime,
      stateAfterStep: coordinator.getState(),
      stepErr,
    };
    
    // 10 more steps
    for (let i = 0; i < 10; i++) {
      try { coordinator.step(); } catch { break; }
    }
    
    return {
      ...info,
      ...info2,
      simTimeAfter11Steps: coordinator.simTime,
      stateAfter11: coordinator.getState(),
    };
  }, ANALOG_RC_XML);
  
  console.log('RESULT:', JSON.stringify(result, null, 2));
  expect(true).toBe(true);
});
