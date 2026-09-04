import type { Side } from "./order.js";

export interface Position {
  symbol: string;
  side: Side;
  amount: string;
  entry_price: string;
  mark_price: string;
  liquidation_price: string;
  unrealized_pnl: string;
  /** Backing margin. The live spec names this `margin`; older payloads used
   *  `margin_used`. Both are read defensively. */
  margin?: string;
  margin_used: string;
  /** Optional — the live /positions spec omits leverage; treat as possibly absent. */
  leverage?: number;
  /** True when the position is isolated-margin. Gates `margin`, which the spec
   *  documents as "only shown when isolated" — so leverage cannot be derived
   *  from margin on a cross position. */
  isolated?: boolean;
  created_at: number;
}
