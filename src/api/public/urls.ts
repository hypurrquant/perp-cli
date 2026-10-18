/**
 * Shared API URL management for all exchanges.
 *
 * `legacyPublicBaseUrl(venue, net)` is the network-aware source for the public
 * data path (funding/legacy-public.ts). The mutable `*_API_URL` globals remain
 * for the older fetchers below and are switched by setSharedApiNetwork().
 */

import { PerpError } from "../../errors.js";
import { asterVenue } from "../../exchanges/venues/aster.js";
import { MAINNET_REST as PAC_MAINNET_REST, TESTNET_REST as PAC_TESTNET_REST } from "../../pacifica/constants.js";

type LegacyPublicVenue = "pacifica" | "hyperliquid" | "aster";

/** REST base per legacy venue and network. null = no public testnet API known. */
const LEGACY_PUBLIC_BASES: Record<LegacyPublicVenue, { mainnet: string; testnet: string | null }> = {
  pacifica: { mainnet: PAC_MAINNET_REST, testnet: PAC_TESTNET_REST },
  hyperliquid: { mainnet: "https://api.hyperliquid.xyz", testnet: "https://api.hyperliquid-testnet.xyz" },
  // SSOT: the Aster venue definition (venues/aster.ts) — same hosts AsterAdapter uses.
  aster: { mainnet: asterVenue.networks.mainnet.restUrl, testnet: asterVenue.networks.testnet === null ? null : asterVenue.networks.testnet.restUrl },
};

export function legacyPublicBaseUrl(venue: LegacyPublicVenue, net: "mainnet" | "testnet"): string {
  const url = LEGACY_PUBLIC_BASES[venue][net];
  if (url === null) {
    throw new PerpError("NOT_IMPLEMENTED", `${venue} has no public ${net} market-data API`, {
      remediation: `Run without --testnet for ${venue} market data`,
    });
  }
  return url;
}

const MAINNET_URLS = {
  pacifica: `${PAC_MAINNET_REST}/info/prices`,
  hyperliquid: "https://api.hyperliquid.xyz/info",
  lighter: "https://mainnet.zklighter.elliot.ai",
} as const;

const TESTNET_URLS = {
  pacifica: `${PAC_TESTNET_REST}/info/prices`,
  hyperliquid: "https://api.hyperliquid-testnet.xyz/info",
  lighter: "https://testnet.zklighter.elliot.ai",
} as const;

export let PACIFICA_API_URL: string = MAINNET_URLS.pacifica;
/** GET /info (instrument_type: which `prices` rows are perps). */
export let PACIFICA_INFO_URL: string = `${PAC_MAINNET_REST}/info`;
export let HYPERLIQUID_API_URL: string = MAINNET_URLS.hyperliquid;
export let LIGHTER_API_URL: string = MAINNET_URLS.lighter;
let _sharedNetwork: "mainnet" | "testnet" = "mainnet";

/** Network selected by the CLI entry point (setSharedApiNetwork). */
export function sharedApiNetwork(): "mainnet" | "testnet" {
  return _sharedNetwork;
}

/**
 * Switch shared API URLs between mainnet and testnet.
 * Call from CLI entry point after parsing --network flag.
 */
export function setSharedApiNetwork(network: "mainnet" | "testnet"): void {
  _sharedNetwork = network;
  const urls = network === "testnet" ? TESTNET_URLS : MAINNET_URLS;
  PACIFICA_API_URL = urls.pacifica;
  PACIFICA_INFO_URL = `${network === "testnet" ? PAC_TESTNET_REST : PAC_MAINNET_REST}/info`;
  HYPERLIQUID_API_URL = urls.hyperliquid;
  LIGHTER_API_URL = urls.lighter;
}
