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
  const ownerKeypair = loadKeyPair("keypairs/deployer.json");
  const stateKeypair = loadKeyPair("keypairs/state_account.json");
  const claimSignerKeypair = loadKeyPair("keypairs/claim_signer.json");
  const mintKeypair = loadKeyPair("keypairs/mint_keypair.json");

  console.log("Owner account:", ownerKeypair.publicKey.toBase58());
  console.log("State account:", stateKeypair.publicKey.toBase58());
  console.log("Claim signer:", claimSignerKeypair.publicKey.toBase58());
  console.log("Mint authority:", mintKeypair.publicKey.toBase58());

  console.log("SPL token:", loadPublicKey("keypairs/spl_token.json").toBase58());    
  console.log("Source token account:", loadPublicKey("keypairs/spl_token_for_deployer.json").toBase58());    
})();
