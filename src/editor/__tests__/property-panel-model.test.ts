/**
 * Tests for PropertyPanel model-aware display (T5).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { PropertyPanel } from '../property-panel.js';
import { PropertyBag, PropertyType } from '@/core/properties.js';
import type { CircuitElement } from '@/core/element.js';
import type { ComponentDefinition, ModelEntry, ParamDef } from '@/core/registry.js';

type AnyListener = (...args: unknown[]) => void;

class StubElement {
  tagName: string;
  textContent: string | null = null;
  value: string = '';
  style: Record<string, string> = {};
  children: StubElement[] = [];
  innerHTML: string = '';
  private readonly _listeners: Map<string, AnyListener[]> = new Map();
  constructor(tagName: string) { this.tagName = tagName.toUpperCase(); }
  appendChild(child: StubElement): StubElement { this.children.push(child); return child; }
  addEventListener(event: string, listener: AnyListener): void {
    if (!this._listeners.has(event)) this._listeners.set(event, []);
    this._listeners.get(event)!.push(listener);
  }
  dispatchEvent(event: string, detail?: unknown): void {
    const listeners = this._listeners.get(event) ?? [];
    for (const l of listeners) l(detail ?? {});
  }
  select(): void {}
  get firstChild(): StubElement | null { return this.children[0] ?? null; }
}

function makeDocument() {
  return {
    _elements: [] as StubElement[],
    createElement(tag: string): StubElement { const el = new StubElement(tag); this._elements.push(el); return el; },
    findByText(text: string): StubElement | undefined { return this._elements.find(e => e.textContent === text); },
    findByTagName(tag: string): StubElement[] { return this._elements.filter(e => e.tagName === tag.toUpperCase()); },
    findInputs(): StubElement[] { return this._elements.filter(e => e.tagName === 'INPUT'); },
    findSelects(): StubElement[] { return this._elements.filter(e => e.tagName === 'SELECT'); },
  };
}

function makeElement(modelKey?: string, modelParams?: Record<string, number>): CircuitElement {
  const bag = new PropertyBag();
  if (modelKey !== undefined) bag.set('model', modelKey);
  if (modelParams) for (const [k, v] of Object.entries(modelParams)) bag.setModelParam(k, v);
  return { typeId: 'test', instanceId: 'e1', position: { x: 0, y: 0 }, rotation: 0 as never, mirror: false, getProperties: () => bag, getPins: () => [], getBoundingBox: () => ({ x: 0, y: 0, width: 10, height: 10 } as never), draw: () => {}, serialize: () => ({} as never), getAttribute: () => undefined, setAttribute: () => {} } as unknown as CircuitElement;
}

const PRIMARY_PARAM: ParamDef = { key: 'BF', type: PropertyType.FLOAT, label: 'BF', rank: 'primary' };
const SECONDARY_PARAM: ParamDef = { key: 'NF', type: PropertyType.FLOAT, label: 'NF', rank: 'secondary' };
const UNIT_PARAM: ParamDef = { key: 'IS', type: PropertyType.FLOAT, label: 'IS', unit: 'A', rank: 'primary' };

function makeBehavioralEntry(overrides?: Partial<Record<string, number>>): ModelEntry {
  return { kind: 'inline', factory: () => { throw new Error('not used'); }, paramDefs: [PRIMARY_PARAM, SECONDARY_PARAM, UNIT_PARAM], params: { BF: 100, NF: 1, IS: 1e-14, ...overrides } };
}

function makeBjtDef(hasDigital = false): ComponentDefinition {
  return { name: 'NpnBJT', typeId: -1, factory: () => { throw new Error('x'); }, pinLayout: [], propertyDefs: [], attributeMap: [], category: 'SEMICONDUCTORS' as never, helpText: '', models: hasDigital ? { digital: {} as never } : {}, modelRegistry: { behavioral: makeBehavioralEntry() }, defaultModel: 'behavioral' } as unknown as ComponentDefinition;
}

function makeNoRegistryDef(): ComponentDefinition {
  return { name: 'Resistor', typeId: -1, factory: () => { throw new Error('x'); }, pinLayout: [], propertyDefs: [], attributeMap: [], category: 'PASSIVES' as never, helpText: '', models: {} } as unknown as ComponentDefinition;
}

let doc: ReturnType<typeof makeDocument>;
let container: StubElement;
let panel: PropertyPanel;

beforeEach(() => {
  doc = makeDocument();
  (global as Record<string, unknown>).document = doc;
  container = new StubElement('div');
  panel = new PropertyPanel(container as unknown as HTMLElement);
});

describe('showModelSelector basic rendering', () => {
  it('renders SELECT for component with modelRegistry', () => {
    panel.showModelSelector(makeElement('behavioral'), makeBjtDef());
    expect(doc.findSelects().length).toBe(1);
  });
  it('dropdown has behavioral option', () => {
    panel.showModelSelector(makeElement('behavioral'), makeBjtDef());
    expect(doc.findSelects()[0]!.children.map(o => o.value)).toContain('behavioral');
  });
  it('adds digital option when models.digital exists', () => {
    panel.showModelSelector(makeElement('behavioral'), makeBjtDef(true));
    expect(doc.findSelects()[0]!.children.map(o => o.value)).toContain('digital');
  });
  it('no digital option when models.digital absent', () => {
    panel.showModelSelector(makeElement('behavioral'), makeBjtDef(false));
    expect(doc.findSelects()[0]!.children.map(o => o.value)).not.toContain('digital');
  });
  it('runtime models appear in dropdown', () => {
    const rt: Record<string, ModelEntry> = { '2N2222': makeBehavioralEntry({ BF: 200 }) };
    panel.showModelSelector(makeElement('behavioral'), makeBjtDef(), rt);
    expect(doc.findSelects()[0]!.children.map(o => o.value)).toContain('2N2222');
  });
  it('no-op when def has no modelRegistry', () => {
    panel.showModelSelector(makeElement(), makeNoRegistryDef());
    expect(doc.findSelects().length).toBe(0);
  });
});

describe('showModelSelector primary params', () => {
  it('renders inputs for primary params', () => {
    const el = makeElement('behavioral'); el.getProperties().replaceModelParams({ BF: 100, NF: 1, IS: 1e-14 });
    panel.showModelSelector(el, makeBjtDef());
    expect(doc.findInputs().length).toBeGreaterThanOrEqual(2);
  });
  it('BF input shows 100', () => {
    const el = makeElement('behavioral'); el.getProperties().replaceModelParams({ BF: 100, NF: 1, IS: 1e-14 });
    panel.showModelSelector(el, makeBjtDef());
    expect(doc.findInputs().find(i => i.value === '100')).toBeDefined();
  });
});

describe('showModelSelector advanced parameters', () => {
  it('Advanced Parameters toggle present', () => {
    const el = makeElement('behavioral'); el.getProperties().replaceModelParams({ BF: 100, NF: 1, IS: 1e-14 });
    panel.showModelSelector(el, makeBjtDef());
    expect(doc.findByText('▶ Advanced Parameters')).toBeDefined();
  });
  it('no Advanced Parameters when only primary params', () => {
    const el = makeElement('behavioral'); el.getProperties().replaceModelParams({ BF: 100, IS: 1e-14 });
    const entry: ModelEntry = { kind: 'inline', factory: () => { throw new Error('x'); }, paramDefs: [PRIMARY_PARAM, UNIT_PARAM], params: { BF: 100, IS: 1e-14 } };
    panel.showModelSelector(el, { ...makeBjtDef(), modelRegistry: { behavioral: entry } });
    expect(doc.findByText('▶ Advanced Parameters')).toBeUndefined();
  });
});

describe('showModelSelector modified indicator', () => {
  it('accent border when param modified', () => {
    const el = makeElement('behavioral'); el.getProperties().replaceModelParams({ BF: 200, NF: 1, IS: 1e-14 });
    panel.showModelSelector(el, makeBjtDef());
    const inp = doc.findInputs().find(i => i.value === '200');
    expect(inp).toBeDefined();
    expect(inp!.style['borderColor']).toContain('accent');
  });
  it('no accent border at default value', () => {
    const el = makeElement('behavioral'); el.getProperties().replaceModelParams({ BF: 100, NF: 1, IS: 1e-14 });
    panel.showModelSelector(el, makeBjtDef());
    const inp = doc.findInputs().find(i => i.value === '100');
    expect(inp).toBeDefined();
    expect(inp!.style['borderColor'] ?? '').not.toContain('accent');
  });
});

describe('showModelSelector reset to default', () => {
  it('reset fires callback with default value', () => {
    const el = makeElement('behavioral'); el.getProperties().replaceModelParams({ BF: 200, NF: 1, IS: 1e-14 });
    const ch: Array<{ key: string; newVal: unknown }> = [];
    panel.onPropertyChange((key, _o, v) => ch.push({ key, newVal: v }));
    panel.showModelSelector(el, makeBjtDef());
    doc.findByTagName('button').filter(b => b.textContent === '↺')[0]!.dispatchEvent('click');
    const r = ch.find(c => c.key === 'model:BF');
    expect(r).toBeDefined(); expect(r!.newVal).toBe(100);
  });
  it('reset writes default to model partition', () => {
    const el = makeElement('behavioral'); el.getProperties().replaceModelParams({ BF: 200, NF: 1, IS: 1e-14 });
    panel.showModelSelector(el, makeBjtDef());
    doc.findByTagName('button').filter(b => b.textContent === '↺')[0]!.dispatchEvent('click');
    expect(el.getProperties().getModelParam('BF')).toBe(100);
  });
});

describe('showModelSelector model switch', () => {
  it('switch updates model property', () => {
    const el = makeElement('behavioral'); el.getProperties().replaceModelParams({ BF: 100, NF: 1, IS: 1e-14 });
    panel.showModelSelector(el, makeBjtDef(), { '2N2222': makeBehavioralEntry({ BF: 200 }) });
    const sel = doc.findSelects()[0]!; sel.value = '2N2222'; sel.dispatchEvent('change');
    expect(el.getProperties().get('model')).toBe('2N2222');
  });
  it('switch replaces model params', () => {
    const el = makeElement('behavioral'); el.getProperties().replaceModelParams({ BF: 100, NF: 1, IS: 1e-14 });
    panel.showModelSelector(el, makeBjtDef(), { '2N2222': makeBehavioralEntry({ BF: 200, NF: 1, IS: 1e-14 }) });
    const sel = doc.findSelects()[0]!; sel.value = '2N2222'; sel.dispatchEvent('change');
    expect(el.getProperties().getModelParam('BF')).toBe(200);
  });
  it('switch fires callback with model key', () => {
    const el = makeElement('behavioral'); el.getProperties().replaceModelParams({ BF: 100, NF: 1, IS: 1e-14 });
    const ch: Array<{ key: string; old: unknown; newVal: unknown }> = [];
    panel.onPropertyChange((key, old, v) => ch.push({ key, old, newVal: v }));
    panel.showModelSelector(el, makeBjtDef(true));
    const sel = doc.findSelects()[0]!; sel.value = 'digital'; sel.dispatchEvent('change');
    const r = ch.find(c => c.key === 'model');
    expect(r).toBeDefined(); expect(r!.old).toBe('behavioral'); expect(r!.newVal).toBe('digital');
  });
});

describe('showModelSelector param commit on blur', () => {
  it('blur updates model partition', () => {
    const el = makeElement('behavioral'); el.getProperties().replaceModelParams({ BF: 100, NF: 1, IS: 1e-14 });
    panel.showModelSelector(el, makeBjtDef());
    const inp = doc.findInputs().find(i => i.value === '100')!;
    inp.value = '150'; inp.dispatchEvent('blur');
    expect(el.getProperties().getModelParam('BF')).toBe(150);
  });
  it('blur fires callback with model param key', () => {
    const el = makeElement('behavioral'); el.getProperties().replaceModelParams({ BF: 100, NF: 1, IS: 1e-14 });
    const ch: Array<{ key: string; old: unknown; newVal: unknown }> = [];
    panel.onPropertyChange((key, old, v) => ch.push({ key, old, newVal: v }));
    panel.showModelSelector(el, makeBjtDef());
    const inp = doc.findInputs().find(i => i.value === '100')!;
    inp.value = '150'; inp.dispatchEvent('blur');
    const r = ch.find(c => c.key === 'model:BF');
    expect(r).toBeDefined(); expect(r!.old).toBe(100); expect(r!.newVal).toBe(150);
  });
});