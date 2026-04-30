// Install a stderr filter that drops known noisy SDK warnings when --json
// or --ndjson is set. Module body runs at import time — must be the FIRST
// import in src/index.ts so it activates before SDK module bodies.

if (process.argv.includes("--json") || process.argv.includes("--ndjson")) {
  const _suppressPatterns = [
    /'--chain evm' is deprecated/,
    /\[hyperliquid\] Failed to load asset map/,
    /\[lighter\] Account index not available/,
    /Failed to initialize SymbolConversion/,
    /HyperliquidAPIError/,
  ];
  // Wrap at the lowest level (_write on the Writable) so we catch writes
  // even if a downstream module replaces process.stderr.write itself.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stderr = process.stderr as any;
  const _origStderrWriteRaw = stderr._write.bind(stderr);
  stderr._write = function (chunk: unknown, encoding: BufferEncoding, callback: (err?: Error | null) => void): void {
    const s = typeof chunk === "string"
      ? chunk
      : (chunk instanceof Uint8Array || Buffer.isBuffer(chunk))
        ? Buffer.from(chunk as Uint8Array).toString()
        : "";
    if (_suppressPatterns.some(re => re.test(s))) {
      callback();
      return;
    }
    return _origStderrWriteRaw(chunk, encoding, callback);
  };
}
