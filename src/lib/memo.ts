/**
 * Caches a parser of a config secret per isolate, keyed on the raw text.
 * Keying on the text keeps it right when the value changes between deploys
 * (and in tests, which pass different values per request). Parsing, and any
 * error it logs, happens once per distinct value. The cache is small and
 * cleared when full, since an isolate only ever sees a few values.
 */
export function memoByText<T>(parse: (text: string | undefined) => T): (text: string | undefined) => T {
  const cache = new Map<string | undefined, T>();
  return (text) => {
    if (cache.has(text)) return cache.get(text)!;
    if (cache.size >= 16) cache.clear();
    const value = parse(text);
    cache.set(text, value);
    return value;
  };
}
