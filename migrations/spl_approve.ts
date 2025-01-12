import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey, Keypair } from "@solana/web3.js";
import * as splToken from "@solana/spl-token";
import * as fs from "fs";

const loadKeyPair = (path) => {
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(path, "utf-8")))
  )
};

const loadPublicKey = (path) => {
  const keyData = JSON.parse(fs.readFileSync(path, "utf-8"));
  return new PublicKey(keyData);
};

(async () => {
  // Set up the provider
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const connection = provider.connection;

  const program = anchor.workspace.TokenClaimer as Program<TokenClaimer>;

  const ownerKeypair = loadKeyPair("keypairs/deployer.json");
  const stateKeypair = loadKeyPair("keypairs/state_account.json");

  console.log("Owner (deployer) account:", ownerKeypair.publicKey.toBase58());
  console.log("State account:", stateKeypair.publicKey.toBase58());

  const sourceTokenAccount = loadPublicKey("keypairs/spl_token_for_deployer.json");

  console.log("Source token account:", sourceTokenAccount.toBase58());    

  let [delegatePDA, delegateBump] = await anchor.web3.PublicKey.findProgramAddress(
    [Buffer.from("delegate"), sourceTokenAccount.toBuffer(), stateKeypair.publicKey.toBuffer()],
    program.programId
  );

  console.log("Delegate PDA:", delegatePDA);
  const amount = (await splToken.getAccount(connection, sourceTokenAccount)).amount;
  console.log("Source token balance:", amount);

  try {
    console.log("Approving...");
    const tx = await program.methods
      .approveDelegate(new anchor.BN(amount))
      .accounts({
        tokenAccount: sourceTokenAccount,
        delegate: delegatePDA,
        authority: ownerKeypair.publicKey,
        tokenProgram: splToken.TOKEN_PROGRAM_ID,
      })
      .signers([ownerKeypair])
      .rpc();
    console.log("Transaction:", tx);
  } catch (err) {
    console.error("Transaction failed:", err.message);
    console.error("Full Error:", err);
  }
})();
