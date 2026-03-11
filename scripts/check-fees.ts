import { getCctpQuote } from "../src/bridge-engine.ts";

async function main() {
  console.log("=== Standard (forwarding, dst=EVM) ===");
  for (const amt of [10, 100, 1000, 10000]) {
    const q = await getCctpQuote("arbitrum", "base", amt);
    console.log(`  $${amt}: fee=$${q.fee.toFixed(4)}, out=$${q.amountOut.toFixed(4)}, gasIncluded=${q.gasIncluded}`);
  }

  console.log("\n=== Fast (forwarding, dst=EVM) ===");
  for (const amt of [10, 100, 1000, 10000]) {
    const q = await getCctpQuote("arbitrum", "base", amt, true);
    console.log(`  $${amt}: fee=$${q.fee.toFixed(4)}, out=$${q.amountOut.toFixed(4)}`);
  }

  console.log("\n=== Standard (no forwarding, dst=Solana) ===");
  for (const amt of [10, 100, 1000]) {
    const q = await getCctpQuote("arbitrum", "solana", amt);
    console.log(`  $${amt}: fee=$${q.fee.toFixed(4)}, out=$${q.amountOut.toFixed(4)}, gasIncluded=${q.gasIncluded}`);
  }

  console.log("\n=== Fast (no forwarding, dst=Solana) ===");
  for (const amt of [10, 100, 1000]) {
    const q = await getCctpQuote("arbitrum", "solana", amt, true);
    console.log(`  $${amt}: fee=$${q.fee.toFixed(4)}, out=$${q.amountOut.toFixed(4)}`);
  }
}
main();
