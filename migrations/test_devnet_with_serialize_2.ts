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
  const claimer = Keypair.fromSecretKey(
    bs58.decode("3mPCSBwGhPJCTwsui1JfXWfLo9gVqg2DmVEpMwxqJN1uaL9dDQ1X2esoWwSV62KephpkhKoxv3eVYXagyk1Jo2Eo")
  );
  const destination = claimer;// loadKeypair("keypairs/destination.json");

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
    {
      claimIndex: 1267,
      amount: 2,
    },
    {
      claimIndex: 1268,
      amount: 2,
    },
    {
      claimIndex: 1269,
      amount: 2,
    },
  ];
  
  let instructions = []; 
  for (let i = 0; i < claims.length; i++) {
    const { claimIndex, amount } = claims[i];
    const message = Buffer.concat([
      (new anchor.BN(claimIndex)).toArrayLike(Buffer, "be", 4),
      sourceTokenAccount.toBuffer(),
      expectedDestinationTokenAccount.toBuffer(), 
      (new anchor.BN(amount)).toArrayLike(Buffer, "be", 8),
    ]);
    const signature = nacl.sign.detached(message, claimSigner.secretKey);
    instructions.push(
      anchor.web3.Ed25519Program.createInstructionWithPublicKey({
        publicKey: claimSigner.publicKey.toBytes(),
        message: message,
        signature: signature,
      }),
      splToken.createAssociatedTokenAccountIdempotentInstruction(
        claimer.publicKey,
        expectedDestinationTokenAccount,
        destination.publicKey, 
        splTokenMint 
      ),
      await program.methods
        .claim(i * 3, claimIndex, new anchor.BN(amount), Array.from(signature))
        .accounts({
          state: stateAccount.publicKey,
          claimer: claimer.publicKey,
          sourceTokenAccount: sourceTokenAccount,
          destinationTokenAccount: expectedDestinationTokenAccount,
          ixSysvar: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
        }).instruction()
    );
  }

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

  // console.log("Program Owner:", state.owner.toBase58());
  // console.log("Program Claim Signer:", state.claimSigner.toBase58());
  
  // const latestBlockhash = await provider.connection.getLatestBlockhash(
  //   "confirmed"
  // );

  // await sleep(5000); // Sleep for 5 seconds

  // // Create message
  // const messageV0 = new TransactionMessage({
  //   payerKey: claimer.publicKey,
  //   recentBlockhash: latestBlockhash.blockhash,
  //   instructions: instructions,
  // }).compileToV0Message();
  // console.log("Message V0:", messageV0);
  // const serializedMessage = Buffer.from(messageV0.serialize()).toString(
  //   "base64"
  // );
  // console.log("Serialized Message:", serializedMessage);
  // const deserializedMessage = VersionedMessage.deserialize(
  //   Buffer.from(serializedMessage, "base64")
  // );
  // const newTransaction = new VersionedTransaction(deserializedMessage);
  // newTransaction.sign([claimer]);

  // try {
  //   const signature1 = await provider.connection.sendRawTransaction(
  //     newTransaction.serialize(),
  //     {
  //       skipPreflight: false,
  //       maxRetries: 3,
  //       preflightCommitment: "confirmed",
  //     }
  //   );
  //   const txId = await provider.connection.confirmTransaction(signature1, "confirmed");
  //   console.log("Transaction ID:", txId);
  // } catch (err) {
  //   console.error(err);
  //   if (err.transactionLogs) {
  //     console.error("Transaction logs:", err.transactionLogs);
  //   }
  //   throw err;
  // }
})();