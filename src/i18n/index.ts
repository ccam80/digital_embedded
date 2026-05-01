/**
 * Internationalization (i18n) module.
 *
 * Provides locale-aware string lookup with parameter interpolation,
 * fallback chains, and locale change events.
 *
 * Locale JSON files are loaded via Vite dynamic import()- one code path
 * for both browser and test environments.
 */

type LocaleData = Record<string, string>;
type LocaleChangeCallback = (locale: string) => void;

let currentLocale = 'en';
let localeData: LocaleData = {};
let localeChangeCallbacks: LocaleChangeCallback[] = [];
const localeCache: Map<string, LocaleData> = new Map();

async function loadLocale(locale: string): Promise<LocaleData> {
  if (localeCache.has(locale)) {
    return localeCache.get(locale)!;
  }
  const module = await import(`./locales/${locale}.json`);
  const data: LocaleData = module.default as LocaleData;
  localeCache.set(locale, data);
  return data;
}

/**
 * Initialize the i18n system.
 * Loads the initial locale data.
 * Must be called before using i18n().
 *
 * @param initialLocale - The initial locale to load (default: 'en')
 * @returns Promise that resolves when the initial locale is loaded
 */
export async function initializeI18n(initialLocale: string = 'en'): Promise<void> {
  try {
    localeData = await loadLocale(initialLocale);
    currentLocale = initialLocale;
  } catch (error) {
    console.warn(`Failed to load locale ${initialLocale}, using empty locale data`);
    localeData = {};
    currentLocale = initialLocale;
  }
}

/**
 * Get a string from the current locale.
 * Looks up the key in the active locale, falls back to English, then returns the key itself.
 *
 * Supports parameter interpolation: {param} is replaced with the value from params.
 * Example: i18n('errors.notFound', { name: 'foo' }) → "Component 'foo' not found"
 *
 * @param key - The localization key (dot-separated, e.g., 'menu.file.open')
 * @param params - Optional parameters for interpolation
 * @returns The localized string, or the key if not found in any locale
 */
export function i18n(key: string, params?: Record<string, string | number>): string {
  let value: string | undefined;

  value = getNestedValue(localeData, key);

  if (!value && currentLocale !== 'en') {
    const enData = localeCache.get('en');
    if (enData) {
      value = getNestedValue(enData, key);
    }
  }

  if (!value) {
    value = key;
  }

  if (params) {
    Object.entries(params).forEach(([paramKey, paramValue]) => {
      const placeholder = new RegExp(`\\{${paramKey}\\}`, 'g');
      value = value!.replace(placeholder, String(paramValue));
    });
  }

  return value;
}

/**
 * Get a nested value from an object using dot notation.
 * Example: getNestedValue(obj, 'menu.file.open') returns obj.menu.file.open
 *
 * @param obj - The object to search
 * @param path - Dot-separated path (e.g., 'menu.file.open')
 * @returns The value, or undefined if not found
 */
function getNestedValue(obj: LocaleData, path: string): string | undefined {
  const parts = path.split('.');
  let current: unknown = obj;

  for (const part of parts) {
    if (current !== null && typeof current === 'object' && part in (current as object)) {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }

  return typeof current === 'string' ? current : undefined;
}

/**
 * Set the current locale and reload strings.
 * Triggers locale change callbacks after the locale is switched.
 *
 * @param locale - The locale code (e.g., 'en', 'de', 'zh')
 * @returns Promise that resolves when the locale is loaded and callbacks are triggered
 */
export async function setLocale(locale: string): Promise<void> {
  try {
    const newData = await loadLocale(locale);
    localeData = newData;
    currentLocale = locale;
    triggerLocaleChangeCallbacks(locale);
  } catch (error) {
    console.error(`Failed to set locale to ${locale}:`, error);
  }
}

/**
 * Get the current locale.
 *
 * @returns The current locale code
 */
export function getLocale(): string {
  return currentLocale;
}

/**
 * Register a callback to be called when the locale changes.
 * The callback receives the new locale code as an argument.
 *
 * @param callback - Function to call when locale changes
 * @returns Function to unregister the callback
 */
export function onLocaleChange(callback: LocaleChangeCallback): () => void {
  localeChangeCallbacks.push(callback);
  return () => {
    localeChangeCallbacks = localeChangeCallbacks.filter((cb) => cb !== callback);
  };
}

/**
 * Trigger all registered locale change callbacks.
 *
 * @param locale - The new locale
 */
function triggerLocaleChangeCallbacks(locale: string): void {
  localeChangeCallbacks.forEach((callback) => {
    try {
      callback(locale);
    } catch (error) {
      console.error('Error in locale change callback:', error);
    }
  });
}

/**
 * Clear the locale cache and reset to default state.
 * Useful for testing.
 */
export function resetI18n(): void {
  localeCache.clear();
  localeData = {};
  currentLocale = 'en';
  localeChangeCallbacks = [];
}
