/**
 * Pacifica-specific order types exposed through `perp -e pacifica trade …`.
 *
 * Of Pacifica's strategy order types (docs trading-on-pacifica/order-types/strategies) only Atomic
 * has an API path: it is a batch of ordinary market orders (POST /orders/batch). Chase, OCO,
 * Trailing Stop, Swarm, Trigger Swarm and Conditional Market / Limit have no REST endpoint, no
 * signing operation type (api/signing/operation-types) and no order-type code — they run in the
 * Pacifica web app only, so perp-cli does not offer them.
 */

import type { Command } from "commander";
import chalk from "chalk";
import { supportsDryRun } from "../cli-flags.js";
import { PerpError, extractErrorMessage, parsePositiveDecimal } from "../errors.js";
import type { ExchangeAdapter } from "../exchanges/interface.js";
import type { PacificaAdapter } from "../exchanges/pacifica.js";
import {
  atomicDryRunPlan, atomicIncompleteError, atomicLegClientOrderId, atomicLegPayload, atomicMarketsOf,
  executeAtomic, parseAtomicLegs, requireAtomicReduceOnly, sizeAtomicLegs, type AtomicLegOutcome,
} from "../exchanges/pacifica-atomic.js";
import { resolveSlippage } from "../exchanges/slippage.js";
import { reduceOnlyGateOf, unsupported } from "../exchanges/trading-v2.js";
import { getVenue } from "../exchanges/venue.js";
import { quarantineEntryFor, quarantineSymbol } from "../bot/quarantine.js";
import { enforceOrderRisk } from "../trade-validator.js";
import { logExecution } from "../execution-log.js";
import { invalidateCache } from "../cache.js";
import { printJson, jsonOk } from "../utils.js";

interface AtomicOpts { usd: string; long?: string[]; short?: string[]; reduceOnly?: boolean; slippageBps?: string; force?: boolean }

export function registerPacificaOrderCommands(
  trade: Command,
  getAdapter: () => Promise<ExchangeAdapter>,
  isJson: () => boolean,
  isDryRun: () => boolean,
): void {
  supportsDryRun(trade.command("atomic"))
    .description("Pacifica only: weighted basket of market orders across markets, sent in ONE batch request. Each leg fills or fails on its own (not all-or-nothing)")
    .requiredOption("--usd <total>", "Total basket notional in USD, split across the legs by weight at each mark price")
    .option("--long <legs...>", "Buy legs: SYMBOL[:WEIGHT] (up to 5; no weight = 1)")
    .option("--short <legs...>", "Sell legs: SYMBOL[:WEIGHT] (up to 5; no weight = 1)")
    .option("--reduce-only", "Every leg reduce-only: --long legs must close shorts, --short legs must close longs")
    .option("--slippage-bps <n>", "Per-leg slippage bound in bps (default: settings slippageBps.pacifica → defaultSlippageBps)")
    .option("--force", "Bypass local risk-limit checks (maxPosition / total exposure) for every leg")
    .action(async (opts: AtomicOpts) => {
      const adapter = await getAdapter();
      if (adapter.name !== "pacifica") {
        const def = getVenue(adapter.name);
        throw unsupported(def.displayName, "atomicOrder", "Atomic is a Pacifica basket order (POST /orders/batch of market orders)",
          "Run it on Pacifica (perp -e pacifica trade atomic …), or use perp trade multi for a cross-venue multi-leg order");
      }
      const pac = adapter as PacificaAdapter;
      const specs = parseAtomicLegs(opts.long ?? [], opts.short ?? []);
      const usd = parsePositiveDecimal(opts.usd, "--usd");
      let flagBps: number | null = null;
      if (opts.slippageBps !== undefined) {
        flagBps = Number(opts.slippageBps);
        if (!Number.isFinite(flagBps) || flagBps <= 0) throw new PerpError("INVALID_PARAMS", `--slippage-bps must be a positive number (got "${opts.slippageBps}")`);
      }
      const slippage = resolveSlippage("pacifica", flagBps);
      const reduceOnly = opts.reduceOnly === true;

      const [info, prices] = await Promise.all([pac.sdk.getInfo(), pac.sdk.getPrices()]);
      const legs = sizeAtomicLegs(specs, usd, atomicMarketsOf(specs, info, prices));

      // Pre-send gates (read only), before the dry-run return so a dry run reports the same refusal.
      if (reduceOnly) {
        const gate = reduceOnlyGateOf(adapter);
        if (gate !== null) throw gate;
        invalidateCache("acct");
        requireAtomicReduceOnly(legs, await adapter.getPositions());
      } else {
        for (const l of legs) {
          const q = quarantineEntryFor(l.symbol, (m) => { if (!isJson()) console.error(m); });
          if (q !== null) {
            throw new PerpError("RISK_VIOLATION", `${l.symbol} is quarantined by ${q.strategy}: ${q.reason}`, {
              exchange: "pacifica",
              remediation: `${q.remediation} — only reduce-only orders are accepted until a human clears it (perp strategy quarantine-clear ${l.symbol})`,
            });
          }
          await enforceOrderRisk(adapter, { symbol: l.symbol, size: Number(l.size), price: Number(l.mark), force: opts.force });
        }
      }

      const builder = await pac.builderDecision();
      const builderCode = builder.applied === null ? null : builder.applied.identity;
      const payloads = legs.map(l => atomicLegPayload(l, { reduceOnly, slippageBps: slippage.bps, clientOrderId: atomicLegClientOrderId(), builderCode }));
      const legView = legs.map((l, i) => ({
        symbol: l.symbol, side: l.side, weight: l.weight, share: Number(l.share.toFixed(6)), mark: l.mark, lotSize: l.lotSize,
        size: l.size, notionalUsd: Number(l.notionalUsd.toFixed(2)), clientOrderId: payloads[i].client_order_id as string,
      }));
      const summary = { exchange: "pacifica", totalUsd: usd, reduceOnly, slippageBps: slippage.bps, legs: legView, builderFee: builder.applied, ...(builder.note !== null ? { builderNote: builder.note } : {}) };

      if (isDryRun()) {
        const tier = pac.activeSignerTier;
        const plan = atomicDryRunPlan(payloads, {
          account: pac.isReadOnly ? "<no signer configured: a live run needs a Pacifica key>" : pac.publicKey,
          agentWallet: tier === "agent" ? "<agent wallet public key>" : null,
          timestamp: Date.now(),
        });
        for (const l of legs) {
          logExecution({ type: "multi_leg", exchange: "pacifica", symbol: l.symbol, side: l.side, size: l.size, status: "simulated", dryRun: true, meta: { atomic: true, reduceOnly } });
        }
        if (isJson()) return printJson(jsonOk({ dryRun: true, sent: false, action: "atomic_order", ...summary, request: plan }));
        console.log(chalk.yellow("\n  [DRY RUN] Would send a Pacifica Atomic basket (nothing signed or sent):"));
        for (const l of legView) console.log(chalk.gray(`    ${l.side.toUpperCase().padEnd(4)} ${l.size} ${l.symbol} ≈ $${l.notionalUsd} (weight ${l.weight}, mark ${l.mark})`));
        console.log(chalk.gray(`    reduce-only: ${reduceOnly} · slippage: ${slippage.bps} bps per leg · builder: ${builder.applied === null ? "none" : builder.applied.identity}`));
        console.log(chalk.gray(`    ${plan.endpoint}\n${JSON.stringify(plan.body, null, 2).split("\n").map(s => `    ${s}`).join("\n")}`));
        console.log(chalk.gray(`    signed messages (create_market_order, one per leg):\n${plan.signedMessages.map(s => `    ${s}`).join("\n")}\n`));
        return;
      }

      let outcomes: AtomicLegOutcome[];
      let venueRaw: unknown;
      try {
        ({ outcomes, venueRaw } = await executeAtomic(pac, legs, payloads));
      } catch (e) {
        for (const l of legs) {
          logExecution({ type: "multi_leg", exchange: "pacifica", symbol: l.symbol, side: l.side, size: l.size, status: e instanceof PerpError && e.structured.code === "ORDER_PENDING" ? "unverified" : "failed", dryRun: false, error: extractErrorMessage(e), meta: { atomic: true, reduceOnly } });
          if (!reduceOnly && e instanceof PerpError && e.structured.code === "ORDER_PENDING") quarantineAtomicLeg(l.symbol, extractErrorMessage(e), isJson);
        }
        throw e;
      }
      for (const o of outcomes) {
        logExecution({
          type: "multi_leg", exchange: "pacifica", symbol: o.symbol, side: o.side, size: o.size,
          status: o.status === "unknown" ? "unverified" : o.status === "filled" || o.status === "partiallyFilled" ? "success" : "failed",
          dryRun: false, ...(o.detail !== null && o.status !== "filled" ? { error: o.detail } : {}),
          meta: { atomic: true, reduceOnly, orderId: o.orderId, clientOrderId: o.clientOrderId, filledSize: o.filledSize },
        });
        if (o.status === "unknown" && !reduceOnly) quarantineAtomicLeg(o.symbol, o.detail ?? "outcome unknown", isJson);
      }
      const incomplete = atomicIncompleteError(outcomes);
      if (incomplete !== null) throw incomplete;
      if (isJson()) return printJson(jsonOk({ ...summary, outcomes, venueRaw }));
      console.log(chalk.green(`\n  Atomic basket filled on Pacifica ($${usd}):`));
      for (const o of outcomes) console.log(`  ${chalk.green("FILLED")}  ${o.side.toUpperCase().padEnd(4)} ${o.filledSize ?? o.size} ${o.symbol}  order ${o.orderId ?? "-"}`);
      console.log();
    });
}

function quarantineAtomicLeg(symbol: string, reason: string, isJson: () => boolean): void {
  quarantineSymbol("trade-atomic", symbol, `atomic leg on ${symbol}: outcome unknown (${reason})`,
    `Check the position and fills: perp -e pacifica account positions / trade fills ${symbol}`,
    (m) => { if (!isJson()) console.error(m); });
}
