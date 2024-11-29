import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey, Keypair } from "@solana/web3.js";
import * as fs from "fs";

(async () => {
  // Set up the provider
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.TokenClaimer as Program<TokenClaimer>;

  const ownerKeypair = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync("keypairs/deployer.json", "utf-8")))
  );

  const stateKeypair = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync("keypairs/state_account.json", "utf-8")))
  );

  console.log("State account:", stateKeypair.publicKey.toBase58());

  const getRentTopup = async () => {
    const accountInfo = await provider.connection.getAccountInfo(stateKeypair.publicKey);
    if (accountInfo) {
      const accountSize = accountInfo.data.length; // Get the account size in bytes
      console.log("Current state account size (bytes):", accountSize);
    } else {
      console.log("Account not found.");
    }
    // Define the account size (update this with the correct size for your program)
    const newAccountSize = accountInfo.data.length + 10000;

    // Calculate rent-exempt balance
    const rentExemption = await provider.connection.getMinimumBalanceForRentExemption(newAccountSize);
    console.log("Rent exemption needed:", rentExemption);
    const stateBalance = await provider.connection.getBalance(stateKeypair.publicKey);
    console.log("Current state account balance:", stateBalance);
    const amountNeeded = Math.max(rentExemption - stateBalance, 0);
    console.log("Additional SOL needed:", amountNeeded);
    return amountNeeded;
  };

  const amountNeeded = await getRentTopup();
  console.log("Current owner account balance:",
    await provider.connection.getBalance(ownerKeypair.publicKey));

  if (amountNeeded > 0) {
    const tx = new anchor.web3.Transaction().add(
      anchor.web3.SystemProgram.transfer({
        fromPubkey: ownerKeypair.publicKey,
        toPubkey: stateKeypair.publicKey,
        lamports: amountNeeded,
      })
    );
    const txSignature = await provider.sendAndConfirm(tx, [ownerKeypair]);
    console.log("Transfer complete. Transaction Signature:", txSignature);
  } else {
    console.log("State account already has sufficient balance.");
  }

  console.log("Owner account balance after topup:",
    await provider.connection.getBalance(ownerKeypair.publicKey));

  try {
    const tx = await program.methods
      .expandBitmap()
      .accounts({
        state: stateKeypair.publicKey,
        owner: provider.wallet.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([ownerKeypair])
      .rpc();

    console.log("Bitmap expanded. Transaction Signature:", tx);

    const accountInfo = await provider.connection.getAccountInfo(stateKeypair.publicKey);
    if (accountInfo) {
      const accountSize = accountInfo.data.length; // Get the account size in bytes
      console.log("Expanded state account size (bytes):", accountSize);
    } else {
      console.log("Account not found.");
    }
  } catch (err) {
    console.error("Transaction failed:", err.message);
    console.error("Full Error:", err);
  }
})();
