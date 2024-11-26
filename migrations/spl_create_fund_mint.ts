import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  SystemProgram,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import * as splToken from "@solana/spl-token";
import * as fs from "fs";

const loadKeypair = (path) => {
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(path, "utf-8")))
  );
};

const savePublicKey = (path, publicKey) => {
  fs.writeFileSync(path, JSON.stringify(Array.from(publicKey.toBytes())));
};

(async () => {
  const amount = 1000;
  
  // Set up the provider
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const connection = provider.connection;

  // Load keypairs
  const mintAuthority = loadKeypair("keypairs/mint_keypair.json");
  const deployer = loadKeypair("keypairs/deployer.json");
  const feePayer = deployer;

  console.log("Mint Authority:", mintAuthority.publicKey.toBase58());
  console.log("Fee Payer:", deployer.publicKey.toBase58());

  console.log("Deployer balance before:", await provider.connection.getBalance(deployer.publicKey));

  let splTokenMint;
  try {
    console.log("Creating SPL Token...");
    splTokenMint = await splToken.createMint(
      connection,
      feePayer, // Payer for the transaction
      mintAuthority.publicKey, // Mint authority
      null, // Freeze authority (optional, null means no freeze authority)
      9 // Decimals
    );
    console.log("SPL Token Address:", splTokenMint.toBase58());
    savePublicKey("keypairs/spl_token.json", splTokenMint);  
  } catch (err) {
    console.error("Transaction failed:", err.message);
    console.error("Full Error:", err);
  }
  
  let associatedTokenAccount;
  try {
    console.log("Creating associated token account for deployer...");
    associatedTokenAccount = await splToken.getOrCreateAssociatedTokenAccount(
      connection,
      feePayer, // Payer
      splTokenMint, // Token mint
      feePayer.publicKey // Owner of the associated account
    );
    console.log("Deployer's associated token account:", associatedTokenAccount.address.toBase58());
    savePublicKey("keypairs/spl_token_for_deployer.json", associatedTokenAccount.address);
  } catch (err) {
    console.error("Transaction failed:", err.message);
    console.error("Full Error:", err);
  }

  try {
    console.log("Minting tokens to deployer's associated token account...");
    const tx = await splToken.mintTo(
      connection,
      feePayer, // Payer
      splTokenMint, // Token mint
      associatedTokenAccount.address, // Recipient token account
      mintAuthority, // Mint authority
      amount * 10 ** 9 // Amount to mint (adjust for decimals)
    );
    console.log("Transaction:", tx);
  } catch (err) {
    console.error("Transaction failed:", err.message);
    console.error("Full Error:", err);
  }

  console.log("Deployer balance after:", await provider.connection.getBalance(deployer.publicKey));
})();
