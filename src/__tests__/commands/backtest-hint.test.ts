/**
 * `backtest funding-arb` with no recorded funding history tells the user how to collect it. 0.15.0
 * named `perp funding snapshot`, which does not exist; the history is written by
 * `perp arb scan --rates` (saveFundingSnapshot). The hint must name a real command + flags.
 * HOME is isolated by the vitest setup file, so ~/.perp/funding-rates is empty.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { Command, type Option } from "commander";
import { registerBacktestCommands } from "../../commands/backtest.js";

const { buildProgram } = await import("../../cli-program.js");

afterEach(() => { vi.restoreAllMocks(); });

/** Walk `perp a b --flag x` through the real command tree; null = valid. */
function invalidReason(root: Command, invocation: string): string | null {
  const tokens = invocation.replace(/^perp\s+/, "").split(/\s+/);
  let cmd = root;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.startsWith("-")) {
      let opt: Option | undefined;
      for (let c: Command | null = cmd; c !== null && opt === undefined; c = c.parent) opt = c.options.find(o => o.long === t || o.short === t);
      if (opt === undefined) return `unknown flag ${t} on "${cmd.name()}"`;
      if (opt.required || opt.optional) i++;
      continue;
    }
    const sub = cmd.commands.find(c => c.name() === t || c.aliases().includes(t));
    if (sub === undefined) return `unknown command "${t}" under "${cmd.name()}"`;
    cmd = sub;
  }
  return null;
}

describe("backtest no-data hint", () => {
  it("names a command that exists (perp arb scan --rates --symbol <SYM>)", async () => {
    const printed: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { printed.push(a.map(String).join(" ")); });
    const program = new Command();
    program.exitOverride();
    registerBacktestCommands(program, () => true);
    await program.parseAsync(["node", "perp", "backtest", "funding-arb", "--symbol", "btc"]);
    const env = JSON.parse(printed.join("\n")) as { ok: boolean; error: { code: string; message: string } };
    expect(env.error.code).toBe("NO_DATA");
    const hint = /Run '([^']+)'/.exec(env.error.message)?.[1];
    expect(hint).toBe("perp arb scan --rates --symbol BTC");
    const { program: root } = buildProgram({ defaultExchange: "pacifica", version: "0.0.0-test" });
    expect(invalidReason(root, hint as string)).toBeNull();
    expect(invalidReason(root, "perp funding snapshot")).not.toBeNull(); // the 0.15.0 hint
  });
});
