import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { TokenClaimer } from "../target/types/token_claimer";
import { 
  PublicKey, 
  SystemProgram, 
  Keypair,
  TransactionMessage,
  VersionedMessage,
  VersionedTransaction,
  AddressLookupTableProgram,
  Transaction
} from "@solana/web3.js";
import { 
  Token, 
  TOKEN_PROGRAM_ID, 
  createMint, 
  createAccount, 
  createAssociatedTokenAccount,
  getAssociatedTokenAddress, 
  mintTo, 
  getAccount, 
  createAssociatedTokenAccountIdempotentInstruction 
} from "@solana/spl-token";
import { assert, expect } from "chai";
import * as nacl from "tweetnacl";
import { keccak_256 } from '@noble/hashes/sha3';

describe("token_claimer", () => {
  // Configure the client to use the local cluster.
  anchor.setProvider(anchor.AnchorProvider.env());
  const provider = anchor.AnchorProvider.env();
  const program = anchor.workspace.TokenClaimer as Program<TokenClaimer>;

  // Test accounts
  let owner = Keypair.generate();
  let newOwner = Keypair.generate();
  let claimer = Keypair.generate();
  let claimSigner = Keypair.generate();
  let destination = Keypair.generate();
  let stateAccount = Keypair.generate();
  let mint: PublicKey;
  let sourceTokenAccount: PublicKey;

  const stripHexPrefix = s => s.replace(/^0[xX]/, '');

  async function debugTransaction(txId: string) {
    const tx = await provider.connection.getTransaction(txId, {
      commitment: "confirmed", // Ensure the transaction has been confirmed
    });
  
    if (!tx) {
      console.error("Transaction not found or not confirmed.");
      return;
    }
  
    console.log("Transaction Logs:");
    console.log(tx.meta?.logMessages?.join("\n") || "No logs available.");
  };

  async function getSplTokenBalance(
    connection: Connection,
    owner: PublicKey, // The public key of the owner
    mint: PublicKey   // The mint address of the SPL token
  ): Promise<number> {
    // Derive the associated token address for the owner and mint
    const tokenAccountAddress = await getAssociatedTokenAddress(mint, owner);
  
    try {
      // Fetch the token account information
      const tokenAccountInfo = await getAccount(connection, tokenAccountAddress);
  
      // Return the balance (amount is in raw token units, not adjusted for decimals)
      return Number(tokenAccountInfo.amount);
    } catch (err) {
      // If the account does not exist, return a balance of 0
      if (err.message.includes("Failed to find account")) {
        return 0;
      } else {
        throw err;
      }
    }
  };

  it("Initializes the program state", async () => {
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(owner.publicKey, 111 * anchor.web3.LAMPORTS_PER_SOL)
    );
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(newOwner.publicKey, 111 * anchor.web3.LAMPORTS_PER_SOL)
    );
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(claimer.publicKey, 111 * anchor.web3.LAMPORTS_PER_SOL)
    );

    await program.methods
      .initialize(claimSigner.publicKey)
      .accounts({
        state: stateAccount.publicKey,
        owner: owner.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([owner, stateAccount])
      .rpc();

    let state = await program.account.state.fetch(stateAccount.publicKey);

    expect(state.owner.toBase58()).to.equal(owner.publicKey.toBase58());
    expect(state.claimSigner).to.deep.equal(claimSigner.publicKey);
    
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(stateAccount.publicKey, 111 * anchor.web3.LAMPORTS_PER_SOL)
    );

    for (let i = 0; i < 8; i++) {
      await program.methods
        .expandBitmap()
        .accounts({
          state: stateAccount.publicKey,
          owner: owner.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([owner])
        .rpc();
    }
      
    state = await program.account.state.fetch(stateAccount.publicKey);
    expect(state.claimedBitmap.length).to.eq(80000);

    expect(state.claimSigner).to.deep.equal(claimSigner.publicKey);
  });

  it("Updates the claim signer", async () => {
    const newClaimSigner = Keypair.generate();
    await program.methods
      .setClaimSigner(newClaimSigner.publicKey)
      .accounts({
        state: stateAccount.publicKey,
        owner: owner.publicKey,
      })
      .signers([owner])
      .rpc();

    const state = await program.account.state.fetch(stateAccount.publicKey);
    expect(state.claimSigner).to.deep.equal(newClaimSigner.publicKey);

    await program.methods
      .setClaimSigner(claimSigner.publicKey)
      .accounts({
        state: stateAccount.publicKey,
        owner: owner.publicKey,
      })
      .signers([owner])
      .rpc();
  });

  it("Transfers ownership", async () => {
    await program.methods
      .transferOwnership(newOwner.publicKey)
      .accounts({
        state: stateAccount.publicKey,
        owner: owner.publicKey,
      })
      .signers([owner])
      .rpc();

    const state = await program.account.state.fetch(stateAccount.publicKey);
    expect(state.owner.toBase58()).to.equal(newOwner.publicKey.toBase58());

    await program.methods
      .transferOwnership(owner.publicKey)
      .accounts({
        state: stateAccount.publicKey,
        owner: newOwner.publicKey,
      })
      .signers([newOwner])
      .rpc();
  });

  const sleep = (ms) => {
      return new Promise((resolve) => setTimeout(resolve, ms));
  };

  const sendInstructions = async (senderAndPayer, instructions, lookupTableAccount, verbose) => {
    let latestBlockhash = await provider.connection.getLatestBlockhash(
      "confirmed"
    );
    const transactionMessageParams = {
      payerKey: senderAndPayer.publicKey,
      recentBlockhash: latestBlockhash.blockhash,
      instructions: instructions,
    };
    const messageV0 = lookupTableAccount ? 
      new TransactionMessage(transactionMessageParams).compileToV0Message([lookupTableAccount]) :
      new TransactionMessage(transactionMessageParams).compileToV0Message();
    if (verbose) console.log("Message V0:", messageV0);
    const serializedMessage = Buffer.from(messageV0.serialize()).toString(
      "base64"
    );
    if (verbose) console.log("Serialized Message:", serializedMessage);
    const deserializedMessage = VersionedMessage.deserialize(
      Buffer.from(serializedMessage, "base64")
    );
    const newTransaction = new VersionedTransaction(deserializedMessage);
    newTransaction.sign([senderAndPayer]);
    try {
      const signature1 = await provider.connection.sendRawTransaction(
        newTransaction.serialize(),
        {
          skipPreflight: false,
          maxRetries: 3,
          preflightCommitment: "confirmed",
        }
      );
      latestBlockhash = await provider.connection.getLatestBlockhash(
        "confirmed"
      );
      const txId = await provider.connection.confirmTransaction({
        blockhash: latestBlockhash.blockhash,
        lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
        signature: signature1
      });
      if (verbose) console.log("Transaction ID:", txId);
    } catch (err) {
      console.error(err);
      if (err.transactionLogs) {
        console.error("Transaction logs:", err.transactionLogs);
      }
      throw err;
    }
  };

  it("Can claim tokens", async () => {
    // Create a token mint
    mint = await createMint(provider.connection, owner, owner.publicKey, null, 9);

    const amount = new anchor.BN(1000).mul(new anchor.BN(10).pow(new anchor.BN(9))); // 1000 * 10^9

    let delegatePDA: anchor.web3.PublicKey;
    let delegateBump: number;
    
    // Create token accounts
    sourceTokenAccount = await createAssociatedTokenAccount(
      provider.connection,
      owner,
      mint,
      owner.publicKey
    );

    const expectedDestinationTokenAccount = await getAssociatedTokenAddress(
      mint, 
      destination.publicKey
    );
    
    [delegatePDA, delegateBump] = await anchor.web3.PublicKey.findProgramAddress(
      [Buffer.from("delegate"), sourceTokenAccount.toBuffer()],
      program.programId
    );

    const slot = await provider.connection.getSlot();
    const [lookupTableInst, lookupTableAddress] =
      AddressLookupTableProgram.createLookupTable({
        authority: owner.publicKey,
        payer: owner.publicKey,
        recentSlot: slot - 1,
      });
    const extendInstruction = AddressLookupTableProgram.extendLookupTable({
      payer: owner.publicKey,
      authority: owner.publicKey,
      lookupTable: lookupTableAddress,
      addresses: [
        stateAccount.publicKey,
        sourceTokenAccount,
        anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
        anchor.web3.Ed25519Program.programId,
        anchor.web3.SystemProgram.programId,
        TOKEN_PROGRAM_ID,
        claimSigner.publicKey,
        mint,
        program.programId,
      ],
    });
    // await sendInstructions(owner, [lookupTableInst, extendInstruction], null, true);
    
    // Mint tokens to the source account
    await mintTo(
      provider.connection,
      owner,
      mint,
      sourceTokenAccount,
      owner.publicKey,
      amount.toNumber() // Mint 1000 tokens
    );

    console.log("Source Token Account Balance (after mint):", 
      await getSplTokenBalance(provider.connection, owner.publicKey, mint)
    );

    // Approve the PDA as a delegate for 500 tokens
    await program.methods
      .approveDelegate(amount)
      .accounts({
        tokenAccount: sourceTokenAccount,
        delegate: delegatePDA,
        authority: owner.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([owner])
      .rpc();
    
    const claims = [
      { claimIndex: 30110, amount: 1 },
      { claimIndex: 30111, amount: 1 },
      { claimIndex: 30112, amount: 1 },
      { claimIndex: 30113, amount: 1 },
      { claimIndex: 30114, amount: 1 },
      { claimIndex: 30115, amount: 1 },
      { claimIndex: 30116, amount: 1 },
      { claimIndex: 30117, amount: 1 },
      { claimIndex: 30118, amount: 1 },
      { claimIndex: 30119, amount: 1 },
      { claimIndex: 30120, amount: 1 },
      { claimIndex: 30121, amount: 1 },
      { claimIndex: 30122, amount: 1 },
      { claimIndex: 30123, amount: 1 },
      { claimIndex: 30124, amount: 1 },
      { claimIndex: 30125, amount: 1 },
      { claimIndex: 30126, amount: 1 },
      { claimIndex: 30127, amount: 1 },
      { claimIndex: 30128, amount: 1 },
      { claimIndex: 30129, amount: 1 },
    ];
    
    let instructions = []; 
    let claimIndices = [];
    let totalAmount = 0;
    for (let i = 0; i < claims.length; i++) {
      const { claimIndex, amount } = claims[i];
      totalAmount += amount;
      claimIndices.push(claimIndex);
    }
    const clockAccountInfo = await program.provider.connection.getAccountInfo(
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
      createAssociatedTokenAccountIdempotentInstruction(
        claimer.publicKey,
        expectedDestinationTokenAccount,
        destination.publicKey, 
        mint 
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

    // await sleep(1000);
    // const lookupTableAccount = (
    //   await provider.connection.getAddressLookupTable(lookupTableAddress)
    // ).value;
    await sendInstructions(claimer, instructions, null, true);
    // await sendInstructions(claimer, instructions, null, true);
    
    console.log("Destination Token Account Balance (after transfer):", 
      await getSplTokenBalance(provider.connection, destination.publicKey, mint)
    );
  });
});
