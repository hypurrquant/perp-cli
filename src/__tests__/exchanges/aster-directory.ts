/**
 * Test helper: an Aster adapter whose market directory (exchangeInfo) is already loaded, so a test
 * about another request sees only that request. Every …USDT venue symbol is "listed" (plus any
 * `extra` venue symbols); price filters are the explicit `filters` or absent (null).
 */
export function seedAsterDirectory(adapter: object, extra: readonly string[] = [], filters: Record<string, unknown> = {}): void {
  const listed = new Set(extra);
  class Directory extends Map<string, unknown> {
    override has(k: string): boolean { return super.has(k) || k.endsWith("USDT") || listed.has(k); }
    override get(k: string): unknown { return super.has(k) ? super.get(k) : null; }
  }
  const t = adapter as Record<string, unknown>;
  t._priceFilters = new Directory(Object.entries(filters));
  t._priceFiltersLoadedAt = Date.now();
}
