import {
  Connection,
  PublicKey,
  TransactionInstruction,
  Transaction,
  type TransactionSignature,
} from "@solana/web3.js";
import { getNetworkConfig, USDC_DECIMALS, type Network } from "./constants";

const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOCIATED_TOKEN_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const SYSTEM_PROGRAM = new PublicKey("11111111111111111111111111111111");

/**
 * Build the Anchor "global:deposit" discriminator.
 * sha256("global:deposit")[:8]
 */
async function getDepositDiscriminator(): Promise<Uint8Array> {
  const data = new TextEncoder().encode("global:deposit");
  const hash = await crypto.subtle.digest("SHA-256", data);
  return new Uint8Array(hash).slice(0, 8);
}

/**
 * Derive the Associated Token Account for a user.
 */
function getATA(owner: PublicKey, mint: PublicKey): PublicKey {
  const [ata] = PublicKey.findProgramAddressSync(
    [owner.toBytes(), TOKEN_PROGRAM.toBytes(), mint.toBytes()],
    ASSOCIATED_TOKEN_PROGRAM
  );
  return ata;
}

/**
 * Derive the event authority PDA.
 */
function getEventAuthority(programId: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("__event_authority")],
    programId
  );
  return pda;
}

/**
 * Build a Pacifica deposit instruction.
 *
 * @param userPubkey - User's wallet public key
 * @param amount - Amount in USDC (e.g., 100 for $100)
 * @param network - mainnet or testnet
 */
export async function buildDepositInstruction(
  userPubkey: PublicKey,
  amount: number,
  network: Network = "mainnet"
): Promise<TransactionInstruction> {
  const config = getNetworkConfig(network);
  const programId = new PublicKey(config.programId);
  const centralState = new PublicKey(config.centralState);
  const pacificaVault = new PublicKey(config.pacificaVault);
  const usdcMint = new PublicKey(config.usdcMint);

  const userATA = getATA(userPubkey, usdcMint);
  const eventAuthority = getEventAuthority(programId);

  // Build instruction data: discriminator + amount (u64 LE)
  const discriminator = await getDepositDiscriminator();
  const amountLamports = BigInt(Math.round(amount * 10 ** USDC_DECIMALS));
  const amountBytes = new Uint8Array(8);
  const view = new DataView(amountBytes.buffer);
  view.setBigUint64(0, amountLamports, true); // little-endian

  const data = new Uint8Array(discriminator.length + amountBytes.length);
  data.set(discriminator, 0);
  data.set(amountBytes, discriminator.length);

  // Account metas (ORDER IS CRITICAL)
  const keys = [
    { pubkey: userPubkey, isSigner: true, isWritable: true },
    { pubkey: userATA, isSigner: false, isWritable: true },
    { pubkey: centralState, isSigner: false, isWritable: true },
    { pubkey: pacificaVault, isSigner: false, isWritable: true },
    { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
    { pubkey: ASSOCIATED_TOKEN_PROGRAM, isSigner: false, isWritable: false },
    { pubkey: usdcMint, isSigner: false, isWritable: false },
    { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
    { pubkey: eventAuthority, isSigner: false, isWritable: false },
    { pubkey: programId, isSigner: false, isWritable: false },
  ];

  return new TransactionInstruction({ keys, programId, data: Buffer.from(data) });
}

/**
 * Build and send a deposit transaction.
 */
export async function deposit(
  connection: Connection,
  userPubkey: PublicKey,
  amount: number,
  signTransaction: (tx: Transaction) => Promise<Transaction>,
  network: Network = "mainnet"
): Promise<TransactionSignature> {
  const instruction = await buildDepositInstruction(userPubkey, amount, network);

  const tx = new Transaction().add(instruction);
  tx.feePayer = userPubkey;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

  const signed = await signTransaction(tx);
  return connection.sendRawTransaction(signed.serialize());
}
