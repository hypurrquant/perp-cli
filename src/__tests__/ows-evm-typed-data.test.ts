/**
 * OwsEvmSigner.signTypedData hands OWS a JSON string: bigint message values (RISEx nonce
 * anchors) must serialize as decimal strings and sign the same digest as the bigint message
 * (live bug 2026-10-28: `wallet agent approve risex` → "Do not know how to serialize a BigInt").
 * The fake vault signs the received JSON with a local key; no real vault is opened.
 */
import { describe, it, expect, vi } from "vitest";
import { TypedDataEncoder, Wallet, verifyTypedData } from "ethers";

const KEY = new Wallet("0x" + "11".repeat(32));
const received: string[] = [];
const fakeOws = {
  getWallet: vi.fn((name: string) => ({ name, accounts: [{ chainId: "eip155:1", address: KEY.address }] })),
  signTypedData: vi.fn((_w: string, _chain: string, json: string) => {
    received.push(json);
    const td = JSON.parse(json) as { domain: Record<string, unknown>; types: Record<string, Array<{ name: string; type: string }>>; message: Record<string, unknown> };
    const { EIP712Domain: _d, ...types } = td.types;
    return { signature: KEY.signingKey.sign(TypedDataEncoder.hash(td.domain, types, td.message)).serialized };
  }),
};
vi.mock("../signer/ows-loader.js", () => ({ loadOws: () => fakeOws }));

describe("OwsEvmSigner.signTypedData", () => {
  it("serializes bigint values as decimal strings and signs the bigint message's digest", async () => {
    const { OwsEvmSigner } = await import("../signer/ows-evm.js");
    const signer = OwsEvmSigner.create("main", "");
    const domain = { name: "RISEx", version: "1", chainId: 11155931, verifyingContract: "0x6da86f486b5e6536358f5b122dbe184522ca0ee3" };
    const types = { VerifySigner: [{ name: "account", type: "address" }, { name: "nonceAnchor", type: "uint48" }, { name: "nonceBitmap", type: "uint8" }] };
    const message = { account: KEY.address, nonceAnchor: 281474976710000n, nonceBitmap: 7 };

    const sig = await signer.signTypedData(domain, types, message);

    expect((JSON.parse(received[0]) as { message: { nonceAnchor: unknown } }).message.nonceAnchor).toBe("281474976710000");
    expect(verifyTypedData(domain, types, message, sig)).toBe(KEY.address);
  });
});
