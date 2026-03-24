import { Command } from "commander";
import chalk from "chalk";
import { printJson, formatUsd, jsonOk, jsonError } from "../utils.js";
import type { ExchangeAdapter } from "../exchanges/index.js";
import type { Network } from "../pacifica/index.js";
import { logExecution } from "../execution-log.js";
import { hasPacificaSdk, hasEvmAddress, isWithdrawCapable, isUsdTransferCapable, hasLighterAccount } from "../exchanges/capabilities.js";

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

export function registerFundsCommands(
  program: Command,
  getAdapter: () => Promise<ExchangeAdapter>,
  isJson: () => boolean,
  getNetwork: () => Network
) {
  const funds = program.command("funds").description("Deposit, withdraw, bridge & transfer funds");

  // ═══════════════════════════════════════════════════════
  //  DEPOSIT
  // ═══════════════════════════════════════════════════════

  const deposit = funds.command("deposit").description("Deposit funds into exchange accounts");

  // ── Pacifica (Solana) ──

  deposit
    .command("pacifica <amount>")
    .description("Deposit USDC into Pacifica")
    .option("--no-relay", "Skip relayer, pay gas yourself")
    .action(async (amount: string, opts: { relay: boolean }) => {
      const amountNum = parseFloat(amount);
      if (isNaN(amountNum) || amountNum <= 0) throw new Error("Invalid amount");
      if (amountNum < 10) throw new Error("Minimum deposit is 10 USDC");

      // Try relayer first (gas-sponsored)
      if (opts.relay && await relayerAvailable()) {
        if (!isJson()) console.log(chalk.cyan(`\n  Depositing $${formatUsd(amountNum)} via relayer (gasless)...\n`));

        const adapter = await getAdapter();
        if (adapter.name !== "pacifica") throw new Error("Requires --exchange pacifica");
        const { PacificaAdapter } = await import("../exchanges/pacifica.js");
        const pacAdapter = adapter as InstanceType<typeof PacificaAdapter>;

        try {
          const buildRes = await fetch(`${getRelayerUrl()}/deposit/pacifica/build`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              userPubkey: pacAdapter.keypair.publicKey.toBase58(),
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

          const { Transaction } = await import("@solana/web3.js");
          const tx = Transaction.from(Buffer.from(transaction, "base64"));
          tx.partialSign(pacAdapter.keypair);
          const signed = tx.serialize().toString("base64");

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
      if (adapter.name !== "pacifica") throw new Error("Requires --exchange pacifica");
      const { PacificaAdapter: PacAdapterCls } = await import("../exchanges/pacifica.js");
      const pacDirect = adapter as InstanceType<typeof PacAdapterCls>;

      try {
        const { Connection, Transaction } = await import("@solana/web3.js");
        const { buildDepositInstruction } = await import("../pacifica/deposit.js");
        const network = getNetwork();
        const rpcUrl = network === "testnet" ? "https://api.devnet.solana.com" : "https://api.mainnet-beta.solana.com";
        const connection = new Connection(rpcUrl, "confirmed");

        const solBalance = await connection.getBalance(pacDirect.keypair.publicKey);
        if (solBalance < 5_000_000) {
          if (isJson()) {
            printJson(jsonError("INSUFFICIENT_BALANCE", "Insufficient SOL for gas. Need ~0.005 SOL."));
          } else {
            console.error(chalk.red("  Insufficient SOL for gas. Need ~0.005 SOL."));
            console.error(chalk.gray("  Tip: Use relayer for gasless deposits (start relayer server)\n"));
          }
          process.exit(1);
        }

        const { PublicKey } = await import("@solana/web3.js");
        const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
        const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
          pacDirect.keypair.publicKey, { mint: USDC_MINT }
        );
        const usdcBalance = tokenAccounts.value.length > 0
          ? tokenAccounts.value[0].account.data.parsed.info.tokenAmount.uiAmount ?? 0
          : 0;
        if (usdcBalance < amountNum) {
          if (isJson()) {
            printJson(jsonError("INSUFFICIENT_BALANCE", `Insufficient USDC on Solana. Have: $${formatUsd(usdcBalance)}, need: $${formatUsd(amountNum)}`));
          } else {
            console.error(chalk.red(`  Insufficient USDC on Solana. Have: $${formatUsd(usdcBalance)}, need: $${formatUsd(amountNum)}`));
          }
          process.exit(1);
        }

        const ix = await buildDepositInstruction(pacDirect.keypair.publicKey, amountNum, network);
        const tx = new Transaction().add(ix);
        tx.feePayer = pacDirect.keypair.publicKey;
        tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
        tx.sign(pacDirect.keypair);

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
        let pk: string;
        try {
          pk = await loadPrivateKey("hyperliquid");
        } catch (err) {
          throw new Error(`Private key not configured for Hyperliquid. Run: perp setup`);
        }
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

      const ethBal = await provider.getBalance(wallet.address);
      if (ethBal < ethers.parseEther("0.0001")) {
        if (isJson()) {
          printJson(jsonError("INSUFFICIENT_BALANCE", "Insufficient ETH on Arbitrum for gas."));
        } else {
          console.error(chalk.red("  Insufficient ETH on Arbitrum for gas."));
        }
        process.exit(1);
      }

      const usdc = new ethers.Contract(USDC_ARB, [
        "function transfer(address to, uint256 amount) returns (bool)",
        "function balanceOf(address) view returns (uint256)",
      ], wallet);

      const amountRaw = ethers.parseUnits(amount, 6);
      const usdcBal = await usdc.balanceOf(wallet.address);
      if (usdcBal < amountRaw) {
        if (isJson()) {
          printJson(jsonError("INSUFFICIENT_BALANCE", `Insufficient USDC. Have: $${formatUsd(Number(ethers.formatUnits(usdcBal, 6)))}`));
        } else {
          console.error(chalk.red(`  Insufficient USDC. Have: $${formatUsd(Number(ethers.formatUnits(usdcBal, 6)))}`));
        }
        process.exit(1);
      }

      try {
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

      const ethBal = await provider.getBalance(wallet.address);
      if (ethBal < ethers.parseEther("0.003")) {
        if (isJson()) {
          printJson(jsonError("INSUFFICIENT_BALANCE", "Insufficient ETH on Ethereum for gas. Need ~0.003 ETH ($3+)."));
        } else {
          console.error(chalk.red("  Insufficient ETH on Ethereum for gas. Need ~0.003 ETH ($3+)."));
        }
        process.exit(1);
      }

      const usdcBal = await usdc.balanceOf(wallet.address);
      if (usdcBal < amountRaw) {
        if (isJson()) {
          printJson(jsonError("INSUFFICIENT_BALANCE", `Insufficient USDC on Ethereum. Have: $${formatUsd(Number(ethers.formatUnits(usdcBal, 6)))}`));
        } else {
          console.error(chalk.red(`  Insufficient USDC on Ethereum. Have: $${formatUsd(Number(ethers.formatUnits(usdcBal, 6)))}`));
        }
        process.exit(1);
      }

      const allowance = await usdc.allowance(wallet.address, LIGHTER_CONTRACT);
      if (allowance < amountRaw) {
        if (!isJson()) console.log(chalk.gray("  Approving USDC for Lighter..."));
        const approveTx = await usdc.approve(LIGHTER_CONTRACT, amountRaw);
        await approveTx.wait();
        if (!isJson()) console.log(chalk.gray("  Approved."));
      }

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

      const gasBal = await provider.getBalance(wallet.address);
      if (gasBal < ethers.parseEther("0.00005")) {
        if (isJson()) {
          printJson(jsonError("INSUFFICIENT_BALANCE", `Insufficient gas token on ${chainInfo.name}. Need native token for gas (~$0.01).`));
        } else {
          console.error(chalk.red(`  Insufficient gas token on ${chainInfo.name}. Need native token for gas (~$0.01).`));
        }
        process.exit(1);
      }

      const usdc = new ethers.Contract(chainInfo.usdc, [
        "function transfer(address to, uint256 amount) returns (bool)",
        "function balanceOf(address) view returns (uint256)",
      ], wallet);

      const amountRaw = ethers.parseUnits(amount, 6);
      const usdcBal = await usdc.balanceOf(wallet.address);
      if (usdcBal < amountRaw) {
        if (isJson()) {
          printJson(jsonError("INSUFFICIENT_BALANCE", `Insufficient USDC on ${chainInfo.name}. Have: $${formatUsd(Number(ethers.formatUnits(usdcBal, 6)))}`));
        } else {
          console.error(chalk.red(`  Insufficient USDC on ${chainInfo.name}. Have: $${formatUsd(Number(ethers.formatUnits(usdcBal, 6)))}`));
        }
        process.exit(1);
      }

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
      console.log(`  Command: ${chalk.green("perp funds deposit lighter ethereum <amount>")}`);

      console.log(chalk.white.bold("\n  Arbitrum") + chalk.gray(" (CCTP)"));
      console.log(`  Min: 5 USDC  |  Gas: ~$0.01`);
      console.log(`  Command: ${chalk.green("perp funds deposit lighter cctp arbitrum <amount>")}`);

      console.log(chalk.white.bold("\n  Base") + chalk.gray(" (CCTP)"));
      console.log(`  Min: 5 USDC  |  Gas: ~$0.01`);
      console.log(`  Command: ${chalk.green("perp funds deposit lighter cctp base <amount>")}`);

      console.log(chalk.white.bold("\n  Avalanche") + chalk.gray(" (CCTP)"));
      console.log(`  Min: 5 USDC  |  Gas: ~$0.01`);
      console.log(`  Command: ${chalk.green("perp funds deposit lighter cctp avalanche <amount>")}`);
      console.log();
    });

  // ═══════════════════════════════════════════════════════
  //  WITHDRAW
  // ═══════════════════════════════════════════════════════

  const withdraw = funds.command("withdraw").description("Withdraw funds from exchange accounts");

  // ── Pacifica ──

  withdraw
    .command("pacifica <amount>")
    .description("Withdraw USDC from Pacifica to your Solana wallet")
    .option("--to <address>", "Destination Solana address (default: your wallet)")
    .action(async (amount: string, opts: { to?: string }) => {
      const amountNum = parseFloat(amount);
      if (isNaN(amountNum) || amountNum <= 0) throw new Error("Invalid amount");

      const adapter = await getAdapter();
      if (!hasPacificaSdk(adapter) || !isWithdrawCapable(adapter)) throw new Error("Requires --exchange pacifica");

      const dest = opts.to || adapter.publicKey;

      if (!isJson()) {
        console.log(chalk.cyan(`\n  Withdrawing $${formatUsd(amountNum)} USDC from Pacifica...\n`));
        console.log(`  Destination: ${dest}`);
      }

      try {
        const result = await adapter.withdraw(String(amountNum), dest);

        logExecution({
          type: "bridge", exchange: "pacifica", symbol: "USDC", side: "withdraw",
          size: String(amountNum), status: "success", dryRun: false,
          meta: { action: "withdraw", destination: dest },
        });

        if (isJson()) return printJson(jsonOk(result));
        console.log(chalk.green(`\n  Withdrawal submitted!`));
        console.log(`  Amount: $${formatUsd(amountNum)} USDC`);
        console.log(chalk.gray(`\n  Funds arrive in your Solana wallet shortly.\n`));
      } catch (err) {
        logExecution({
          type: "bridge", exchange: "pacifica", symbol: "USDC", side: "withdraw",
          size: String(amountNum), status: "failed", dryRun: false,
          error: err instanceof Error ? err.message : String(err),
          meta: { action: "withdraw", destination: dest },
        });
        throw err;
      }
    });

  // ── Hyperliquid ──

  withdraw
    .command("hyperliquid <amount>")
    .description("Withdraw USDC from Hyperliquid to your Arbitrum wallet")
    .option("--to <address>", "Destination EVM address (default: your wallet)")
    .action(async (amount: string, opts: { to?: string }) => {
      const amountNum = parseFloat(amount);
      if (isNaN(amountNum) || amountNum <= 0) throw new Error("Invalid amount");

      const adapter = await getAdapter();
      if (adapter.name !== "hyperliquid" || !hasEvmAddress(adapter) || !isWithdrawCapable(adapter)) throw new Error("Requires --exchange hyperliquid");

      const dest = opts.to || adapter.address;

      if (!isJson()) {
        console.log(chalk.cyan(`\n  Withdrawing $${formatUsd(amountNum)} USDC from Hyperliquid...\n`));
        console.log(`  Destination: ${dest}`);
      }

      const balance = await adapter.getBalance();
      const available = Number(balance.available);
      if (amountNum > available) {
        if (isJson()) {
          printJson(jsonError("INSUFFICIENT_BALANCE", `Insufficient withdrawable balance. Available: $${formatUsd(available)}`));
        } else {
          console.error(chalk.red(`  Insufficient withdrawable balance. Available: $${formatUsd(available)}`));
        }
        process.exit(1);
      }

      try {
        const result = await adapter.withdraw(String(amountNum), dest);

        logExecution({
          type: "bridge", exchange: "hyperliquid", symbol: "USDC", side: "withdraw",
          size: String(amountNum), status: "success", dryRun: false,
          meta: { action: "withdraw", destination: dest },
        });

        if (isJson()) return printJson(jsonOk(result));
        console.log(chalk.green(`\n  Withdrawal submitted!`));
        console.log(`  Amount: $${formatUsd(amountNum)} USDC`);
        console.log(chalk.gray(`\n  Processing may take a few minutes.\n`));
      } catch (err) {
        logExecution({
          type: "bridge", exchange: "hyperliquid", symbol: "USDC", side: "withdraw",
          size: String(amountNum), status: "failed", dryRun: false,
          error: err instanceof Error ? err.message : String(err),
          meta: { action: "withdraw", destination: dest },
        });
        throw err;
      }
    });

  // ── Lighter ──

  withdraw
    .command("lighter <amount>")
    .description("Withdraw USDC from Lighter to your Ethereum L1 wallet")
    .option("--asset-id <id>", "Asset ID (default: 2 = USDC)", "2")
    .option("--route <type>", "Route type: 0=perp, 1=spot (default: 0)", "0")
    .action(async (amount: string, opts: { assetId: string; route: string }) => {
      const amountNum = parseFloat(amount);
      if (isNaN(amountNum) || amountNum <= 0) throw new Error("Invalid amount");

      const adapter = await getAdapter();
      if (!hasLighterAccount(adapter) || !isWithdrawCapable(adapter)) throw new Error("Requires --exchange lighter");

      if (!isJson()) {
        console.log(chalk.cyan(`\n  Withdrawing $${formatUsd(amountNum)} USDC from Lighter...\n`));
        console.log(`  Account Index: ${adapter.accountIndex}`);
        console.log(`  Address: ${adapter.address}`);
      }

      try {
        const result = await adapter.withdraw(String(amountNum), "", { assetId: parseInt(opts.assetId), routeType: parseInt(opts.route) });

        logExecution({
          type: "bridge", exchange: "lighter", symbol: "USDC", side: "withdraw",
          size: String(amountNum), status: "success", dryRun: false,
          meta: { action: "withdraw" },
        });

        if (isJson()) return printJson(jsonOk(result));
        console.log(chalk.green(`\n  Withdrawal submitted!`));
        console.log(`  Amount: $${formatUsd(amountNum)} USDC`);
        console.log(chalk.gray(`\n  Standard withdrawal takes ~12 hours. Use Lighter web for fast withdrawal.\n`));
      } catch (err) {
        logExecution({
          type: "bridge", exchange: "lighter", symbol: "USDC", side: "withdraw",
          size: String(amountNum), status: "failed", dryRun: false,
          error: err instanceof Error ? err.message : String(err),
          meta: { action: "withdraw" },
        });
        throw err;
      }
    });

  // ═══════════════════════════════════════════════════════
  //  TRANSFER (HL internal)
  // ═══════════════════════════════════════════════════════

  funds
    .command("transfer <amount> <destination>")
    .description("Transfer USDC between Hyperliquid accounts (internal, instant)")
    .action(async (amount: string, destination: string) => {
      const amountNum = parseFloat(amount);
      if (isNaN(amountNum) || amountNum <= 0) throw new Error("Invalid amount");

      const adapter = await getAdapter();
      if (!isUsdTransferCapable(adapter)) throw new Error("Requires --exchange hyperliquid");

      if (!isJson()) console.log(chalk.cyan(`\n  Transferring $${formatUsd(amountNum)} USDC to ${destination}...\n`));

      const result = await adapter.usdTransfer(amountNum, destination);

      if (isJson()) return printJson(jsonOk(result));
      console.log(chalk.green(`  Transfer complete!`));
      console.log(`  Amount: $${formatUsd(amountNum)} USDC`);
      console.log(`  To:     ${destination}\n`);
    });

  // ═══════════════════════════════════════════════════════
  //  BRIDGE (CCTP)
  // ═══════════════════════════════════════════════════════

  funds
    .command("bridge")
    .description("Bridge USDC between chains via CCTP V2. See also: perp bridge (deBridge DLN)")
    .requiredOption("--from <chain>", "Source chain (arbitrum, ethereum)")
    .requiredOption("--to <chain>", "Destination chain (arbitrum, ethereum, solana)")
    .requiredOption("--amount <amount>", "USDC amount")
    .requiredOption("--recipient <address>", "Recipient address on destination chain")
    .action(async (opts: { from: string; to: string; amount: string; recipient: string }) => {
      const amountNum = parseFloat(opts.amount);
      if (isNaN(amountNum) || amountNum <= 0) throw new Error("Invalid amount");

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
        console.log(chalk.gray(`  Check: perp funds bridge-status --hash ${result.messageHash}\n`));
      } else {
        if (isJson()) {
          printJson(jsonError("RELAYER_UNAVAILABLE", "CCTP bridge requires relayer server. Start: cd packages/relayer && pnpm start"));
          process.exit(1);
        }
        console.error(chalk.red("\n  CCTP bridge requires relayer server."));
        console.error(chalk.gray("  Start: cd packages/relayer && pnpm start\n"));
        process.exit(1);
      }
    });

  funds
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

  // ═══════════════════════════════════════════════════════
  //  INFO (combined deposit + withdraw)
  // ═══════════════════════════════════════════════════════

  funds
    .command("info")
    .description("Show deposit & withdrawal info, routes, and limits")
    .action(async () => {
      const hasRelay = await relayerAvailable();

      if (isJson()) {
        return printJson(jsonOk({
          relayer: hasRelay ? getRelayerUrl() : null,
          deposit: {
            pacifica: { chain: "Solana", token: "USDC", min: 10, gas: "SOL ~0.005", method: "on-chain program" },
            hyperliquid: { chain: "Arbitrum", token: "USDC", min: 5, gas: "ETH ~0.0001", method: "USDC transfer to Bridge2" },
            lighter: { chain: "Ethereum L1 / Arbitrum / Base / Avalanche", token: "USDC", min: "1 (L1) or 5 (CCTP)", gas: "$3-10 (L1), ~$0.01 (CCTP)", method: "deposit() or CCTP intent" },
          },
          withdraw: {
            pacifica: { chain: "Solana", token: "USDC", speed: "~10s", fee: "none" },
            hyperliquid: { chain: "Arbitrum", token: "USDC", speed: "minutes", fee: "$1" },
            lighter: { chain: "Ethereum L1", token: "USDC", speed: "~12 hours (standard), minutes (fast)", fee: "varies" },
          },
        }));
      }

      console.log(chalk.cyan.bold("\n  Funds — Deposit & Withdrawal Info\n"));

      if (hasRelay) {
        console.log(chalk.green("  ✓ Relayer available — gas-free deposits!\n"));
      } else {
        console.log(chalk.yellow("  ⚠ Relayer offline — deposits will cost gas.\n"));
        console.log(chalk.gray("    Start relayer: cd packages/relayer && pnpm start\n"));
      }

      // Deposit info
      console.log(chalk.white.bold("  ── Deposit ──\n"));

      console.log(chalk.white.bold("  Pacifica") + chalk.gray(" (Solana)"));
      console.log(`  Token:   USDC  |  Min: $10  |  Gas: ${hasRelay ? chalk.green("FREE") : "SOL ~0.005"}`);
      console.log(`  Command: ${chalk.green("perp funds deposit pacifica <amount>")}`);

      console.log(chalk.white.bold("\n  Hyperliquid") + chalk.gray(" (Arbitrum)"));
      console.log(`  Token:   USDC  |  Min: $5   |  Gas: ${hasRelay ? chalk.green("FREE") : "ETH ~0.0001"}`);
      console.log(`  Command: ${chalk.green("perp funds deposit hyperliquid <amount>")}`);

      console.log(chalk.white.bold("\n  Lighter") + chalk.gray(" (Ethereum L1 / CCTP)"));
      console.log(`  Token:   USDC  |  Min: 1 (L1), 5 (CCTP)`);
      console.log(`  L1:      ${chalk.green("perp funds deposit lighter ethereum <amount>")} — gas $3-10+`);
      console.log(`  CCTP:    ${chalk.green("perp funds deposit lighter cctp <chain> <amount>")} — gas ~$0.01`);
      console.log(`  Chains:  arbitrum, base, avalanche`);

      // Withdraw info
      console.log(chalk.white.bold("\n  ── Withdraw ──\n"));

      console.log(chalk.white.bold("  Pacifica") + chalk.gray(" → Solana"));
      console.log(`  Speed: ~10s  |  Fee: none`);
      console.log(`  Command: ${chalk.green("perp funds withdraw pacifica <amount>")}`);

      console.log(chalk.white.bold("\n  Hyperliquid") + chalk.gray(" → Arbitrum"));
      console.log(`  Speed: minutes  |  Fee: ~$1`);
      console.log(`  Command: ${chalk.green("perp -e hl funds withdraw hyperliquid <amount>")}`);

      console.log(chalk.white.bold("\n  Lighter") + chalk.gray(" → Ethereum L1"));
      console.log(`  Speed: ~12h (standard)  |  Fee: varies`);
      console.log(`  Command: ${chalk.green("perp -e lt funds withdraw lighter <amount>")}`);

      // Transfer + Bridge
      console.log(chalk.white.bold("\n  ── Transfer & Bridge ──\n"));

      console.log(chalk.white.bold("  Internal Transfer") + chalk.gray(" (Hyperliquid → Hyperliquid)"));
      console.log(`  Speed: instant  |  Fee: none`);
      console.log(`  Command: ${chalk.green("perp -e hl funds transfer <amount> <address>")}`);

      console.log(chalk.white.bold("\n  CCTP Bridge") + chalk.gray(" (Cross-chain USDC)"));
      console.log(`  Routes:  Arbitrum ↔ Ethereum ↔ Solana`);
      console.log(`  Command: ${chalk.green("perp funds bridge --from arbitrum --to solana --amount 100 --recipient <addr>")}`);

      console.log(chalk.gray("\n  Use --no-relay to skip relayer and pay gas yourself.\n"));
    });
}
