import { describe, it, expect, beforeEach } from 'vitest';
import { i18n, setLocale, getLocale } from '../index';

describe('i18n', () => {
  beforeEach(() => {
    // Reset locale to default before each test
    setLocale('en');
  });

  describe('passThrough', () => {
    it('returnsKey', () => {
      const result = i18n('menu.file.open');
      expect(result).toBe('menu.file.open');
    });

    it('ignoresParams', () => {
      const result = i18n('errors.notFound', { name: 'foo' });
      expect(result).toBe('errors.notFound');
    });
  });

  describe('locale', () => {
    it('defaultEn', () => {
      const locale = getLocale();
      expect(locale).toBe('en');
    });

    it('setNoOp', () => {
      setLocale('de');
      expect(getLocale()).toBe('de');
    });
  });
});
