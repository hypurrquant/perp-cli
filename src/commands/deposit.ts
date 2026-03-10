import { Command } from "commander";
import chalk from "chalk";
import { printJson, formatUsd, jsonOk } from "../utils.js";
import type { ExchangeAdapter } from "../exchanges/interface.js";
import { PacificaAdapter } from "../exchanges/pacifica.js";
import type { Network } from "../pacifica/index.js";
import { logExecution } from "../execution-log.js";

const DEFAULT_RELAYER = "http://localhost:3100";

function getRelayerUrl(): string {
  return process.env.PERP_RELAYER_URL || DEFAULT_RELAYER;
}

async function relayerAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${getRelayerUrl()}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

export function registerDepositCommands(
  program: Command,
  getAdapter: () => Promise<ExchangeAdapter>,
  isJson: () => boolean,
  getNetwork: () => Network
) {
  const deposit = program.command("deposit").description("Deposit funds into exchange accounts");

  // ── Pacifica (Solana) ──

  deposit
    .command("pacifica <amount>")
    .description("Deposit USDC into Pacifica")
    .option("--no-relay", "Skip relayer, pay gas yourself")
    .action(async (amount: string, opts: { relay: boolean }) => {
      const amountNum = parseFloat(amount);
      if (isNaN(amountNum) || amountNum <= 0) throw new Error("Invalid amount");

      // Try relayer first (gas-sponsored)
      if (opts.relay && await relayerAvailable()) {
        if (!isJson()) console.log(chalk.cyan(`\n  Depositing $${formatUsd(amountNum)} via relayer (gasless)...\n`));

        const adapter = await getAdapter();
        if (!(adapter instanceof PacificaAdapter)) throw new Error("Requires --exchange pacifica");

        try {
          // 1. Get sponsored TX from relayer
          const buildRes = await fetch(`${getRelayerUrl()}/deposit/pacifica/build`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              userPubkey: adapter.keypair.publicKey.toBase58(),
              amount: amountNum,
              testnet: getNetwork() === "testnet",
            }),
          });

          if (!buildRes.ok) {
            const err = await buildRes.json() as Record<string, string>;
            throw new Error(err.error || "Relayer build failed");
          }

          const { transaction, fee, netAmount } = (await buildRes.json()) as {
            transaction: string; fee: number; netAmount: number;
          };

          if (!isJson()) {
            console.log(`  Fee:       $${formatUsd(fee)} (gas sponsored)`);
            console.log(`  Net:       $${formatUsd(netAmount)} to Pacifica\n`);
          }

          // 2. User signs the TX
          const { Transaction } = await import("@solana/web3.js");
          const tx = Transaction.from(Buffer.from(transaction, "base64"));
          tx.partialSign(adapter.keypair);
          const signed = tx.serialize().toString("base64");

          // 3. Submit via relayer
          const submitRes = await fetch(`${getRelayerUrl()}/deposit/pacifica/submit`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              signedTransaction: signed,
              testnet: getNetwork() === "testnet",
            }),
          });

          if (!submitRes.ok) {
            const err = await submitRes.json() as Record<string, string>;
            throw new Error(err.error || "Submit failed");
          }

          const result = (await submitRes.json()) as { signature: string };

          logExecution({
            type: "bridge", exchange: "pacifica", symbol: "USDC", side: "deposit",
            size: String(amountNum), status: "success", dryRun: false,
            meta: { action: "deposit", method: "relay", signature: result.signature },
          });

          if (isJson()) return printJson(jsonOk({ ...result, fee, netAmount, method: "relay" }));
          console.log(chalk.green(`  Deposit confirmed!`));
          console.log(`  Signature: ${result.signature}`);
          console.log(chalk.gray(`\n  Gas: FREE (relayer sponsored)\n`));
          return;
        } catch (err) {
          logExecution({
            type: "bridge", exchange: "pacifica", symbol: "USDC", side: "deposit",
            size: String(amountNum), status: "failed", dryRun: false,
            error: err instanceof Error ? err.message : String(err),
            meta: { action: "deposit", method: "relay" },
          });
          throw err;
        }
      }

      // Fallback: direct deposit (user pays gas)
      if (!isJson()) {
        console.log(chalk.cyan(`\n  Depositing $${formatUsd(amountNum)} USDC into Pacifica...\n`));
        console.log(chalk.gray("  Requires: SOL for gas (~0.005 SOL) + USDC on Solana\n"));
      }

      const adapter = await getAdapter();
      if (!(adapter instanceof PacificaAdapter)) throw new Error("Requires --exchange pacifica");

      if (amountNum < 10) throw new Error("Minimum deposit is 10 USDC");

      try {
        const { Connection, Transaction } = await import("@solana/web3.js");
        const { buildDepositInstruction } = await import("../pacifica/deposit.js");
        const network = getNetwork();
        const rpcUrl = network === "testnet" ? "https://api.devnet.solana.com" : "https://api.mainnet-beta.solana.com";
        const connection = new Connection(rpcUrl, "confirmed");

        const solBalance = await connection.getBalance(adapter.keypair.publicKey);
        if (solBalance < 5_000_000) {
          console.error(chalk.red("  Insufficient SOL for gas. Need ~0.005 SOL."));
          console.error(chalk.gray("  Tip: Use relayer for gasless deposits (start relayer server)\n"));
          process.exit(1);
        }

        const ix = await buildDepositInstruction(adapter.keypair.publicKey, amountNum, network);
        const tx = new Transaction().add(ix);
        tx.feePayer = adapter.keypair.publicKey;
        tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
        tx.sign(adapter.keypair);

        const sig = await connection.sendRawTransaction(tx.serialize());
        await connection.confirmTransaction(sig, "confirmed");

        logExecution({
          type: "bridge", exchange: "pacifica", symbol: "USDC", side: "deposit",
          size: String(amountNum), status: "success", dryRun: false,
          meta: { action: "deposit", method: "direct", signature: sig },
        });

        if (isJson()) return printJson(jsonOk({ signature: sig, amount: amountNum, method: "direct" }));
        console.log(chalk.green(`  Deposit confirmed!`));
        console.log(`  Amount:    $${formatUsd(amountNum)} USDC`);
        console.log(`  Signature: ${sig}\n`);
      } catch (err) {
        logExecution({
          type: "bridge", exchange: "pacifica", symbol: "USDC", side: "deposit",
          size: String(amountNum), status: "failed", dryRun: false,
          error: err instanceof Error ? err.message : String(err),
          meta: { action: "deposit", method: "direct" },
        });
        throw err;
      }
    });

  // ── Hyperliquid (Arbitrum — USDC transfer to Bridge2) ──

  deposit
    .command("hyperliquid <amount>")
    .description("Deposit USDC into Hyperliquid (Arbitrum)")
    .option("--no-relay", "Skip relayer, pay gas yourself")
    .action(async (amount: string, opts: { relay: boolean }) => {
      const amountNum = parseFloat(amount);
      if (isNaN(amountNum) || amountNum <= 0) throw new Error("Invalid amount");
      if (amountNum < 5) throw new Error("Minimum deposit is $5 for Hyperliquid");

      // Try relayer
      if (opts.relay && await relayerAvailable()) {
        if (!isJson()) console.log(chalk.cyan(`\n  Depositing $${formatUsd(amountNum)} via relayer (gasless)...\n`));

        const { ethers } = await import("ethers");
        const { loadPrivateKey } = await import("../config.js");
        const pk = await loadPrivateKey("hyperliquid");
        const wallet = new ethers.Wallet(pk);

        try {
          const res = await fetch(`${getRelayerUrl()}/deposit/hyperliquid`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ userAddress: wallet.address, amount: amountNum }),
          });

          const result = (await res.json()) as Record<string, unknown>;
          if (!res.ok) throw new Error(String(result.error || "Relayer failed"));

          logExecution({
            type: "bridge", exchange: "hyperliquid", symbol: "USDC", side: "deposit",
            size: String(amountNum), status: "success", dryRun: false,
            meta: { action: "deposit", method: "relay", txHash: String(result.txHash) },
          });

          if (isJson()) return printJson(jsonOk({ ...result, method: "relay" }));
          console.log(chalk.green(`  Deposit confirmed!`));
          console.log(`  TX Hash: ${result.txHash}`);
          console.log(`  Fee:     $${formatUsd(Number(result.fee))}`);
          console.log(`  Net:     $${formatUsd(Number(result.netAmount))}`);
          console.log(chalk.gray(`\n  Gas: FREE (relayer sponsored)\n`));
          return;
        } catch (err) {
          logExecution({
            type: "bridge", exchange: "hyperliquid", symbol: "USDC", side: "deposit",
            size: String(amountNum), status: "failed", dryRun: false,
            error: err instanceof Error ? err.message : String(err),
            meta: { action: "deposit", method: "relay" },
          });
          throw err;
        }
      }

      // Direct: USDC.transfer() to HL Bridge2
      if (!isJson()) {
        console.log(chalk.cyan(`\n  Depositing $${formatUsd(amountNum)} USDC into Hyperliquid...\n`));
        console.log(chalk.gray("  Requires: ETH on Arbitrum for gas (~0.0001 ETH) + USDC on Arbitrum\n"));
      }

      const { ethers } = await import("ethers");
      const { loadPrivateKey } = await import("../config.js");
      const pk = await loadPrivateKey("hyperliquid");
      const provider = new ethers.JsonRpcProvider("https://arb1.arbitrum.io/rpc");
      const wallet = new ethers.Wallet(pk, provider);

      const HL_BRIDGE = "0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7";
      const USDC_ARB = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";

      // Check balances
      const ethBal = await provider.getBalance(wallet.address);
      if (ethBal < ethers.parseEther("0.0001")) {
        console.error(chalk.red("  Insufficient ETH on Arbitrum for gas."));
        process.exit(1);
      }

      const usdc = new ethers.Contract(USDC_ARB, [
        "function transfer(address to, uint256 amount) returns (bool)",
        "function balanceOf(address) view returns (uint256)",
      ], wallet);

      const amountRaw = ethers.parseUnits(amount, 6);
      const usdcBal = await usdc.balanceOf(wallet.address);
      if (usdcBal < amountRaw) {
        console.error(chalk.red(`  Insufficient USDC. Have: $${formatUsd(Number(ethers.formatUnits(usdcBal, 6)))}`));
        process.exit(1);
      }

      try {
        // Direct USDC transfer to HL Bridge2 (simplest method)
        if (!isJson()) console.log(chalk.gray("  Sending USDC to Hyperliquid Bridge2..."));
        const tx = await usdc.transfer(HL_BRIDGE, amountRaw);
        const receipt = await tx.wait();

        logExecution({
          type: "bridge", exchange: "hyperliquid", symbol: "USDC", side: "deposit",
          size: String(amountNum), status: "success", dryRun: false,
          meta: { action: "deposit", method: "direct", txHash: receipt.hash },
        });

        if (isJson()) return printJson(jsonOk({ txHash: receipt.hash, amount: amountNum, method: "direct" }));
        console.log(chalk.green(`  Deposit confirmed!`));
        console.log(`  Amount:  $${formatUsd(amountNum)} USDC`);
        console.log(`  TX Hash: ${receipt.hash}`);
        console.log(chalk.gray(`\n  Funds appear in ~1-3 minutes.\n`));
      } catch (err) {
        logExecution({
          type: "bridge", exchange: "hyperliquid", symbol: "USDC", side: "deposit",
          size: String(amountNum), status: "failed", dryRun: false,
          error: err instanceof Error ? err.message : String(err),
          meta: { action: "deposit", method: "direct" },
        });
        throw err;
      }
    });

  // ── Lighter ──

  const lighterDeposit = deposit.command("lighter").description("Deposit USDC into Lighter");

  // Lighter via Ethereum L1 (min 1 USDC)
  lighterDeposit
    .command("ethereum <amount>")
    .description("Deposit USDC via Ethereum L1 (min 1 USDC, gas: $3-10+)")
    .option("--asset-id <id>", "Asset index (default: 2 = USDC)", "2")
    .option("--route <type>", "Route: 0=perps, 1=spot (default: 0)", "0")
    .action(async (amount: string, opts: { assetId: string; route: string }) => {
      const amountNum = parseFloat(amount);
      if (isNaN(amountNum) || amountNum <= 0) throw new Error("Invalid amount");
      if (amountNum < 1) throw new Error("Minimum deposit via Ethereum is 1 USDC");

      if (!isJson()) {
        console.log(chalk.cyan(`\n  Depositing $${formatUsd(amountNum)} USDC into Lighter via Ethereum L1...\n`));
        console.log(chalk.yellow("  Warning: Ethereum L1 gas fees may be high ($3-10+)\n"));
      }

      const { ethers } = await import("ethers");
      const { loadPrivateKey } = await import("../config.js");
      const pk = await loadPrivateKey("lighter");
      const provider = new ethers.JsonRpcProvider("https://eth.llamarpc.com");
      const wallet = new ethers.Wallet(pk, provider);

      const LIGHTER_CONTRACT = "0x3B4D794a66304f130a4db8f2551b0070dfcf5ca7";
      const USDC_ETH = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

      const usdc = new ethers.Contract(USDC_ETH, [
        "function approve(address spender, uint256 amount) returns (bool)",
        "function allowance(address owner, address spender) view returns (uint256)",
        "function balanceOf(address) view returns (uint256)",
      ], wallet);

      const lighter = new ethers.Contract(LIGHTER_CONTRACT, [
        "function deposit(address _to, uint8 _assetIndex, uint8 _routeType, uint256 _amount) payable",
      ], wallet);

      const amountRaw = ethers.parseUnits(amount, 6);

      // Check USDC balance
      const usdcBal = await usdc.balanceOf(wallet.address);
      if (usdcBal < amountRaw) {
        console.error(chalk.red(`  Insufficient USDC on Ethereum. Have: $${formatUsd(Number(ethers.formatUnits(usdcBal, 6)))}`));
        process.exit(1);
      }

      // Approve if needed
      const allowance = await usdc.allowance(wallet.address, LIGHTER_CONTRACT);
      if (allowance < amountRaw) {
        if (!isJson()) console.log(chalk.gray("  Approving USDC for Lighter..."));
        const approveTx = await usdc.approve(LIGHTER_CONTRACT, amountRaw);
        await approveTx.wait();
        if (!isJson()) console.log(chalk.gray("  Approved."));
      }

      // Call deposit(address _to, uint8 _assetIndex, uint8 _routeType, uint256 _amount)
      if (!isJson()) console.log(chalk.gray("  Calling deposit()..."));
      try {
        const tx = await lighter.deposit(
          wallet.address,
          parseInt(opts.assetId),
          parseInt(opts.route),
          amountRaw,
        );
        const receipt = await tx.wait();

        logExecution({
          type: "bridge", exchange: "lighter", symbol: "USDC", side: "deposit",
          size: String(amountNum), status: "success", dryRun: false,
          meta: { action: "deposit", method: "ethereum", txHash: receipt.hash },
        });

        if (isJson()) return printJson(jsonOk({ txHash: receipt.hash, amount: amountNum, chain: "ethereum", method: "direct" }));
        console.log(chalk.green(`\n  Deposit confirmed!`));
        console.log(`  Amount:  $${formatUsd(amountNum)} USDC`);
        console.log(`  TX Hash: ${receipt.hash}`);
        console.log(chalk.gray(`\n  Funds appear in your Lighter perps account shortly.\n`));
      } catch (err) {
        logExecution({
          type: "bridge", exchange: "lighter", symbol: "USDC", side: "deposit",
          size: String(amountNum), status: "failed", dryRun: false,
          error: err instanceof Error ? err.message : String(err),
          meta: { action: "deposit", method: "ethereum" },
        });
        throw err;
      }
    });

  // Lighter via CCTP (Arbitrum, Base, Avalanche — min 5 USDC)
  const CCTP_CHAINS: Record<string, { chainId: number; rpc: string; usdc: string; name: string }> = {
    arbitrum: { chainId: 42161, rpc: "https://arb1.arbitrum.io/rpc", usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", name: "Arbitrum" },
    base:     { chainId: 8453,  rpc: "https://mainnet.base.org",    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", name: "Base" },
    avalanche:{ chainId: 43114, rpc: "https://api.avax.network/ext/bc/C/rpc", usdc: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E", name: "Avalanche" },
  };

  lighterDeposit
    .command("cctp <chain> <amount>")
    .description("Deposit USDC via CCTP (arbitrum, base, avalanche — min 5 USDC)")
    .action(async (chain: string, amount: string) => {
      const amountNum = parseFloat(amount);
      if (isNaN(amountNum) || amountNum <= 0) throw new Error("Invalid amount");
      if (amountNum < 5) throw new Error("Minimum CCTP deposit is 5 USDC");

      const chainKey = chain.toLowerCase();
      const chainInfo = CCTP_CHAINS[chainKey];
      if (!chainInfo) throw new Error(`Unsupported chain: ${chain}. Use: arbitrum, base, avalanche`);

      if (!isJson()) console.log(chalk.cyan(`\n  Depositing $${formatUsd(amountNum)} USDC into Lighter via CCTP (${chainInfo.name})...\n`));

      const { ethers } = await import("ethers");
      const { loadPrivateKey } = await import("../config.js");
      const pk = await loadPrivateKey("lighter");
      const provider = new ethers.JsonRpcProvider(chainInfo.rpc);
      const wallet = new ethers.Wallet(pk, provider);

      // 1. Create intent address via Lighter API
      if (!isJson()) console.log(chalk.gray("  Creating intent address..."));
      const intentRes = await fetch("https://mainnet.zklighter.elliot.ai/api/v1/createIntentAddress", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          chain_id: String(chainInfo.chainId),
          from_addr: wallet.address,
          amount: "0",
          is_external_deposit: "true",
        }),
      });

      if (!intentRes.ok) {
        const err = await intentRes.text();
        throw new Error(`Failed to create intent address: ${err}`);
      }

      const intentData = (await intentRes.json()) as Record<string, unknown>;
      const intentAddress = String(intentData.intent_address || intentData.address || "");
      if (!intentAddress) throw new Error("No intent address returned");

      if (!isJson()) console.log(`  Intent address: ${intentAddress}`);

      // 2. Check USDC balance
      const usdc = new ethers.Contract(chainInfo.usdc, [
        "function transfer(address to, uint256 amount) returns (bool)",
        "function balanceOf(address) view returns (uint256)",
      ], wallet);

      const amountRaw = ethers.parseUnits(amount, 6);
      const usdcBal = await usdc.balanceOf(wallet.address);
      if (usdcBal < amountRaw) {
        console.error(chalk.red(`  Insufficient USDC on ${chainInfo.name}. Have: $${formatUsd(Number(ethers.formatUnits(usdcBal, 6)))}`));
        process.exit(1);
      }

      // 3. Transfer USDC to intent address
      if (!isJson()) console.log(chalk.gray(`  Sending USDC to intent address on ${chainInfo.name}...`));
      try {
        const tx = await usdc.transfer(intentAddress, amountRaw);
        const receipt = await tx.wait();

        logExecution({
          type: "bridge", exchange: "lighter", symbol: "USDC", side: "deposit",
          size: String(amountNum), status: "success", dryRun: false,
          meta: { action: "deposit", method: "cctp", chain: chainKey, txHash: receipt.hash },
        });

        if (isJson()) return printJson(jsonOk({ txHash: receipt.hash, amount: amountNum, chain: chainKey, intentAddress, method: "cctp" }));
        console.log(chalk.green(`\n  USDC sent to intent address!`));
        console.log(`  Amount:  $${formatUsd(amountNum)} USDC`);
        console.log(`  TX Hash: ${receipt.hash}`);
        console.log(`  Chain:   ${chainInfo.name}`);
        console.log(chalk.gray(`\n  CCTP bridging takes ~1-3 minutes. Funds will appear in Lighter automatically.\n`));
      } catch (err) {
        logExecution({
          type: "bridge", exchange: "lighter", symbol: "USDC", side: "deposit",
          size: String(amountNum), status: "failed", dryRun: false,
          error: err instanceof Error ? err.message : String(err),
          meta: { action: "deposit", method: "cctp", chain: chainKey },
        });
        throw err;
      }
    });

  // Lighter deposit info
  lighterDeposit
    .command("info")
    .description("Show Lighter deposit routes & minimums")
    .action(async () => {
      if (isJson()) {
        return printJson(jsonOk({
          routes: {
            ethereum: { min: "1 USDC", gas: "$3-10+", method: "deposit() on L1 contract" },
            arbitrum: { min: "5 USDC", gas: "~$0.01", method: "CCTP via intent address" },
            base:     { min: "5 USDC", gas: "~$0.01", method: "CCTP via intent address" },
            avalanche:{ min: "5 USDC", gas: "~$0.01", method: "CCTP via intent address" },
          },
          contract: "0x3B4D794a66304f130a4db8f2551b0070dfcf5ca7",
        }));
      }

      console.log(chalk.cyan.bold("\n  Lighter Deposit Routes\n"));

      console.log(chalk.white.bold("  Ethereum L1") + chalk.gray(" (direct)"));
      console.log(`  Min: 1 USDC  |  Gas: $3-10+`);
      console.log(`  Command: ${chalk.green("perp deposit lighter ethereum <amount>")}`);

      console.log(chalk.white.bold("\n  Arbitrum") + chalk.gray(" (CCTP)"));
      console.log(`  Min: 5 USDC  |  Gas: ~$0.01`);
      console.log(`  Command: ${chalk.green("perp deposit lighter cctp arbitrum <amount>")}`);

      console.log(chalk.white.bold("\n  Base") + chalk.gray(" (CCTP)"));
      console.log(`  Min: 5 USDC  |  Gas: ~$0.01`);
      console.log(`  Command: ${chalk.green("perp deposit lighter cctp base <amount>")}`);

      console.log(chalk.white.bold("\n  Avalanche") + chalk.gray(" (CCTP)"));
      console.log(`  Min: 5 USDC  |  Gas: ~$0.01`);
      console.log(`  Command: ${chalk.green("perp deposit lighter cctp avalanche <amount>")}`);
      console.log();
    });

  // ── CCTP Bridge ──

  deposit
    .command("bridge")
    .description("Bridge USDC between chains via CCTP V2")
    .requiredOption("--from <chain>", "Source chain (arbitrum, ethereum)")
    .requiredOption("--to <chain>", "Destination chain (arbitrum, ethereum, solana)")
    .requiredOption("--amount <amount>", "USDC amount")
    .requiredOption("--recipient <address>", "Recipient address on destination chain")
    .action(async (opts: { from: string; to: string; amount: string; recipient: string }) => {
      const amountNum = parseFloat(opts.amount);

      if (await relayerAvailable()) {
        if (!isJson()) console.log(chalk.cyan(`\n  Bridging $${formatUsd(amountNum)} USDC via CCTP V2 (${opts.from} → ${opts.to})...\n`));

        const res = await fetch(`${getRelayerUrl()}/bridge/cctp`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            fromChain: opts.from,
            toChain: opts.to,
            amount: amountNum,
            recipient: opts.recipient,
          }),
        });

        const result = (await res.json()) as Record<string, unknown>;
        if (!res.ok) throw new Error(String(result.error || "CCTP bridge failed"));

        if (isJson()) return printJson(jsonOk(result));
        console.log(chalk.green(`  Burn TX submitted!`));
        console.log(`  TX Hash:      ${result.txHash}`);
        console.log(`  Message Hash: ${result.messageHash}`);
        console.log(chalk.gray(`\n  Waiting for Circle attestation (~1-3 min)...`));
        console.log(chalk.gray(`  Check: perp deposit bridge-status --hash ${result.messageHash}\n`));
      } else {
        console.error(chalk.red("\n  CCTP bridge requires relayer server."));
        console.error(chalk.gray("  Start: cd packages/relayer && pnpm start\n"));
      }
    });

  deposit
    .command("bridge-status")
    .description("Check CCTP bridge status")
    .requiredOption("--hash <messageHash>", "Message hash from bridge TX")
    .action(async (opts: { hash: string }) => {
      const res = await fetch(`${getRelayerUrl()}/bridge/cctp/status/${opts.hash}`);
      const result = (await res.json()) as Record<string, unknown>;

      if (isJson()) return printJson(jsonOk(result));
      console.log(chalk.cyan.bold("\n  CCTP Bridge Status\n"));
      console.log(`  Status:      ${result.status === "complete" ? chalk.green("complete") : chalk.yellow(String(result.status))}`);
      if (result.attestation) console.log(`  Attestation: ${chalk.gray("received")}`);
      console.log();
    });

  // ── Info ──

  deposit
    .command("info")
    .description("Show deposit instructions & gas requirements")
    .action(async () => {
      const hasRelay = await relayerAvailable();

      if (isJson()) {
        return printJson(jsonOk({
          relayer: hasRelay ? getRelayerUrl() : null,
          exchanges: {
            pacifica: { chain: "Solana", token: "USDC", min: 10, gas: "SOL ~0.005", method: "on-chain program" },
            hyperliquid: { chain: "Arbitrum", token: "USDC", min: 5, gas: "ETH ~0.0001", method: "USDC transfer to Bridge2" },
            lighter: { chain: "Ethereum L1 / Arbitrum / Base / Avalanche", token: "USDC", min: "1 (L1) or 5 (CCTP)", gas: "$3-10 (L1), ~$0.01 (CCTP)", method: "deposit() or CCTP intent" },
          },
        }));
      }

      console.log(chalk.cyan.bold("\n  Deposit Instructions\n"));

      if (hasRelay) {
        console.log(chalk.green("  ✓ Relayer available — gas-free deposits!\n"));
      } else {
        console.log(chalk.yellow("  ⚠ Relayer offline — deposits will cost gas.\n"));
        console.log(chalk.gray("    Start relayer: cd packages/relayer && pnpm start\n"));
      }

      console.log(chalk.white.bold("  Pacifica") + chalk.gray(" (Solana)"));
      console.log(`  Token:   USDC  |  Min: $10  |  Gas: ${hasRelay ? chalk.green("FREE") : "SOL ~0.005"}`);
      console.log(`  Command: ${chalk.green("perp deposit pacifica <amount>")}`);

      console.log(chalk.white.bold("\n  Hyperliquid") + chalk.gray(" (Arbitrum)"));
      console.log(`  Token:   USDC  |  Min: $5   |  Gas: ${hasRelay ? chalk.green("FREE") : "ETH ~0.0001"}`);
      console.log(`  Method:  USDC transfer to Bridge2`);
      console.log(`  Command: ${chalk.green("perp deposit hyperliquid <amount>")}`);

      console.log(chalk.white.bold("\n  Lighter") + chalk.gray(" (Ethereum L1 / CCTP)"));
      console.log(`  Token:   USDC  |  Min: 1 (L1), 5 (CCTP)`);
      console.log(`  L1:      ${chalk.green("perp deposit lighter ethereum <amount>")} — gas $3-10+`);
      console.log(`  CCTP:    ${chalk.green("perp deposit lighter cctp <chain> <amount>")} — gas ~$0.01`);
      console.log(`  Chains:  arbitrum, base, avalanche`);
      console.log(`  Info:    ${chalk.green("perp deposit lighter info")}`);

      console.log(chalk.white.bold("\n  CCTP Bridge") + chalk.gray(" (Cross-chain USDC)"));
      console.log(`  Routes:  Arbitrum ↔ Ethereum ↔ Solana`);
      console.log(`  Command: ${chalk.green("perp deposit bridge --from arbitrum --to solana --amount 100 --recipient <addr>")}`);

      console.log(chalk.gray("\n  Use --no-relay to skip relayer and pay gas yourself.\n"));
    });
}
