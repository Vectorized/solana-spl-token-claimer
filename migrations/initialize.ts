import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey, Keypair } from "@solana/web3.js";
import * as fs from "fs";

(async () => {
  // Set up the provider
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.TokenClaimer as Program<TokenClaimer>;

  // Load the keypair for the state account
  const stateKeypair = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync("keypairs/state_account.json", "utf-8")))
  );

  console.log(`State Account: ${stateKeypair.publicKey.toBase58()}`);

  // Load the claim signer keypair
  const claimSignerKeypair = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync("keypairs/claim_signer.json", "utf-8")))
  );

  console.log(`Claim Signer: ${claimSignerKeypair.publicKey.toBase58()}`);

  try {
    const tx = await program.methods
      .initialize(claimSignerKeypair.publicKey) // Pass the claim signer public key
      .accounts({
        state: stateKeypair.publicKey, // State account
        owner: provider.wallet.publicKey, // Wallet signing the transaction
        systemProgram: anchor.web3.SystemProgram.programId, // Solana System Program
      })
      .signers([stateKeypair]) // The state account must sign the transaction
      .rpc();
    console.log(`Transaction Signature: ${tx}`);
    console.log("Account successfully initialized.");
  } catch (err) {
    console.error("Transaction failed:", err.message);
    console.error("Full Error:", err);
  }
})();
