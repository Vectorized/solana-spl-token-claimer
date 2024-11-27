import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { TokenClaimer } from "../target/types/token_claimer";
import { PublicKey, SystemProgram, Keypair } from "@solana/web3.js";
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

    await program.methods
      .expandBitmap()
      .accounts({
        state: stateAccount.publicKey,
        owner: owner.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([owner])
      .rpc();
    
    await program.methods
      .expandBitmap()
      .accounts({
        state: stateAccount.publicKey,
        owner: owner.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([owner])
      .rpc();
      
    state = await program.account.state.fetch(stateAccount.publicKey);
    expect(state.claimedBitmap.length).to.eq(20000);

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

    const claimIndex = new anchor.BN(1);
    // Generate a mock signature for the claim
    const message = Buffer.concat([
      claimIndex.toArrayLike(Buffer, "be", 8),
      sourceTokenAccount.toBuffer(),
      expectedDestinationTokenAccount.toBuffer(), 
      amount.toArrayLike(Buffer, "be", 8),
    ]);
    console.log("Message:", message.length, message.toString("hex"));
    // Generate Ed25519 signature
    const signature = nacl.sign.detached(message, claimSigner.secretKey);

    // Output
    console.log("Message:", message.toString("hex"));
    console.log("Public Key:", claimSigner.publicKey.toBase58());
    console.log("Signature:", Buffer.from(signature).toString("hex"));
    
    // Fetch the source token account details
    const sourceAccountInfo = await getAccount(provider.connection, sourceTokenAccount);

    // Fetch the destination token account details
    // const destinationAccountInfo = await getAccount(provider.connection, destinationTokenAccount);

    
    // Print the owner of each token account
    console.log("Source Token Account Owner:", sourceAccountInfo.owner.toString());
    // console.log("Destination Token Account Owner:", destinationAccountInfo.owner.toString());
    console.log("S:", owner.publicKey.toString());
    console.log("D:", destination.publicKey.toString());

    console.log("Source Token Account Balance (before mint):", 
      await getSplTokenBalance(provider.connection, owner.publicKey, mint)
    );
    
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
    
    try {
      // await createAssociatedTokenAccount(
      //   provider.connection,
      //   owner,
      //   mint,
      //   destination.publicKey
      // );
      const ed25519InstructionIndex = new anchor.BN(0);
      await program.methods
        .claim(ed25519InstructionIndex, claimIndex, amount, signature)
        .accounts({
          state: stateAccount.publicKey,
          claimer: claimer.publicKey,
          sourceTokenAccount: sourceTokenAccount,
          destinationTokenAccount: expectedDestinationTokenAccount,
          ixSysvar: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .preInstructions([
          anchor.web3.Ed25519Program.createInstructionWithPublicKey({
            publicKey: claimSigner.publicKey.toBytes(),
            message: message,
            signature: signature,
          }),
          createAssociatedTokenAccountIdempotentInstruction(
            claimer.publicKey,
            expectedDestinationTokenAccount,
            destination.publicKey, 
            mint 
          ),
          
        ])
        .signers([claimer])
        .rpc();
    } catch (err) {
      console.error(err);
      throw err;
    }
    
    console.log("Destination Token Account Balance (after transfer):", 
      await getSplTokenBalance(provider.connection, destination.publicKey, mint)
    );
  });
});
