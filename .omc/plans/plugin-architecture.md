# Plan: Refactor ExchangeAdapter to Plugin Architecture

**Date:** 2026-03-19
**Status:** APPROVED (v3)
**Complexity:** HIGH
**Scope:** 15+ files, 4 new files, 33 instanceof replacements + 12 `as TypeAdapter` cast migrations

---

## RALPLAN-DR Summary

### Principles
1. **Zero Regression** -- 941 tests must pass, live trading must work after every step
2. **Additive First** -- New code is added alongside old; old code is removed only after the new path is validated
3. **Minimal API Surface Change** -- External consumers (CLI commands, MCP server) should need minimal changes
4. **Type Safety as Guard Rail** -- TypeScript compiler errors must guide the migration; no `any` escape hatches
5. **One Adapter = One File** -- Adding a new DEX requires exactly: 1 adapter file + 1 registry line + tests + docs

### Decision Drivers (Top 3)
1. **Backward Compatibility** -- 33 instanceof checks across 6 command files (trade.ts, funds.ts, manage.ts, market.ts, account.ts, rebalance.ts) + 12 `as TypeAdapter` casts across index.ts, market.ts, account.ts, manage.ts. Breaking these breaks the CLI.
2. **withdraw() Signature Divergence** -- HL: `withdraw(amount: string, destination: string)`, Lighter: `withdraw(amount: number, assetId, routeType)`, Pacifica: via `adapter.sdk.withdraw(...)`. Unifying requires a common envelope.
3. **Adapter-Specific Methods** -- TWAP, TP/SL, triggerOrder, queryOrder, usdTransfer, subaccounts, vaults, delegations are exchange-specific. These cannot be on the base interface but must be discoverable.

### Tradeoff Acknowledgment

New exchanges will ALWAYS need command file changes for non-trivial features. The capability pattern reduces **import-level coupling** (no more `import { HyperliquidAdapter }` in commands), not semantic coupling. Commands will still need exchange-aware branches for features that are fundamentally exchange-specific. The goal is: base functionality (positions, orders, balance) works with zero command changes; advanced features need localized changes without importing concrete adapter classes.

### Viable Options

#### Option A: Capability Interfaces + Name Guards (RECOMMENDED)
- ~5 capability interfaces for broadly useful patterns: `WithdrawCapable`, `TwapCapable`, `DexCapable`, `EvmAddressCapable`, `PacificaSdkCapable`
- Use `adapter.name === "x"` for fundamentally exchange-specific branches (funds sub-commands, rebalance switch, manage gates)
- Type guard functions: `isTwapCapable(adapter)` replaces `adapter instanceof HyperliquidAdapter` where the check is about capability
- Registry maps exchange names to factory functions
- **Pros:** Type-safe where it matters, minimal interface count, `adapter.name` is honest about exchange-specific code, gradual migration possible
- **Cons:** `adapter.name` checks are stringly-typed (but these are inherently exchange-specific branches anyway)

#### Option B: Runtime Capability Map
- Each adapter exposes `capabilities: Set<string>` (e.g., `"twap"`, `"withdraw"`, `"tpsl"`)
- Commands check `adapter.capabilities.has("twap")` then cast
- **Pros:** Simpler, no new interfaces needed
- **Cons:** Loses type safety at cast boundaries, no IDE autocomplete for capability methods, stringly-typed for everything including capability methods

#### Option C: Full Abstract Base Class
- Replace interface with abstract class, adapter-specific methods as optional overrides
- **Pros:** Single inheritance hierarchy, shared logic in base
- **Cons:** Forces single inheritance (Lighter already has complex WASM init), breaks `implements` contract, larger blast radius

**Decision:** Option A -- Capability interfaces for method-based capabilities (~5 interfaces), `adapter.name` checks for exchange-identity gates. This is honest: some branches are about "can this adapter do X?" (capability) while others are about "is this Pacifica?" (identity). Using the right tool for each avoids false abstraction.

---

## ADR: Architecture Decision Record

**Decision:** ~5 capability sub-interfaces + `adapter.name` identity guards + adapter registry
**Drivers:** Type safety for capabilities, honesty about exchange-specific code, extensibility for new DEXes
**Alternatives Considered:** Runtime capability map (loses type safety for everything), abstract base class (inheritance lock-in), full capability interfaces for all branches (false abstraction -- exchange-specific code is inherently coupled)
**Why Chosen:** Keeps TypeScript's structural typing for capability discovery. Uses `adapter.name` where the code is fundamentally exchange-specific anyway. Eliminates concrete adapter imports from command files.
**Consequences:** ~5 capability interfaces, ~7 type guard functions, 33 instanceof + 12 cast sites must be migrated, registry decouples factory logic
**Follow-ups:** Documentation for "how to add a new exchange", capability discovery in MCP server

---

## Context

### Current Architecture
- `src/exchanges/interface.ts` -- `ExchangeAdapter` interface with 18 methods (lines 70-98)
- 3 concrete adapters: Pacifica (371 LOC), Hyperliquid (1284 LOC), Lighter (1239 LOC)
- Factory in `src/index.ts` -- `getAdapter()` switch statement (lines 105-182), duplicated in `getAdapterForExchange()` (lines 227-299)
- 33 `instanceof` checks across 6 command files: trade.ts (10), funds.ts (6), manage.ts (2), market.ts (4), account.ts (8), rebalance.ts (3)
- 12 `as TypeAdapter` casts across: index.ts (3), market.ts (2), account.ts (5), manage.ts (1), plus account.ts:201, account.ts:1120, index.ts:391 for LighterSpotAdapter construction
- Adapter-specific property access: `adapter.sdk`, `adapter.publicKey`, `adapter.signer`, `adapter.address`, `adapter.accountIndex`, `adapter.dex`
- Object.create HIP-3 cloning pattern in market.ts:47,85 and account.ts:429

### Pain Points
1. Adding a new exchange requires editing: interface.ts, index.ts (2 switch statements), every command file that has instanceof
2. instanceof breaks when adapters are lazy-imported (Lighter is already lazy-loaded)
3. No way to discover what an adapter can do at runtime
4. withdraw() has 3 incompatible signatures
5. 12 `as TypeAdapter` casts create hidden coupling that the compiler cannot catch

---

## Work Objectives

1. Create a plugin registry so new DEX = 1 file + 1 registry entry
2. Replace all 33 instanceof checks with type-safe capability guards or `adapter.name` identity checks
3. Migrate all 12 `as TypeAdapter` casts to use capability guards or name checks
4. Unify withdraw() signature
5. Add optional `init()` and metadata (`chain`, `aliases`) to base interface
6. Maintain 100% backward compatibility throughout

---

## Guardrails

### Must Have
- All 941 existing tests pass at every step
- `tsc` compiles clean at every step
- Live trading works on all 3 exchanges after completion
- No breaking changes to CLI command surface
- No breaking changes to MCP server

### Must NOT Have
- No abstract base classes (keep interfaces)
- No runtime `any` casts to work around type issues
- No changes to adapter constructor signatures
- No removal of existing public adapter methods
- No new npm dependencies

---

## Task Flow (Dependency Order)

```
Step 1: Extend ExchangeAdapter interface (additive only)
   |
Step 2: Create capability sub-interfaces + type guards
   |
Step 3: Create registry.ts + register all 3 adapters
   |
Step 4: Unify withdraw() signature across adapters
   |
Step 5: Migrate instanceof checks + as-casts to capability guards + refactor factory
   |
Step 6: Update barrel exports + documentation
```

---

## Detailed TODOs

### Step 1: Extend ExchangeAdapter Interface (Additive)

**File:** `src/exchanges/interface.ts`

Add optional fields to `ExchangeAdapter` without breaking existing implementations:

```
ExchangeAdapter {
  readonly name: string;
  readonly chain?: string;            // NEW: "solana" | "evm" | "ethereum"
  readonly aliases?: readonly string[]; // NEW: ["hl"] for hyperliquid, ["lt"] for lighter, ["pac"] for pacifica
  init?(): Promise<void>;             // NEW: optional initialization (HL + Lighter need it, Pacifica doesn't)

  // ... all 18 existing methods unchanged ...
}
```

**Changes:**
- Add `chain?: string` (line ~71, after `name`)
- Add `aliases?: readonly string[]` (after `chain`)
- Add `init?(): Promise<void>` (after aliases)
- All optional -- existing adapters compile without changes

**Acceptance Criteria:**
- [ ] `tsc` compiles clean with no adapter changes
- [ ] All 941 tests pass
- [ ] Each adapter can optionally implement `chain`, `aliases`, `init`

**Then update each adapter to declare the new fields:**
- `PacificaAdapter`: `chain = "solana"`, `aliases = ["pac"]` (no `init`)
- `HyperliquidAdapter`: `chain = "evm"`, `aliases = ["hl"]`, existing `init()` already matches
- `LighterAdapter`: `chain = "ethereum"`, `aliases = ["lt"]`, existing `init()` already matches

---

### Step 2: Create Capability Sub-Interfaces + Type Guards

**New file:** `src/exchanges/capabilities.ts`

Define ~5 broadly useful capability interfaces plus 2 adapter-property interfaces:

```typescript
// ── Capability Interfaces (broadly useful patterns) ──

export interface WithdrawCapable {
  withdraw(amount: string, destination: string, opts?: { assetId?: number; routeType?: number }): Promise<unknown>;
}

export interface TwapCapable {
  twapOrder(symbol: string, side: "buy" | "sell", size: string, duration: number, opts?: { reduceOnly?: boolean; slippage?: number }): Promise<unknown>;
  twapCancel(symbol: string, twapId: number): Promise<unknown>;
}

export interface DexCapable {
  readonly dex: string;
  setDex(dex: string): void;
  listDeployedDexes(): Promise<{ name: string; deployer: string; assets: string[] }[]>;
}

export interface EvmAddressCapable {
  readonly address: string;
}

export interface PacificaSdkCapable {
  readonly sdk: import("../pacifica/index.js").PacificaClient;
  readonly publicKey: string;
  readonly signer: (msg: Uint8Array) => Promise<Uint8Array>;
}

// ── Additional capability interfaces for specific methods ──

export interface QueryOrderCapable {
  queryOrder(orderId: number): Promise<unknown>;
}

export interface UsdTransferCapable {
  usdTransfer(amount: number, destination: string): Promise<unknown>;
}

export interface TriggerOrderCapable {
  triggerOrder(symbol: string, side: "buy" | "sell", size: string, triggerPrice: string, type: string, opts?: Record<string, unknown>): Promise<unknown>;
}

export interface TpSlCapable {
  setTpSl(symbol: string, side: "buy" | "sell", opts: { tp?: string; tpLimit?: string; sl?: string; size?: string }): Promise<unknown>;
}

export interface SubAccountCapable {
  createSubAccount(name: string): Promise<unknown>;
  subAccountTransfer(subAccountUser: string, isDeposit: boolean, amount: number): Promise<unknown>;
}

export interface LighterAccountCapable {
  readonly accountIndex: number;
  readonly address: string;
  setupApiKey(apiKeyIndex?: number): Promise<{ privateKey: string; publicKey: string }>;
}

// ── Type Guards ──

export function isWithdrawCapable(adapter: unknown): adapter is WithdrawCapable {
  return typeof (adapter as any).withdraw === "function";
}

export function isTwapCapable(adapter: unknown): adapter is TwapCapable {
  return typeof (adapter as any).twapOrder === "function" && typeof (adapter as any).twapCancel === "function";
}

export function isTpSlCapable(adapter: unknown): adapter is TpSlCapable {
  return typeof (adapter as any).setTpSl === "function";
}

export function isTriggerOrderCapable(adapter: unknown): adapter is TriggerOrderCapable {
  return typeof (adapter as any).triggerOrder === "function";
}

export function isQueryOrderCapable(adapter: unknown): adapter is QueryOrderCapable {
  return typeof (adapter as any).queryOrder === "function";
}

export function isUsdTransferCapable(adapter: unknown): adapter is UsdTransferCapable {
  return typeof (adapter as any).usdTransfer === "function";
}

export function isSubAccountCapable(adapter: unknown): adapter is SubAccountCapable {
  return typeof (adapter as any).createSubAccount === "function";
}

export function isDexCapable(adapter: unknown): adapter is DexCapable {
  return typeof (adapter as any).setDex === "function";
}

export function hasPacificaSdk(adapter: unknown): adapter is PacificaSdkCapable {
  return (adapter as any)?.name === "pacifica"
    && typeof (adapter as any).sdk === "object"
    && typeof (adapter as any).publicKey === "string";
}

export function hasLighterAccount(adapter: unknown): adapter is LighterAccountCapable {
  return typeof (adapter as any).accountIndex === "number" && typeof (adapter as any).setupApiKey === "function";
}

export function hasEvmAddress(adapter: unknown): adapter is EvmAddressCapable {
  return typeof (adapter as any).address === "string";
}
```

**Key changes from v1:**
- Added `QueryOrderCapable` interface for trade.ts:951 `queryOrder()` (was incorrectly mapped to `isTriggerOrderCapable` in v1)
- Added `UsdTransferCapable` interface for funds.ts:693 `usdTransfer()`
- Strengthened `hasPacificaSdk` guard with `adapter.name === "pacifica"` check to prevent false positives (any object with an `sdk` property and `publicKey` string would have matched before)
- Reduced emphasis to ~5 core capability interfaces + supporting interfaces

**Also create:** `src/exchanges/capabilities.test.ts` -- unit tests for each type guard against mock objects.

**Acceptance Criteria:**
- [ ] Each type guard returns `true` for the correct adapter and `false` for others
- [ ] `hasPacificaSdk` requires `adapter.name === "pacifica"` (not just property existence)
- [ ] `isQueryOrderCapable` correctly identifies adapters with `queryOrder` method
- [ ] `isUsdTransferCapable` correctly identifies adapters with `usdTransfer` method
- [ ] Type narrowing works in TypeScript (IDE shows correct methods after guard)
- [ ] `tsc` compiles clean
- [ ] Tests cover: positive case (each real adapter), negative case (wrong adapter), edge case (partial implementation, false positive prevention for `hasPacificaSdk`)

---

### Step 3: Create Registry + Register Adapters

**New file:** `src/exchanges/registry.ts`

```typescript
import type { ExchangeAdapter } from "./interface.js";

export type AdapterFactory = (...args: any[]) => ExchangeAdapter | Promise<ExchangeAdapter>;

interface AdapterRegistration {
  name: string;
  aliases: string[];
  chain: string;
  factory?: AdapterFactory;  // Optional -- not required at registration time
  /** Lazy import path -- used for deferred loading (like Lighter's CJS workaround) */
  importPath?: string;
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
  // Return unique canonical names (not aliases)
  return [...new Set([...registry.values()].map(r => r.name))];
}

export function resolveExchangeName(nameOrAlias: string): string {
  const reg = registry.get(nameOrAlias.toLowerCase());
  return reg?.name ?? nameOrAlias.toLowerCase();
}
```

**Register adapters (bottom of registry.ts or separate registration file):**

```typescript
// ── Built-in adapter registrations ──
// factory is omitted at registration time; actual construction
// remains in index.ts getAdapter()/getAdapterForExchange() for now.
// Future exchanges can provide factory directly.

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
  importPath: "./lighter.js",
});
```

**Key change from v1:** The `factory` field is now optional. Registrations do NOT include throwing placeholder factories. The registry's primary value in Step 3 is `resolveExchangeName()` (replacing the inline alias map) and `listExchanges()`. Actual adapter construction stays in index.ts until a future PR wires factories through the registry.

**Acceptance Criteria:**
- [ ] `listExchanges()` returns `["pacifica", "hyperliquid", "lighter"]`
- [ ] `resolveExchangeName("hl")` returns `"hyperliquid"`
- [ ] `resolveExchangeName("lt")` returns `"lighter"`
- [ ] `resolveExchangeName("pac")` returns `"pacifica"`
- [ ] `resolveExchangeName("hyperliquid")` returns `"hyperliquid"` (pass-through)
- [ ] No throwing factory placeholders -- `factory` field is simply absent
- [ ] Exported from barrel `src/exchanges/index.ts`
- [ ] Unit tests in `src/__tests__/exchanges/registry.test.ts`

---

### Step 4: Unify withdraw() Signature

**Goal:** All 3 adapters expose a `withdraw()` method matching the `WithdrawCapable` interface:
```typescript
withdraw(amount: string, destination: string, opts?: { assetId?: number; routeType?: number }): Promise<unknown>
```

**File changes:**

1. **`src/exchanges/hyperliquid.ts`** (line ~921):
   - Current: `async withdraw(amount: string, destination: string)` -- already compatible, just needs `opts?` param added (ignored)
   - Change: `async withdraw(amount: string, destination: string, _opts?: { assetId?: number; routeType?: number })`

2. **`src/exchanges/lighter.ts`** (line ~662):
   - Current: `async withdraw(amount: number, assetId = 3, routeType = 0)`
   - Change: Keep existing method as `_withdrawLegacy(amount: number, assetId: number, routeType: number)`
   - Add new: `async withdraw(amount: string, destination: string, opts?: { assetId?: number; routeType?: number })` that calls `_withdrawLegacy(parseFloat(amount), opts?.assetId ?? 3, opts?.routeType ?? 0)`
   - Note: Lighter withdraw doesn't use `destination` (it goes to the registered account). Accept but ignore it.

3. **`src/exchanges/pacifica.ts`**:
   - Current: No `withdraw()` method on adapter -- uses `adapter.sdk.withdraw()`
   - Add: `async withdraw(amount: string, destination: string)` that calls `this.client.withdraw({ amount, dest_address: destination }, this.account, this.signMessage)`

4. **`src/commands/rebalance.ts`** (lines 278-303):
   - After all 3 adapters have unified `withdraw()`, update the rebalance switch:
     - Replace instanceof checks with `adapter.name === "x"` identity checks
     - **Critical:** Line 298 `adapter.withdraw(move.amount)` passes a single number. Must update to: `adapter.withdraw(String(move.amount), adapter.address ?? "")` to match new unified signature
     - Pacifica branch (line 282): can switch from `adapter.sdk.withdraw(...)` to `adapter.withdraw(String(move.amount), adapter.publicKey)` once Pacifica implements `WithdrawCapable`
     - HL branch (line 292): already matches signature
   - After unification, the entire switch can potentially simplify to: `if (isWithdrawCapable(adapter)) await adapter.withdraw(String(move.amount), "self")` -- but keep the switch for now since each exchange has different self-destination semantics

**Acceptance Criteria:**
- [ ] All 3 adapters implement `WithdrawCapable` interface
- [ ] `isWithdrawCapable(adapter)` returns `true` for all 3
- [ ] rebalance.ts:298 updated to pass `(String(move.amount), destination)` instead of `(move.amount)` single arg
- [ ] Existing `funds.ts` withdraw commands still work unchanged (backward compat)
- [ ] `tsc` compiles clean
- [ ] All tests pass

---

### Step 5: Migrate instanceof Checks + as-Casts + Refactor Factory

This is the largest step. Break it into sub-tasks:

#### 5a: Replace `resolveExchangeAlias()` in index.ts with registry

**File:** `src/index.ts` (line 92-99)

Replace:
```typescript
function resolveExchangeAlias(name: string): string {
  const aliases: Record<string, string> = { hl: "hyperliquid", lt: "lighter", pac: "pacifica" };
  return aliases[name.toLowerCase()] ?? name.toLowerCase();
}
```

With:
```typescript
import { resolveExchangeName } from "./exchanges/registry.js";
// resolveExchangeAlias becomes resolveExchangeName from registry
```

Update all call sites in index.ts (lines 98, 102, 112, 228).

#### 5b: Migrate instanceof checks + as-casts in command files

**Strategy: Use capability guards for capability checks, `adapter.name` for identity gates.**

| Pattern | Replacement |
|---------|-------------|
| `instanceof PacificaAdapter` (gate for Pacifica-only sub-command) | `adapter.name === "pacifica"` |
| `instanceof HyperliquidAdapter` (gate for HL-only sub-command) | `adapter.name === "hyperliquid"` |
| `instanceof LighterAdapter` (gate for Lighter-only sub-command) | `adapter.name === "lighter"` |
| `instanceof HyperliquidAdapter` (for `.twapOrder()`) | `isTwapCapable(adapter)` |
| `instanceof PacificaAdapter` (for `.sdk.createTWAP()`) | `hasPacificaSdk(adapter)` |
| `instanceof HyperliquidAdapter` (for `.triggerOrder()`) | `isTriggerOrderCapable(adapter)` |
| `instanceof HyperliquidAdapter` (for `.queryOrder()`) | `isQueryOrderCapable(adapter)` |
| `instanceof HyperliquidAdapter` (for `.usdTransfer()`) | `isUsdTransferCapable(adapter)` |
| `instanceof HyperliquidAdapter` (for `.address`) | `hasEvmAddress(adapter)` |
| `instanceof LighterAdapter` (for `.accountIndex`) | `hasLighterAccount(adapter)` |
| `instanceof HyperliquidAdapter` (for HIP-3 `.dex` + `.setDex()`) | `isDexCapable(adapter)` |
| `as HyperliquidAdapter` cast | Capability guard narrowing (see below) |
| `as PacificaAdapter` cast | Capability guard narrowing (see below) |

**File-by-file instanceof migration (33 sites):**

1. **`src/commands/trade.ts`** (10 instances):
   - Line 11: `adapter.name === "pacifica"` -- Pacifica-only command guard (identity gate)
   - Line 444: `!isTwapCapable(adapter)` -- Lighter fallback to client-side TWAP
   - Line 458: `hasPacificaSdk(adapter)` -- Pacifica TWAP via SDK
   - Line 471: `isTwapCapable(adapter)` -- HL native TWAP
   - Line 538: `hasPacificaSdk(adapter)` -- TP/SL via Pacifica SDK
   - Line 554: `isTriggerOrderCapable(adapter)` -- HL trigger orders for TP/SL
   - Line 585: `adapter.name === "lighter"` -- Lighter TP/SL (not yet supported, identity gate)
   - Line 740: `hasPacificaSdk(adapter)` -- cancel TWAP via Pacifica SDK
   - Line 746: `isTwapCapable(adapter)` -- cancel TWAP via HL
   - Line 951: `isQueryOrderCapable(adapter)` -- HL query order (**NOT** `isTriggerOrderCapable` -- queryOrder is a distinct capability)

2. **`src/commands/funds.ts`** (6 instances):
   - Lines 53, 130, 548: `adapter.name === "pacifica"` (Pacifica deposit/withdraw identity gates)
   - Line 596: `adapter.name === "hyperliquid"` (HL withdraw identity gate)
   - Line 649: `adapter.name === "lighter"` (Lighter withdraw identity gate)
   - Line 693: `isUsdTransferCapable(adapter)` -- HL USD transfer (**new capability guard**, not just name check, since usdTransfer is a method capability)

3. **`src/commands/manage.ts`** (2 instances):
   - Line 18: `adapter.name === "pacifica"` -- Pacifica manage commands identity gate
   - Line 365: `adapter.name === "lighter"` -- Lighter account setup identity gate

4. **`src/commands/market.ts`** (4 instances):
   - Lines 44, 82: `isDexCapable(adapter)` -- HIP-3 dex listing (capability)
   - Line 148: `hasPacificaSdk(adapter)` -- Pacifica price oracle (capability)
   - Line 388: `adapter.name === "hyperliquid"` -- HL-only market info (identity gate)

5. **`src/commands/account.ts`** (8 instances):
   - Lines 470, 499, 525, 602, 631, 657: `isDexCapable(adapter)` -- HIP-3 portfolio views (capability)
   - Line 143: `adapter.name === "pacifica"` -- market settings (identity gate)
   - Line 738: `hasPacificaSdk(adapter)` -- Pacifica account settings (capability)

6. **`src/commands/rebalance.ts`** (3 instances):
   - Lines 281, 291, 297: `adapter.name === "pacifica"/"hyperliquid"/"lighter"` -- these are exchange-specific rebalance logic (identity gates, the switch-case structure makes this the natural pattern)

**`as TypeAdapter` cast migration (9 sites):**

7. **`src/index.ts`** (2 casts):
   - Line 378: `adapter as HyperliquidAdapter` in `new HyperliquidSpotAdapter(...)` -- use `isDexCapable(adapter)` or `adapter.name === "hyperliquid"` guard before, then narrow. Or: change `getPacificaAdapter()` return type (see item 8 below) and keep `HyperliquidSpotAdapter` accepting `ExchangeAdapter & EvmAddressCapable` instead of concrete type.
   - Line 387: `(adapter as HyperliquidAdapter).dex` -- replace with `isDexCapable(adapter) ? adapter.dex : undefined`

8. **`src/commands/market.ts`** (2 casts):
   - Line 47: `Object.create(adapter) as HyperliquidAdapter` -- prototypal clone for HIP-3 dex context. Replace with `Object.create(adapter) as ExchangeAdapter & DexCapable`. Note: prototypal clones pass type guards since they inherit the prototype chain, so `isDexCapable()` will return true on clones.
   - Line 85: Same pattern as line 47.

9. **`src/commands/account.ts`** (5 casts):
   - Line 183: `adapter as HyperliquidAdapter` in `new HyperliquidSpotAdapter(...)` -- same as index.ts:378
   - Line 201: `adapter as InstanceType<typeof LighterAdapter>` in `new LighterSpotAdapter(...)` -- use `hasLighterAccount(adapter)` guard before, then narrow to `ExchangeAdapter & LighterAccountCapable` (or keep `InstanceType<typeof LighterAdapter>` cast if LighterSpotAdapter constructor requires it; see spot adapter constructor note below)
   - Line 219: `(adapter as HyperliquidAdapter).dex` -- replace with `isDexCapable(adapter) ? !adapter.dex : false` or use name check
   - Line 429: `Object.create(hlAdapter) as HyperliquidAdapter` in `fetchHip3Data` -- replace cast with `ExchangeAdapter & DexCapable`. **Also:** change `fetchHip3Data` function signature from `hlAdapter: HyperliquidAdapter` to `hlAdapter: ExchangeAdapter & DexCapable` (prototypal clones inherit the prototype, so capability guards still work)
   - Line 1103: `adapter as HyperliquidAdapter` in `new HyperliquidSpotAdapter(...)` -- same pattern as line 183
   - Line 1120: `adapter as InstanceType<typeof LighterAdapter>` in `new LighterSpotAdapter(...)` -- same pattern as line 201

10. **`src/commands/manage.ts`** (1 cast):
    - Line 21: `return adapter as PacificaAdapter` -- this feeds into manage sub-commands that use `adapter.sdk`. Replace with: change `getPacificaAdapter()` return type to `ExchangeAdapter & PacificaSdkCapable` (see index.ts item 8 from architect feedback). Then manage.ts:11 signature changes from `getPacificaAdapter: () => PacificaAdapter` to `getPacificaAdapter: () => ExchangeAdapter & PacificaSdkCapable`.

11. **`src/index.ts`** (1 additional cast):
    - Line 391: `adapter as InstanceType<typeof LighterAdapter>` in `new LighterSpotAdapter(...)` -- same pattern as account.ts:201 and account.ts:1120. Use `hasLighterAccount(adapter)` guard or keep `InstanceType<typeof LighterAdapter>` cast if LighterSpotAdapter constructor signature requires the concrete type (see spot adapter constructor note below).

**Spot adapter constructor note:** `HyperliquidSpotAdapter` and `LighterSpotAdapter` constructors currently accept concrete adapter types (`HyperliquidAdapter`, `LighterAdapter`). As part of this migration, evaluate whether their constructors can be updated to accept capability intersection types instead (`ExchangeAdapter & DexCapable & EvmAddressCapable` for HyperliquidSpotAdapter; `ExchangeAdapter & LighterAccountCapable` for LighterSpotAdapter). If so, all `InstanceType<typeof ...>` casts at construction sites become unnecessary. If not (e.g., the constructors use private fields not expressible in capability interfaces), keep the `InstanceType<typeof ...>` cast as the minimal coupling point and document it.

**`getPacificaAdapter()` return type (Architect item 8):**

**File:** `src/index.ts` (line 199)

Change:
```typescript
function getPacificaAdapter(): PacificaAdapter {
```
To:
```typescript
function getPacificaAdapter(): ExchangeAdapter & PacificaSdkCapable {
```

This cascades to `manage.ts:11` which changes its parameter type accordingly. The manage sub-commands only need `sdk`, `publicKey`, `signer` -- all provided by `PacificaSdkCapable`.

**`getHLAdapter()` return type:**

**File:** `src/index.ts` (line ~204)

`getHLAdapter()` currently returns `HyperliquidAdapter` (concrete type). This feeds into `HyperliquidSpotAdapter` construction and any call sites that access HL-specific properties. Decide between two options:

- **Option A (preferred):** Change return type to `ExchangeAdapter & DexCapable & EvmAddressCapable`. This eliminates the concrete import at call sites and aligns with the capability pattern. Requires `HyperliquidSpotAdapter` constructor to accept this intersection type instead of `HyperliquidAdapter`.
- **Option B (conservative):** Keep `HyperliquidAdapter` concrete return type for now; accept that `getHLAdapter()` remains a coupling point. Document as a follow-up.

Apply the same analysis as `getPacificaAdapter()` -- choose Option A if `HyperliquidSpotAdapter` can be updated to accept the intersection type; otherwise Option B.

#### 5c: Remove concrete adapter imports from command files

After all instanceof checks and as-casts are replaced, remove these imports from command files:
- `import { PacificaAdapter } from "../exchanges/pacifica.js"`
- `import { HyperliquidAdapter } from "../exchanges/hyperliquid.js"`
- `import { LighterAdapter } from "../exchanges/lighter.js"`

Replace with:
- `import { hasPacificaSdk, isTwapCapable, isDexCapable, ... } from "../exchanges/capabilities.js"`

**Note:** Some command files access `adapter.sdk` after type guard narrowing. This is fine -- `hasPacificaSdk(adapter)` narrows to `PacificaSdkCapable` which has `.sdk`.

**Note:** `rebalance.ts` currently uses dynamic `import(...)` for adapter types inside the switch. After migration to `adapter.name` checks, these dynamic imports can be removed entirely.

#### 5d: Refactor getAdapter() / getAdapterForExchange() in index.ts

The switch statements in `getAdapter()` (lines 119-179) and `getAdapterForExchange()` (lines 235-298) contain duplicated adapter construction logic.

**Do NOT fully refactor these yet.** The adapter construction has exchange-specific init logic (referral codes, lazy imports, dex config) that is hard to generalize. Instead:

1. Replace `resolveExchangeAlias` calls with `resolveExchangeName` from registry
2. Keep the switch statements but add a comment that future exchanges should use registry factory
3. Remove the `_pacificaAdapter`, `_hlAdapter`, `_lighterAdapter` typed fields from index.ts -- use a `Map<string, ExchangeAdapter>` cache instead

**Acceptance Criteria for all of Step 5:**
- [ ] Verify test baseline: `pnpm run test` confirms 941 tests pass before starting migration
- [ ] Zero `instanceof PacificaAdapter|HyperliquidAdapter|LighterAdapter` in `src/commands/` directory
- [ ] Zero `as PacificaAdapter|HyperliquidAdapter|LighterAdapter` casts in `src/commands/` directory
- [ ] Zero concrete adapter imports in `src/commands/` directory (except lazy imports in rebalance.ts if kept -- but those should be removable)
- [ ] `resolveExchangeAlias` removed from index.ts, replaced by registry
- [ ] `getPacificaAdapter()` returns `ExchangeAdapter & PacificaSdkCapable` (not `PacificaAdapter`)
- [ ] `getHLAdapter()` return type updated (Option A or B decision documented in commit message)
- [ ] `fetchHip3Data` signature uses `ExchangeAdapter & DexCapable` (not `HyperliquidAdapter`)
- [ ] trade.ts:951 uses `isQueryOrderCapable` (not `isTriggerOrderCapable`)
- [ ] funds.ts:693 uses `isUsdTransferCapable`
- [ ] All 3 missing LighterSpotAdapter cast sites addressed (account.ts:201, account.ts:1120, index.ts:391)
- [ ] `tsc` compiles clean
- [ ] All 941 tests pass
- [ ] Manual smoke test: `perp -e hl market list`, `perp -e pac balance`, `perp -e lt balance`

**Rollback strategy:** Each sub-step of Step 5 (5a, 5b per-file, 5c, 5d) should be a separate commit so partial migration can be reverted with `git revert` without unwinding the entire step. Suggested commit granularity: one commit per command file migrated in 5b.

---

### Step 6: Update Barrel Exports + Documentation

**File:** `src/exchanges/index.ts`

Add exports:
```typescript
export * from "./capabilities.js";
export { registerAdapter, getAdapterRegistration, listExchanges, resolveExchangeName } from "./registry.js";
```

Keep existing adapter exports (they are still needed for direct instantiation in tests and index.ts).

**New file:** `src/exchanges/ADDING_AN_EXCHANGE.md` (or section in project README)

Document the steps:
1. Create `src/exchanges/my-dex.ts` implementing `ExchangeAdapter` + relevant capability interfaces
2. Add registration in `src/exchanges/registry.ts`
3. Add constructor case in `src/index.ts` `getAdapter()` switch
4. Add tests
5. That's it -- command files only need changes for exchange-specific features beyond base functionality

**Update existing test:** `src/__tests__/exchanges/interface.test.ts`
- Add tests for capability type guards
- Add test that all registered adapters satisfy `ExchangeAdapter`

**Acceptance Criteria:**
- [ ] All new types/functions exported from barrel
- [ ] Adding-an-exchange documentation exists
- [ ] `tsc` compiles clean
- [ ] All tests pass
- [ ] Live test: order + cancel on all 3 exchanges

---

## Risk Assessment

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| Type guard returns wrong result at runtime | HIGH (wrong code path) | LOW | Comprehensive unit tests for each guard; `hasPacificaSdk` includes name check |
| Missed instanceof/cast check causes runtime error | HIGH (command fails) | MEDIUM | Grep for `instanceof` AND `as.*Adapter` after migration, add lint rule |
| Lighter lazy import breaks with registry | MEDIUM (Lighter unusable) | LOW | Keep lazy import pattern, registry just holds metadata |
| withdraw() unification breaks existing funds commands | HIGH (money operations) | MEDIUM | Test each withdraw path separately, keep old method as alias |
| rebalance.ts withdraw call passes wrong args | HIGH (money operation) | MEDIUM | Explicit test for rebalance withdraw with new signature |
| Capability interface doesn't narrow correctly | MEDIUM (type errors) | LOW | TypeScript compiler catches at build time |
| Object.create clones don't pass type guards | MEDIUM (HIP-3 breaks) | LOW | Prototypal clones inherit prototype -- guards check methods on prototype chain. Add explicit test. |
| MCP server has adapter-specific logic | MEDIUM (MCP breaks) | LOW | MCP only uses `adapter.name` (already checked -- no instanceof in mcp-server.ts) |
| `getPacificaAdapter()` return type change breaks callers | LOW | LOW | Only manage.ts consumes this; update in same PR |

---

## Success Criteria (Final)

1. `grep -r "instanceof PacificaAdapter\|instanceof HyperliquidAdapter\|instanceof LighterAdapter" src/commands/` returns zero results
2. `grep -r "as PacificaAdapter\|as HyperliquidAdapter\|as LighterAdapter" src/commands/` returns zero results
3. `src/exchanges/registry.ts` exists with `registerAdapter`, `getAdapterRegistration`, `listExchanges`
4. `src/exchanges/capabilities.ts` exists with all capability interfaces + type guards (including `QueryOrderCapable`, `UsdTransferCapable`)
5. All 3 adapters implement `WithdrawCapable` with unified signature
6. `ExchangeAdapter` interface has optional `init()`, `chain`, `aliases`
7. `hasPacificaSdk` guard includes `adapter.name === "pacifica"` check
8. `fetchHip3Data` accepts `ExchangeAdapter & DexCapable` (not `HyperliquidAdapter`)
9. `getPacificaAdapter()` returns `ExchangeAdapter & PacificaSdkCapable`
10. rebalance.ts withdraw calls use unified signature (no single-arg `withdraw(amount)`)
11. `tsc --noEmit` exits 0
12. `npx vitest --run` -- all 941+ tests pass
13. Live validation: `perp -e hl trade market BTC buy 0.001 --dry-run` works
14. Live validation: `perp -e pac balance` works
15. Live validation: `perp -e lt balance` works

---

## Execution Order Summary

| Order | Step | Est. Effort | Risk |
|-------|------|-------------|------|
| 1 | Extend ExchangeAdapter interface | Small | Very Low |
| 2 | Create capabilities.ts + type guards | Medium | Low |
| 3 | Create registry.ts + register adapters | Medium | Low |
| 4 | Unify withdraw() signature + fix rebalance.ts | Medium | Medium |
| 5a | Replace resolveExchangeAlias with registry | Small | Low |
| 5b | Migrate 33 instanceof + 9 as-cast sites | Large | Medium |
| 5c | Remove concrete adapter imports from commands | Small | Low |
| 5d | Refactor getAdapter cache | Medium | Medium |
| 6 | Barrel exports + documentation | Small | Very Low |

**Total estimated effort:** ~4-6 hours of focused executor work
**Recommended approach:** Execute steps 1-3 together (foundation), then 4 (withdraw + rebalance fix), then 5a-5d (migration), then 6 (cleanup)

---

## Revision Log

### v2 -- 2026-03-19 (Architect REVISE feedback)

Addressed all 10 issues from Architect review:

1. **Fixed instanceof count: 37 -> 33.** Removed index.ts from command file list (it has zero adapter instanceof checks; its only instanceof usage is `err instanceof Error`). Corrected to 6 command files.

2. **Added 9 `as TypeAdapter` cast migration to Step 5b.** Itemized all 9 sites: index.ts:378,387; market.ts:47,85; account.ts:183,219,429,1103; manage.ts:21. Each has a specific migration strategy.

3. **Object.create HIP-3 cloning pattern addressed.** Documented that prototypal clones pass type guards (inherit prototype chain). Changed `fetchHip3Data` signature from `hlAdapter: HyperliquidAdapter` to `ExchangeAdapter & DexCapable`. Cast sites use `ExchangeAdapter & DexCapable` instead of concrete type.

4. **Strengthened `hasPacificaSdk` guard.** Added `adapter.name === "pacifica"` check to prevent false positives from any object that happens to have `sdk` and `publicKey` properties.

5. **Added `QueryOrderCapable` interface.** trade.ts:951 `queryOrder()` now correctly uses `isQueryOrderCapable(adapter)` instead of being incorrectly mapped to `isTriggerOrderCapable`.

6. **Added `UsdTransferCapable` interface.** funds.ts:693 `usdTransfer()` now uses `isUsdTransferCapable(adapter)` capability guard.

7. **Addressed rebalance.ts:298.** `adapter.withdraw(move.amount)` passes single number -- must update to `adapter.withdraw(String(move.amount), destination)` to match unified `WithdrawCapable` signature. Added to Step 4 with explicit acceptance criteria.

8. **Addressed `getPacificaAdapter()` return type.** Changed from `PacificaAdapter` concrete type to `ExchangeAdapter & PacificaSdkCapable`. Cascading change to manage.ts:11 parameter signature documented.

9. **Replaced throwing factory placeholders.** Registry `factory` field is now optional (`factory?: AdapterFactory`). Registrations simply omit the field instead of providing `() => { throw ... }` placeholders. Actual construction remains in index.ts.

10. **Adopted Architect's synthesis on capability vs. identity.** ~5 capability interfaces for broadly useful patterns (WithdrawCapable, TwapCapable, DexCapable, EvmAddressCapable, PacificaSdkCapable) + additional method-specific interfaces (QueryOrderCapable, UsdTransferCapable, TriggerOrderCapable, TpSlCapable, SubAccountCapable, LighterAccountCapable). `adapter.name === "x"` for fundamentally exchange-specific branches. Added "Tradeoff Acknowledgment" section explaining that capability pattern reduces import-level coupling, not semantic coupling.

### v3 -- 2026-03-20 (Critic feedback)

Addressed all issues from Critic review:

1. **Added 3 missing `InstanceType<typeof LighterAdapter>` cast sites.** account.ts:201, account.ts:1120, index.ts:391 all construct `LighterSpotAdapter` and require the same treatment as the 9 previously-documented casts. Updated scope from "9 cast migrations" to "12 cast migrations" throughout.

2. **Added `getHLAdapter()` coverage in Step 5d.** `getHLAdapter()` at index.ts:~204 returns `HyperliquidAdapter` concrete type and needs the same return-type treatment as `getPacificaAdapter()`. Documented two options (preferred: `ExchangeAdapter & DexCapable & EvmAddressCapable`; conservative: keep concrete type) with decision criteria.

3. **Added spot adapter constructor note.** `HyperliquidSpotAdapter` and `LighterSpotAdapter` constructors may need signature updates to accept capability intersection types instead of concrete adapter types. If updated, all `InstanceType<typeof ...>` construction casts become unnecessary. Documented the evaluation and fallback strategy.

4. **Added test baseline verification to Step 5 acceptance criteria.** "Verify test baseline: `pnpm run test` confirms 941 tests pass before starting migration" added as the first acceptance criterion for Step 5.

5. **Added rollback strategy.** Each sub-step of Step 5 should be a separate commit (one per command file for 5b) so partial migration can be reverted with `git revert` without unwinding the entire step.
