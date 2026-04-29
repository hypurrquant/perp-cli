import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Readable } from "stream";

describe("resolvePassphrase", () => {
  const originalStdin = process.stdin;

  beforeEach(() => {
    delete process.env["OWS_PASSPHRASE"];
  });

  afterEach(() => {
    delete process.env["OWS_PASSPHRASE"];
    Object.defineProperty(process, "stdin", { value: originalStdin, configurable: true });
  });

  it("flag wins over env and stdin", async () => {
    process.env["OWS_PASSPHRASE"] = "env-passphrase";
    const { resolvePassphrase } = await import("../../agent-wallet/passphrase.js");
    const result = await resolvePassphrase({ flag: "flag-passphrase" });
    expect(result).toBe("flag-passphrase");
  });

  it("env wins over stdin when flag is absent", async () => {
    process.env["OWS_PASSPHRASE"] = "env-passphrase";
    Object.defineProperty(process, "stdin", {
      value: { isTTY: true, on: () => {}, setEncoding: () => {} },
      configurable: true,
    });
    const { resolvePassphrase } = await import("../../agent-wallet/passphrase.js");
    const result = await resolvePassphrase({});
    expect(result).toBe("env-passphrase");
  });

  it("returns null when no credentials and stdin IS TTY (caller should prompt)", async () => {
    delete process.env["OWS_PASSPHRASE"];
    Object.defineProperty(process, "stdin", {
      value: { isTTY: true, on: () => {}, setEncoding: () => {} },
      configurable: true,
    });
    const { resolvePassphrase } = await import("../../agent-wallet/passphrase.js");
    const result = await resolvePassphrase({});
    expect(result).toBeNull();
  });

  it("throws PASSPHRASE_REQUIRED when no credentials and stdin is non-TTY with no data", async () => {
    delete process.env["OWS_PASSPHRASE"];
    const emptyStream = new Readable({ read() { this.push(null); } });
    Object.defineProperty(emptyStream, "isTTY", { value: false, configurable: true });
    Object.defineProperty(process, "stdin", { value: emptyStream, configurable: true });

    const { resolvePassphrase } = await import("../../agent-wallet/passphrase.js");
    await expect(resolvePassphrase({})).rejects.toMatchObject({
      structured: expect.objectContaining({ code: "PASSPHRASE_REQUIRED" }),
    });
  });

  it("reads passphrase from non-TTY stdin pipe", async () => {
    delete process.env["OWS_PASSPHRASE"];

    // Build a Readable that emits a Buffer chunk then ends
    const pipedStream = new Readable({ read() {} });
    Object.defineProperty(pipedStream, "isTTY", { value: false, configurable: true });

    // Push data synchronously before the listeners attach is fine for Readable
    // but we need to push after the stream is consumed; use setImmediate trick.
    setImmediate(() => {
      pipedStream.push(Buffer.from("piped-passphrase\n"));
      pipedStream.push(null);
    });

    Object.defineProperty(process, "stdin", { value: pipedStream, configurable: true });

    const { resolvePassphrase } = await import("../../agent-wallet/passphrase.js");
    const result = await resolvePassphrase({});
    expect(result).toBe("piped-passphrase");
  });
});
