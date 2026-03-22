/**
 * Strategy registry for bot engine.
 * Strategies register here — engine uses registry to resolve by name.
 */

import type { Strategy } from "./strategy-types.js";

export type StrategyFactory = (config: Record<string, unknown>) => Strategy;

const registry = new Map<string, StrategyFactory>();

export function registerStrategy(name: string, factory: StrategyFactory): void {
  registry.set(name.toLowerCase(), factory);
}

export function getStrategy(name: string): StrategyFactory | undefined {
  return registry.get(name.toLowerCase());
}

export function listStrategies(): string[] {
  return [...registry.keys()];
}
