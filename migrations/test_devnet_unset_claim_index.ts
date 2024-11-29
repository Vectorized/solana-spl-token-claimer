import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { TokenClaimer } from "../target/types/token_claimer";
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
import * as nacl from "tweetnacl";

const loadKeypair = (path) => {
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(path, "utf-8")))
  );
};

const savePublicKey = (path, publicKey) => {
  fs.writeFileSync(path, JSON.stringify(Array.from(publicKey.toBytes())));
};

const loadPublicKey = (path) => {
  return new PublicKey(Uint8Array.from(JSON.parse(fs.readFileSync(path, "utf-8"))));
};

(async () => {  
  // Set up the provider
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const connection = provider.connection;

  const program = anchor.workspace.TokenClaimer as Program<TokenClaimer>;

  // Load keypairs
  const stateAccount = loadKeypair("keypairs/state_account.json");
  const deployer = loadKeypair("keypairs/deployer.json");

  let state = await program.account.state.fetch(stateAccount.publicKey);
 
  console.log("State Accoount:", stateAccount.publicKey.toBase58());
  console.log("Deployer:", deployer.publicKey.toBase58());

  const claimIndicesToUnset = [111, 110];
  let instructions = []; 
  
  for (let i = 0; i < claimIndicesToUnset.length; i++) {
    instructions.push(
      await program.methods
        .unsetClaimIndex(claimIndicesToUnset[i])
        .accounts({
          state: stateAccount.publicKey
        }).instruction()
    );
  }

  try {
    const transaction = new Transaction();
    instructions.forEach((instruction) => transaction.add(instruction));
    const txId = await sendAndConfirmTransaction(connection, transaction, [deployer]);
    console.log("Transaction ID:", txId);
  } catch (err) {
    console.error(err);
    if (err.transactionLogs) {
      console.error("Transaction logs:", err.transactionLogs);
    }
    throw err;
  }
})();
