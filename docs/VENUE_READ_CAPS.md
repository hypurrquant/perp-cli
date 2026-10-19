# Venue read caps (measured)

Server-side row caps of the public read paths, **measured live** (BTC unless noted), and how
perp-cli handles each. A documented maximum is not trusted on its own: several venues stop
earlier, without an error or a pagination field. Rule for every adapter: a page that comes back
**full (= the cap) always triggers another page**; it is never taken as the end of the data. Where a
venue cannot page, a `--limit` above the cap is refused with `INVALID_PARAMS` naming the cap — never
clamped silently.

Measured 2026-10-19 unless noted. HL / Pacifica / Lighter kline and trade caps are owned by the
venue-specific fix branches and are not listed here.

| Venue | Path | Real cap | Documented | perp-cli |
|---|---|---|---|---|
| Ondo | `GET /v1/perps/candles` | n/a — buckets from the requested `from`, adds a zero-volume bucket after `to` | — | `from` floored to the interval; candles after `--end` dropped |
| Lighter / Lighter RH | `GET /api/v1/fundings` | 750 per call (docs); `count_back` not honoured as documented | 750 | window = `-l` hours, newest `-l` rows; `-l` 1..750 |
| Hyperliquid | `fundingHistory` | 500 per answer (docs) | 500 | window = `-l` hours (was fixed 24 h) |
| RISEx | `/trading-view-data` | intervals other than 1m 5m 15m 1h 4h 1d 1w answer **1m bars** | — | table = verified set; rows of another interval → `EXCHANGE_ERROR` |
| RISEx | `/funding-rate-history` | `start_time` defaults to now − 7 d (168 rows); 1000 / page, `page` + `has_next_page` | 1000 | `start_time` = now − `-l` h, pages followed |
| RISEx | `/trade-history` | 1000 ("page_size cannot exceed 1000") | 1000 | `--limit` > 1000 → `INVALID_PARAMS` |
| RISEx | `/v1/orderbook` | 250 levels (docs) | 250 | `--depth` sent (was always 50), > 250 → `INVALID_PARAMS` |
| TxFlow | `candleSnapshot` | window > ~3000 bars → `200 []` (3000 OK, 3050 empty; 1m / 5m / 1h / 1d) | — | windows of ≤ 2900 bars, merged (max 50 requests) |
| TxFlow | `candleSnapshot` intervals | 3d / 1w / 1M always `[]` (HTTP 500 HTML on some) | — | refused (`INVALID_PARAMS`) |
| Extended | `/info/candles/<m>/trades` | **2800** rows on every interval with that much history (PT1M, PT5M, PT15M, PT30M, PT1H, PT2H, PT4H: 2800; PT8H 2445, PT12H 1631, PT24H 816, P7D 118, P30D 28 = all history since 2024-07); no pagination field | 10,000 | pages backwards by `endTime`, stops only on an empty page or at `--start` (a short page is not trusted as the end); 40 d of 1m = 57,601 bars, 0 gaps, 21 pages |
| Extended | `/info/<m>/funding` | **1000** rows (newest) | 10,000 | pages backwards by `endTime` |
| Extended | `/info/markets/<m>/trades` | 50, no `limit` parameter | — | `--limit` > 50 → `INVALID_PARAMS` |
| GRVT | `/full/v1/kline` | `next` cursor runs dry after ~1000 bars (page 2: 2 rows, `next` "") | 1000 / page | pages backwards by `end_time`; 40 d of 1m = 57,583 bars in 58 pages (17 one-minute gaps: minutes GRVT publishes no bar for). Up-front limit 60 nominal pages (60,000 bars ≈ 41.6 d of 1m); read budget 75 pages (real pages are short); running out before `--start` → `EXCHANGE_ERROR` naming the time reached |
| GRVT | `/full/v1/trade` | 1000, no cursor (limit 1500 → 1000) | 1000 | `--limit` > 1000 → `INVALID_PARAMS` |
| GRVT | `/full/v1/funding` | ≥ 10,000 in one answer (limit 10,000 → 10,000) | 1000 | limit sent as asked (was clamped to 1000), 1..10,000 |
| Arcus | `/v1/trades`, `/v1/fundingRates` | 1000 (docs) | 1000 | `--limit` > 1000 → `INVALID_PARAMS` (was silently 1000) |
| Aster | `/fapi/v3/fundingRate` | 1000; more → HTTP 200 `{"status":"ERROR","type":"VALID"}` | 1000 | that body → `INVALID_PARAMS` |
| Aster | `/fapi/v3/klines` intervals | 1m 3m 5m 15m 30m 1h 2h 4h 6h 8h 12h 1d 3d 1w 1M (others: -1120) | same | refused before any request |

Order book `--depth` max (levels per side, measured): hyperliquid 20, pacifica 10, lighter / lighter-rh /
aster / arcus / ondo 50, qfex / txflow 20, risex 250, grvt 500, extended full book. Above it →
`INVALID_PARAMS` naming the max (`BOOK_DEPTH_MAX`, src/commands/market.ts).

History order (every venue, enforced in `perp market` after the adapter call): `trades` and
`funding` newest first, `kline` oldest first.
