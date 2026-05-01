import { describe, it, expect } from 'vitest';
import { parseUrlParams, applyModuleConfig } from '../url-params.js';
import type { SimulatorParams, ModuleConfig } from '../url-params.js';

describe('parseUrlParams', () => {
  it('parseBase- ?base=checkpoint-1/ → { base: "checkpoint-1/" }', () => {
    const params = parseUrlParams('?base=checkpoint-1/');
    expect(params.base).toBe('checkpoint-1/');
  });

  it('parseFile- ?file=cpu.dig → { file: "cpu.dig" }', () => {
    const params = parseUrlParams('?file=cpu.dig');
    expect(params.file).toBe('cpu.dig');
  });

  it('parseDark- ?dark=0 → { dark: false }', () => {
    const params = parseUrlParams('?dark=0');
    expect(params.dark).toBe(false);
  });

  it('parseLocked- ?locked=1 → { locked: true }', () => {
    const params = parseUrlParams('?locked=1');
    expect(params.locked).toBe(true);
  });

  it('defaults- no params → { base: "./", dark: true, locked: false, panels: "default" }', () => {
    const params = parseUrlParams('');
    expect(params.base).toBe('./');
    expect(params.dark).toBe(true);
    expect(params.locked).toBe(false);
    expect(params.panels).toBe('default');
    expect(params.file).toBeUndefined();
  });

  it('panelsNone- ?panels=none → { panels: "none" }', () => {
    const params = parseUrlParams('?panels=none');
    expect(params.panels).toBe('none');
  });

  it('dark=1 → { dark: true }', () => {
    const params = parseUrlParams('?dark=1');
    expect(params.dark).toBe(true);
  });

  it('locked=0 → { locked: false }', () => {
    const params = parseUrlParams('?locked=0');
    expect(params.locked).toBe(false);
  });

  it('accepts URLSearchParams directly', () => {
    const usp = new URLSearchParams('base=mydir/&file=test.dig&dark=0&locked=1&panels=none');
    const params = parseUrlParams(usp);
    expect(params.base).toBe('mydir/');
    expect(params.file).toBe('test.dig');
    expect(params.dark).toBe(false);
    expect(params.locked).toBe(true);
    expect(params.panels).toBe('none');
  });

  it('accepts query string without leading ?', () => {
    const params = parseUrlParams('base=other/');
    expect(params.base).toBe('other/');
  });

  it('empty file param treated as undefined', () => {
    const params = parseUrlParams('?file=');
    expect(params.file).toBeUndefined();
  });

  it('panels=other falls back to default', () => {
    const params = parseUrlParams('?panels=all');
    expect(params.panels).toBe('default');
  });

  it('module param- ?module=ece101 → { module: "ece101" }', () => {
    const params = parseUrlParams('?module=ece101');
    expect(params.module).toBe('ece101');
  });

  it('empty module param treated as undefined', () => {
    const params = parseUrlParams('?module=');
    expect(params.module).toBeUndefined();
  });

  it('defaults- module is undefined', () => {
    const params = parseUrlParams('');
    expect(params.module).toBeUndefined();
  });
});

describe('applyModuleConfig', () => {
  function defaultParams(overrides?: Partial<SimulatorParams>): SimulatorParams {
    return {
      base: './',
      file: undefined,
      dark: true,
      locked: false,
      panels: 'default',
      palette: undefined,
      module: undefined,
      ...overrides,
    };
  }

  it('applies palette from module config when URL has none', () => {
    const params = defaultParams();
    const config: ModuleConfig = { title: 'Test', palette: ['And', 'Or'] };
    applyModuleConfig(params, config, 'modules/test/');
    expect(params.palette).toEqual(['And', 'Or']);
  });

  it('URL palette overrides module palette', () => {
    const params = defaultParams({ palette: ['Not'] });
    const config: ModuleConfig = { title: 'Test', palette: ['And', 'Or'] };
    applyModuleConfig(params, config, 'modules/test/');
    expect(params.palette).toEqual(['Not']);
  });

  it('applies file and sets base to module directory', () => {
    const params = defaultParams();
    const config: ModuleConfig = { title: 'Test', file: 'intro.dig' };
    applyModuleConfig(params, config, 'modules/test/');
    expect(params.file).toBe('intro.dig');
    expect(params.base).toBe('modules/test/');
  });

  it('URL file overrides module file', () => {
    const params = defaultParams({ file: 'custom.dig' });
    const config: ModuleConfig = { title: 'Test', file: 'intro.dig' };
    applyModuleConfig(params, config, 'modules/test/');
    expect(params.file).toBe('custom.dig');
    expect(params.base).toBe('./');
  });

  it('applies locked from module config', () => {
    const params = defaultParams();
    const config: ModuleConfig = { title: 'Test', locked: true };
    applyModuleConfig(params, config, 'modules/test/');
    expect(params.locked).toBe(true);
  });

  it('applies panels from module config', () => {
    const params = defaultParams();
    const config: ModuleConfig = { title: 'Test', panels: 'none' };
    applyModuleConfig(params, config, 'modules/test/');
    expect(params.panels).toBe('none');
  });
});
