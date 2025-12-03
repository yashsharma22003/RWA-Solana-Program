import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { RealEstateTokenization } from "../target/types/real_estate_tokenization";
import {
  PublicKey,
  Keypair,
  LAMPORTS_PER_SOL,
  SystemProgram
} from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  createTransferInstruction, // Standard SPL Transfer
  getAccount
} from "@solana/spl-token";
import { assert } from "chai";
import { BN } from "bn.js";

describe("Scenario: The 'Hot Property' Sale (Concurrency & Accounting)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.RealEstateTokenization as Program<RealEstateTokenization>;
  const admin = provider.wallet;

  // ACTORS
  const alice = Keypair.generate();   // Whale Buyer
  const bob = Keypair.generate();     // Regular Buyer
  const charlie = Keypair.generate(); // Late Buyer

  // PROPERTY CONFIG
  const PROPERTY_ID = new BN(777); // "Lucky 777" Apartments
  const MAX_SUPPLY = new BN(10);   // Only 10 shares available

  // PDAs
  let configPda: PublicKey;
  let mintPda: PublicKey;
  let treasuryPda: PublicKey;

  // ATAs
  let aliceAta: PublicKey;
  let bobAta: PublicKey;
  let charlieAta: PublicKey;

  before(async () => {
    // 1. Derive PDAs
    [configPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("config"), PROPERTY_ID.toArrayLike(Buffer, "le", 8)],
      program.programId
    );
    [mintPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("property_mint"), PROPERTY_ID.toArrayLike(Buffer, "le", 8)],
      program.programId
    );
    [treasuryPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("treasury")],
      program.programId
    );

    // 2. Fund Actors & KYC
    const actors = [alice, bob, charlie];
    for (const actor of actors) {
      // Airdrop
      await provider.connection.confirmTransaction(
        await provider.connection.requestAirdrop(actor.publicKey, 10 * LAMPORTS_PER_SOL)
      );

      // KYC Approval
      await program.methods
        .approveUser()
        .accounts({ userToApprove: actor.publicKey })
        .rpc();
    }

    // 3. Initialize Property
    await program.methods
      .initializeProperty(PROPERTY_ID, new BN(1 * LAMPORTS_PER_SOL), MAX_SUPPLY)
      .accounts({
        propertyConfig: configPda,
        mint: mintPda,
        admin: admin.publicKey,
      })
      .rpc();

    // 4. Create ATAs for everyone ahead of time
    aliceAta = await getAssociatedTokenAddress(mintPda, alice.publicKey);
    bobAta = await getAssociatedTokenAddress(mintPda, bob.publicKey);
    charlieAta = await getAssociatedTokenAddress(mintPda, charlie.publicKey);

    const createAtaTx = new anchor.web3.Transaction().add(
      createAssociatedTokenAccountInstruction(alice.publicKey, aliceAta, alice.publicKey, mintPda),
      createAssociatedTokenAccountInstruction(bob.publicKey, bobAta, bob.publicKey, mintPda),
      createAssociatedTokenAccountInstruction(charlie.publicKey, charlieAta, charlie.publicKey, mintPda)
    );
    await provider.sendAndConfirm(createAtaTx, [alice, bob, charlie]); // Any signer works for payer here really
  });

  // ------------------------------------------------------------------
  // STEP 1: ALICE BUYS 50% OF SUPPLY
  // ------------------------------------------------------------------
  it("Alice swoops in and buys 5 shares (5/10 sold)", async () => {
    await program.methods
      .buyShares(PROPERTY_ID, new BN(5))
      .accounts({
        buyer: alice.publicKey,
        receiver: alice.publicKey,
        propertyConfig: configPda,
        mint: mintPda,
        receiverAta: aliceAta,
      })
      .signers([alice])
      .rpc();

    const config = await program.account.propertyConfig.fetch(configPda);
    assert.equal(config.sharesSold.toNumber(), 5);
    
    const token = await getAccount(provider.connection, aliceAta);
    assert.equal(Number(token.amount), 5);
  });

  // ------------------------------------------------------------------
  // STEP 2: BOB BUYS 40% OF SUPPLY
  // ------------------------------------------------------------------
  it("Bob buys 4 shares (9/10 sold)", async () => {
    await program.methods
      .buyShares(PROPERTY_ID, new BN(4))
      .accounts({
        buyer: bob.publicKey,
        receiver: bob.publicKey,
        propertyConfig: configPda,
        mint: mintPda,
        receiverAta: bobAta,
      })
      .signers([bob])
      .rpc();

    const config = await program.account.propertyConfig.fetch(configPda);
    assert.equal(config.sharesSold.toNumber(), 9);
    
    const token = await getAccount(provider.connection, bobAta);
    assert.equal(Number(token.amount), 4);
  });

  // ------------------------------------------------------------------
  // STEP 3: CHARLIE TRIES TO OVERBUY
  // ------------------------------------------------------------------
  it("Charlie tries to buy 2 shares but fails (Would be 11/10)", async () => {
    try {
      await program.methods
        .buyShares(PROPERTY_ID, new BN(2))
        .accounts({
          buyer: charlie.publicKey,
          receiver: charlie.publicKey,
          propertyConfig: configPda,
          mint: mintPda,
          receiverAta: charlieAta,
        })
        .signers([charlie])
        .rpc();
      assert.fail("Should have failed due to supply limit");
    } catch (e) {
      assert.include(e.message, "Supply limit reached");
    }
  });

  // ------------------------------------------------------------------
  // STEP 4: CHARLIE BUYS THE LAST SHARE
  // ------------------------------------------------------------------
  it("Charlie buys the last remaining share (10/10 sold)", async () => {
    await program.methods
      .buyShares(PROPERTY_ID, new BN(1))
      .accounts({
        buyer: charlie.publicKey,
        receiver: charlie.publicKey,
        propertyConfig: configPda,
        mint: mintPda,
        receiverAta: charlieAta,
      })
      .signers([charlie])
      .rpc();

    const config = await program.account.propertyConfig.fetch(configPda);
    assert.equal(config.sharesSold.toNumber(), 10);
  });

  // ------------------------------------------------------------------
  // STEP 5: VERIFY "SOLD OUT" STATE
  // ------------------------------------------------------------------
  it("Verifies the property is now completely Sold Out", async () => {
    try {
      await program.methods
        .buyShares(PROPERTY_ID, new BN(1))
        .accounts({
          buyer: alice.publicKey, // Alice wants more but can't have any
          receiver: alice.publicKey,
          propertyConfig: configPda,
          mint: mintPda,
          receiverAta: aliceAta,
        })
        .signers([alice])
        .rpc();
      assert.fail("Should not be able to buy when sold out");
    } catch (e) {
      assert.include(e.message, "Supply limit reached");
    }
  });

  // ------------------------------------------------------------------
  // STEP 6: SECONDARY MARKET (Standard SPL Transfer)
  // ------------------------------------------------------------------
  it("Alice transfers 1 share to Charlie (Secondary Market)", async () => {
    // Even though the primary market is closed (minting stopped),
    // users should be able to trade peer-to-peer using standard SPL instructions.
    
    // Transfer 1 token from Alice to Charlie
    const tx = new anchor.web3.Transaction().add(
      createTransferInstruction(
        aliceAta,      // Source
        charlieAta,    // Destination
        alice.publicKey, // Owner
        1              // Amount
      )
    );
    await provider.sendAndConfirm(tx, [alice]);

    // Verify Balances
    const aliceAcct = await getAccount(provider.connection, aliceAta);
    const charlieAcct = await getAccount(provider.connection, charlieAta);

    // Alice had 5, sent 1 -> 4 remaining
    assert.equal(Number(aliceAcct.amount), 4);
    // Charlie had 1, received 1 -> 2 total
    assert.equal(Number(charlieAcct.amount), 2);
  });

});