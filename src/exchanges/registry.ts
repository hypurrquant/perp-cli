/**
 * Adapter registry for plugin-style exchange discovery.
 * New exchanges register here — commands use registry to resolve names/aliases.
 */

export interface AdapterRegistration {
  name: string;
  aliases: string[];
  chain: string;
}

const registry = new Map<string, AdapterRegistration>();

export function registerAdapter(reg: AdapterRegistration): void {
  registry.set(reg.name, reg);
  for (const alias of reg.aliases) {
    registry.set(alias, reg);
  }
}

export function getAdapterRegistration(nameOrAlias: string): AdapterRegistration | undefined {
  return registry.get(nameOrAlias.toLowerCase());
}

export function listExchanges(): string[] {
  return [...new Set([...registry.values()].map(r => r.name))];
}

export function resolveExchangeName(nameOrAlias: string): string {
  const reg = registry.get(nameOrAlias.toLowerCase());
  return reg?.name ?? nameOrAlias.toLowerCase();
}

// ── Built-in adapter registrations ──

registerAdapter({
  name: "pacifica",
  aliases: ["pac"],
  chain: "solana",
});

registerAdapter({
  name: "hyperliquid",
  aliases: ["hl"],
  chain: "evm",
});

registerAdapter({
  name: "lighter",
  aliases: ["lt"],
  chain: "ethereum",
});
