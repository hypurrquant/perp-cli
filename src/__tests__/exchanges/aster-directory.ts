/**
 * Test helper: an Aster adapter whose market directory (exchangeInfo) is already loaded, so a test
 * about another request sees only that request. Every …USDT venue symbol is "listed" (plus any
 * `extra` venue symbols); price filters are the explicit `filters` or absent (null).
 */
export function seedAsterDirectory(adapter: object, extra: readonly string[] = [], filters: Record<string, unknown> = {}): void {
  const listed = new Set(extra);
  class Directory extends Map<string, unknown> {
    override has(k: string): boolean {
      if (super.has(k) || listed.has(k)) return true;
      // "<base>USDT" is listed for a plain base — not for "<listed venue symbol>USDT" / "…USDTUSDT".
      const base = k.endsWith("USDT") ? k.slice(0, -4) : null;
      return base !== null && base !== "" && !listed.has(base) && !base.endsWith("USDT");
    }
    override get(k: string): unknown { return super.has(k) ? super.get(k) : null; }
  }
  const t = adapter as Record<string, unknown>;
  t._priceFilters = new Directory(Object.entries(filters));
  t._priceFiltersLoadedAt = Date.now();
}
