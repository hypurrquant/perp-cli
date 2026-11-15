import { vi } from "vitest";

/** A stub `fetch` that never answers on its own — it only settles (rejects) when its signal aborts. */
export function hangingFetch(): ReturnType<typeof vi.fn> {
  return vi.fn((_input: unknown, init?: { signal?: AbortSignal }) => new Promise<Response>((_res, rej) => {
    init?.signal?.addEventListener("abort", () => rej(init.signal!.reason));
  }));
}
