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
  TransactionMessage,
  VersionedMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import * as splToken from "@solana/spl-token";
import * as fs from "fs";
import * as nacl from "tweetnacl";
import { bs58 } from "@coral-xyz/anchor/dist/cjs/utils/bytes";
import { keccak_256 } from '@noble/hashes/sha3';

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

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
  
  const idl = JSON.parse(fs.readFileSync("target/idl/token_claimer.json", "utf-8"));
  const program = new anchor.Program(idl, provider);

  // Load keypairs
  const stateAccount = loadKeypair("keypairs/state_account.json");
  const mintAuthority = loadKeypair("keypairs/mint_keypair.json");
  const deployer = loadKeypair("keypairs/deployer.json");
  const claimSigner = loadKeypair("keypairs/claim_signer.json");
  const splTokenMint = loadPublicKey("keypairs/spl_token.json");
  const sourceTokenAccount = loadPublicKey("keypairs/spl_token_for_deployer.json");
  const claimer = Keypair.fromSecretKey("keypairs/claimer.json");
  const destination = claimer; // loadKeypair("keypairs/destination.json");

  let state = await program.account.state.fetch(stateAccount.publicKey);
 
  console.log("State Accoount:", stateAccount.publicKey.toBase58());
  console.log("Mint Authority:", mintAuthority.publicKey.toBase58());
  console.log("Deployer:", deployer.publicKey.toBase58());
  console.log("Claim Signer:", claimSigner.publicKey.toBase58()); // On the server side.
  console.log("SPL Token Mint:", splTokenMint.toBase58());
  console.log("Source Token Account:", sourceTokenAccount.toBase58());
  console.log("Claimer:", claimer.publicKey.toBase58()); // This is the user who will claim the tokens.
  console.log("Destination:", destination.publicKey.toBase58());
  
  try {
    console.log("Deployer balance:", await connection.getBalance(deployer.publicKey));
    console.log("Source token balance:", (await splToken.getAccount(connection, sourceTokenAccount)).amount);
  } catch (err) {
    console.error(err);
  }

  const expectedDestinationTokenAccount = await splToken.getAssociatedTokenAddress(
    splTokenMint, 
    destination.publicKey
  );
  console.log("Expected Destination Token Account:", expectedDestinationTokenAccount.toBase58());

  // Make sure you bump the claim index, cuz I might have already claimed some.
  const claims = [
    { claimIndex: 1300, amount: 2 },
    { claimIndex: 1301, amount: 2 }
  ];
  
  let instructions = []; 
  let claimIndices = [];
  let totalAmount = 0;
  for (let i = 0; i < claims.length; i++) {
    const { claimIndex, amount } = claims[i];
    totalAmount += amount;
    claimIndices.push(claimIndex);
  }
  const clockAccountInfo = await provider.connection.getAccountInfo(
    anchor.web3.SYSVAR_CLOCK_PUBKEY
  );
  const currentTimestamp = new anchor.BN(
    clockAccountInfo.data.readBigInt64LE(8)
  ).toNumber();
  const expiry = currentTimestamp + 60;
  const message = keccak_256(Buffer.concat([
    keccak_256(Buffer.concat(
      claimIndices.map(i => (new anchor.BN(i)).toArrayLike(Buffer, "le", 4))
    )),
    claimer.publicKey.toBuffer(),
    sourceTokenAccount.toBuffer(),
    expectedDestinationTokenAccount.toBuffer(), 
    (new anchor.BN(totalAmount)).toArrayLike(Buffer, "le", 8),
    (new anchor.BN(expiry)).toArrayLike(Buffer, "le", 4),
  ]));
  const signature = nacl.sign.detached(message, claimSigner.secretKey);
  instructions.push(
    splToken.createAssociatedTokenAccountIdempotentInstruction(
      claimer.publicKey,
      expectedDestinationTokenAccount,
      destination.publicKey, 
      splTokenMint 
    ),
    anchor.web3.Ed25519Program.createInstructionWithPublicKey({
      publicKey: claimSigner.publicKey.toBytes(),
      message: message,
      signature: signature,
    }),
    await program.methods
      .claim(claimIndices, new anchor.BN(totalAmount), expiry)
      .accounts({
        state: stateAccount.publicKey,
        claimer: claimer.publicKey,
        sourceTokenAccount: sourceTokenAccount,
        destinationTokenAccount: expectedDestinationTokenAccount,
        ixSysvar: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
      }).instruction()
  );

  const serializedInstructions = instructions.map((instruction) => {
    return {
      keys: instruction.keys.map((key) => ({
        pubkey: key.pubkey.toBase58(),
        isSigner: key.isSigner,
        isWritable: key.isWritable,
      })),
      programId: instruction.programId.toBase58(),
      data: instruction.data.toString("base64"), // Encode data as Base64
    };
  });
  console.log("Serialized Instructions:", JSON.stringify(serializedInstructions));
})();
