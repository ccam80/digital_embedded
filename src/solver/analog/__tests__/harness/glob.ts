/**
 * Glob pattern matching for slot names.
 * Supports: * (any chars), ? (single char), case-insensitive, multiple patterns OR'd.
 */

function globToRegex(pattern: string): RegExp {
  let regexStr = "^";
  for (const ch of pattern) {
    if (ch === "*") {
      regexStr += ".*";
    } else if (ch === "?") {
      regexStr += ".";
    } else {
      regexStr += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  regexStr += "$";
  return new RegExp(regexStr, "i");
}

/**
 * Compile a list of glob patterns into a single matcher function.
 * Empty patterns array matches nothing (returns false always).
 */
export function compileSlotMatcher(patterns: string[]): (slotName: string) => boolean {
  if (patterns.length === 0) {
    return () => false;
  }
  const regexes = patterns.map(globToRegex);
  return (slotName: string) => regexes.some((re) => re.test(slotName));
}

/**
 * Test a single slot name against one or more glob patterns.
 * Returns true if any pattern matches (OR semantics).
 */
export function matchSlotPattern(slotName: string, patterns: string[]): boolean {
  return compileSlotMatcher(patterns)(slotName);
}
