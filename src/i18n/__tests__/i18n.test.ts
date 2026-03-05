import { describe, it, expect, beforeEach } from 'vitest';
import { i18n, setLocale, getLocale, resetI18n } from '../index';

describe('i18n', () => {
  beforeEach(() => {
    resetI18n();
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

    it('setLocaleUpdatesCurrentLocale', async () => {
      // 'en' locale file exists, so setLocale should succeed
      await setLocale('en');
      expect(getLocale()).toBe('en');
    });

    it('setLocaleWithMissingLocaleKeepsCurrent', async () => {
      // 'xx' locale file does not exist, so setLocale keeps current locale
      await setLocale('xx');
      expect(getLocale()).toBe('en');
    });
  });
});
