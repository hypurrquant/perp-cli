import type { Strategy, StrategyContext, StrategyAction, EnrichedSnapshot } from "../strategy-types.js";
import { registerStrategy } from "../strategy-registry.js";

/**
 * Claude Agent strategy — LLM-driven trading decisions.
 * Sends a market snapshot to an LLM API (Anthropic-compatible) every N ticks.
 * Parses the response into StrategyActions.
 */

interface ClaudeAgentConfig {
  apiKey: string;
  model: string;
  maxPositionSize: number;
  promptTemplate: string;
  tickInterval: number; // call LLM every N ticks
  apiBase: string;      // override for other providers
}

const DEFAULT_PROMPT = `You are a trading assistant. Given the following market snapshot, decide whether to BUY, SELL, or HOLD.
Respond with ONLY one of: BUY <size>, SELL <size>, or HOLD.
Examples: "BUY 0.1", "SELL 0.05", "HOLD"`;

export class ClaudeAgentStrategy implements Strategy {
  readonly name = "claude-agent";

  private _config: Record<string, unknown> = {};

  private get params(): ClaudeAgentConfig {
    return {
      apiKey: String(this._config.apiKey ?? ""),
      model: String(this._config.model ?? "claude-3-5-haiku-latest"),
      maxPositionSize: Number(this._config.maxPositionSize ?? 0.1),
      promptTemplate: String(this._config.promptTemplate ?? DEFAULT_PROMPT),
      tickInterval: Number(this._config.tickInterval ?? 10),
      apiBase: String(this._config.apiBase ?? "https://api.anthropic.com"),
    };
  }

  describe() {
    return {
      description: "Sends market snapshots to an LLM API for trading decisions; parses BUY/SELL/HOLD responses",
      params: [
        { name: "apiKey", type: "string" as const, required: true, description: "LLM API key (Anthropic or compatible)" },
        { name: "model", type: "string" as const, required: false, default: "claude-3-5-haiku-latest", description: "Model name to use" },
        { name: "maxPositionSize", type: "number" as const, required: false, default: 0.1, description: "Maximum order size per LLM decision" },
        { name: "promptTemplate", type: "string" as const, required: false, default: DEFAULT_PROMPT, description: "System prompt sent to LLM" },
        { name: "tickInterval", type: "number" as const, required: false, default: 10, description: "Ticks between LLM calls" },
        { name: "apiBase", type: "string" as const, required: false, default: "https://api.anthropic.com", description: "API base URL" },
      ],
    };
  }

  async init(ctx: StrategyContext, _snapshot: EnrichedSnapshot): Promise<void> {
    this._config = ctx.config;
    const { apiKey, model, maxPositionSize, tickInterval } = this.params;

    if (!apiKey) {
      ctx.log("  [CLAUDE-AGENT] No apiKey configured — running in noop mode");
    } else {
      ctx.log(
        `  [CLAUDE-AGENT] model=${model} maxSize=${maxPositionSize} ` +
        `interval=${tickInterval}ticks`,
      );
    }

    ctx.state.set("lastDecision", "HOLD");
    ctx.state.set("lastCallTick", -1);
  }

  async onTick(ctx: StrategyContext, snapshot: EnrichedSnapshot): Promise<StrategyAction[]> {
    const { apiKey, model, maxPositionSize, promptTemplate, tickInterval, apiBase } = this.params;

    if (!apiKey) {
      ctx.log("  [CLAUDE-AGENT] No apiKey — skipping LLM call (noop)");
      return [{ type: "noop" }];
    }

    const lastCallTick = ctx.state.get("lastCallTick") as number;
    if (ctx.tick - lastCallTick < tickInterval) {
      return [{ type: "noop" }];
    }

    ctx.state.set("lastCallTick", ctx.tick);

    const userMessage = buildMarketMessage(snapshot, ctx.symbol);

    let rawDecision: string;
    try {
      rawDecision = await callLlm(apiBase, apiKey, model, promptTemplate, userMessage);
      ctx.state.set("lastDecision", rawDecision);
      ctx.log(`  [CLAUDE-AGENT] LLM response: "${rawDecision}"`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.log(`  [CLAUDE-AGENT] LLM call failed: ${msg}`);
      return [{ type: "noop" }];
    }

    return parseDecision(rawDecision, maxPositionSize, snapshot.price);
  }

  async onStop(_ctx: StrategyContext): Promise<StrategyAction[]> {
    return [{ type: "cancel_all" }];
  }
}

// ── Helpers ──

function buildMarketMessage(snapshot: EnrichedSnapshot, symbol: string): string {
  const lines = [
    `Symbol: ${symbol}`,
    `Price: ${snapshot.price.toFixed(4)}`,
    `Funding Rate: ${(snapshot.fundingRate * 100).toFixed(4)}%`,
    `24h Volatility: ${snapshot.volatility24h.toFixed(2)}%`,
    `24h Volume: ${snapshot.volume24h.toFixed(2)}`,
    `Open Interest: ${snapshot.openInterest}`,
  ];

  const bestBid = snapshot.orderbook.bids[0];
  const bestAsk = snapshot.orderbook.asks[0];
  if (bestBid) lines.push(`Best Bid: ${bestBid[0]} (${bestBid[1]})`);
  if (bestAsk) lines.push(`Best Ask: ${bestAsk[0]} (${bestAsk[1]})`);

  return lines.join("\n");
}

async function callLlm(
  apiBase: string,
  apiKey: string,
  model: string,
  systemPrompt: string,
  userMessage: string,
): Promise<string> {
  const url = `${apiBase.replace(/\/$/, "")}/v1/messages`;

  const body = JSON.stringify({
    model,
    max_tokens: 64,
    system: systemPrompt,
    messages: [{ role: "user", content: userMessage }],
  });

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`LLM API error ${response.status}: ${text}`);
  }

  const data = (await response.json()) as {
    content?: Array<{ type: string; text?: string }>;
  };

  const textBlock = data.content?.find((c) => c.type === "text");
  return textBlock?.text?.trim() ?? "HOLD";
}

function parseDecision(
  raw: string,
  maxPositionSize: number,
  price: number,
): StrategyAction[] {
  const upper = raw.trim().toUpperCase();

  if (upper === "HOLD" || upper.startsWith("HOLD")) {
    return [{ type: "noop" }];
  }

  // Match "BUY <size>" or "SELL <size>"
  const buyMatch = upper.match(/^BUY\s+([\d.]+)/);
  if (buyMatch) {
    const size = Math.min(parseFloat(buyMatch[1]), maxPositionSize);
    if (size > 0) {
      return [
        {
          type: "place_order",
          side: "buy",
          price: price.toFixed(6),
          size: size.toFixed(6),
          orderType: "market",
        },
      ];
    }
  }

  const sellMatch = upper.match(/^SELL\s+([\d.]+)/);
  if (sellMatch) {
    const size = Math.min(parseFloat(sellMatch[1]), maxPositionSize);
    if (size > 0) {
      return [
        {
          type: "place_order",
          side: "sell",
          price: price.toFixed(6),
          size: size.toFixed(6),
          orderType: "market",
        },
      ];
    }
  }

  // Unrecognised response — treat as noop
  return [{ type: "noop" }];
}

registerStrategy("claude-agent", (_config) => new ClaudeAgentStrategy());
