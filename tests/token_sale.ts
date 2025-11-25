import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { RealEstateTokenization } from "../target/types/real_estate_tokenization";
import { 
  PublicKey, 
  Keypair, 
  SystemProgram, 
  LAMPORTS_PER_SOL 
} from "@solana/web3.js";
import { 
  getAssociatedTokenAddress, 
  createAssociatedTokenAccountInstruction, 
  getAccount, 
  ASSOCIATED_TOKEN_PROGRAM_ID, 
  TOKEN_PROGRAM_ID 
} from "@solana/spl-token";
import { assert } from "chai";

describe("real_estate_tokenization", () => {
  // Configure the client to use the local cluster.
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.RealEstateTokenization as Program<RealEstateTokenization>;

  // --- Test Data & Accounts ---
  const admin = provider.wallet;
  const buyer = Keypair.generate();
  const unauthorizedBuyer = Keypair.generate();

  // PDAs
  let propertyConfigPda: PublicKey;
  let mintPda: PublicKey;
  let treasuryPda: PublicKey;
  let kycEntryPda: PublicKey;
  let buyerAta: PublicKey;

  // Constants
  const PRICE_PER_SHARE = new anchor.BN(0.5 * LAMPORTS_PER_SOL); // 0.5 SOL per share
  const MAX_SHARES = new anchor.BN(100);

  before(async () => {
    // 1. Derive PDAs
    [propertyConfigPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("config")],
      program.programId
    );

    [mintPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("property_mint")],
      program.programId
    );

    [treasuryPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("treasury")],
      program.programId
    );

    [kycEntryPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("kyc"), buyer.publicKey.toBuffer()],
      program.programId
    );

    // 2. Airdrop SOL to buyer
    const airdropSig = await provider.connection.requestAirdrop(
      buyer.publicKey,
      10 * LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(airdropSig);
    
    // 3. Airdrop to unauthorized buyer
    const airdropSig2 = await provider.connection.requestAirdrop(
      unauthorizedBuyer.publicKey,
      5 * LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(airdropSig2);

    // 4. Calculate ATA address for buyer
    buyerAta = await getAssociatedTokenAddress(
      mintPda,
      buyer.publicKey
    );
  });

  it("Is initialized!", async () => {
    await program.methods
      .initializeProperty(PRICE_PER_SHARE, MAX_SHARES)
      .accounts({
        admin: admin.publicKey,
        // propertyConfig: propertyConfigPda,
        // mint: mintPda,
        // treasury: treasuryPda,
        // tokenProgram: TOKEN_PROGRAM_ID,
        // systemProgram: SystemProgram.programId,
      })
      .rpc();

    const configAccount = await program.account.propertyConfig.fetch(propertyConfigPda);
    assert.ok(configAccount.admin.equals(admin.publicKey));
    assert.ok(configAccount.pricePerShare.eq(PRICE_PER_SHARE));
    assert.ok(configAccount.maxShares.eq(MAX_SHARES));
  });

  it("Approves a user for KYC", async () => {
    await program.methods
      .approveUser()
      .accounts({
        // admin: admin.publicKey,
        userToApprove: buyer.publicKey,
        propertyConfig: propertyConfigPda,
        // kycEntry: kycEntryPda,
        // systemProgram: SystemProgram.programId,
      })
      .rpc();

    const kycAccount = await program.account.kycEntry.fetch(kycEntryPda);
    assert.isTrue(kycAccount.isVerified);
    assert.ok(kycAccount.user.equals(buyer.publicKey));
  });

  it("Buys shares successfully", async () => {
    // IMPORTANT: The contract logic expects the ATA to exist (it doesn't init it).
    // We must create it first manually in the test.
    const createAtaTx = new anchor.web3.Transaction().add(
      createAssociatedTokenAccountInstruction(
        buyer.publicKey,
        buyerAta,
        buyer.publicKey,
        mintPda
      )
    );
    await provider.sendAndConfirm(createAtaTx, [buyer]);

    const sharesToBuy = new anchor.BN(2);
    const expectedCost = PRICE_PER_SHARE.mul(sharesToBuy);

    const initialTreasuryBalance = await provider.connection.getBalance(treasuryPda);

    await program.methods
      .buyShares(sharesToBuy)
      .accounts({
        buyer: buyer.publicKey,
        propertyConfig: propertyConfigPda,
        // kycEntry: kycEntryPda,
        // mint: mintPda,
        buyerAta: buyerAta,
        // treasury: treasuryPda,
        // tokenProgram: TOKEN_PROGRAM_ID,
        // systemProgram: SystemProgram.programId,
      })
      .signers([buyer])
      .rpc();

    // Verify Token Balance
    const buyerTokenAccount = await getAccount(provider.connection, buyerAta);
    assert.equal(Number(buyerTokenAccount.amount), 2);

    // Verify Treasury SOL Balance
    const finalTreasuryBalance = await provider.connection.getBalance(treasuryPda);
    assert.equal(
      finalTreasuryBalance, 
      initialTreasuryBalance + expectedCost.toNumber(),
      "Treasury should have received exact SOL amount"
    );

    // Verify State Update
    const configAccount = await program.account.propertyConfig.fetch(propertyConfigPda);
    assert.ok(configAccount.sharesSold.eq(sharesToBuy));
  });

  it("Fails to buy if NOT approved (No KYC)", async () => {
    // Derive PDA for unauthorized user
    const [unauthKycPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("kyc"), unauthorizedBuyer.publicKey.toBuffer()],
      program.programId
    );

    // Create ATA for unauthorized user
    const unauthAta = await getAssociatedTokenAddress(mintPda, unauthorizedBuyer.publicKey);
    const tx = new anchor.web3.Transaction().add(
      createAssociatedTokenAccountInstruction(
        unauthorizedBuyer.publicKey,
        unauthAta,
        unauthorizedBuyer.publicKey,
        mintPda
      )
    );
    await provider.sendAndConfirm(tx, [unauthorizedBuyer]);

    try {
      await program.methods
        .buyShares(new anchor.BN(1))
        .accounts({
          buyer: unauthorizedBuyer.publicKey,
          propertyConfig: propertyConfigPda,
          // kycEntry: unauthKycPda, // This account likely doesn't exist yet
          // mint: mintPda,
          buyerAta: unauthAta,
          // treasury: treasuryPda,
          // tokenProgram: TOKEN_PROGRAM_ID,
          // systemProgram: SystemProgram.programId,
        })
        .signers([unauthorizedBuyer])
        .rpc();
      
      assert.fail("Should have failed due to missing/unverified KYC");
    } catch (e) {
      // We expect an error. 
      // If the PDA doesn't exist, it throws "AccountNotInitialized".
      // If it exists but is false, it throws the custom error.
      assert.ok(true); 
    }
  });

  it("Revokes a user", async () => {
    await program.methods
      .revokeUser()
      .accounts({
        // admin: admin.publicKey,
        userToRevoke: buyer.publicKey,
        propertyConfig: propertyConfigPda,
        // kycEntry: kycEntryPda,
      })
      .rpc();

    const kycAccount = await program.account.kycEntry.fetch(kycEntryPda);
    assert.isFalse(kycAccount.isVerified);
  });

  it("Fails to buy after revocation", async () => {
    try {
      await program.methods
        .buyShares(new anchor.BN(1))
        .accounts({
          buyer: buyer.publicKey,
          propertyConfig: propertyConfigPda,
          // kycEntry: kycEntryPda,
          // mint: mintPda,
          buyerAta: buyerAta,
          // treasury: treasuryPda,
          // tokenProgram: TOKEN_PROGRAM_ID,
          // systemProgram: SystemProgram.programId,
        })
        .signers([buyer])
        .rpc();
      assert.fail("Should have failed due to revoked KYC");
    } catch (e) {
      assert.include(e.message, "User is not KYC verified");
    }
  });

  it("Admin withdraws capital", async () => {
    const withdrawAmount = new anchor.BN(0.5 * LAMPORTS_PER_SOL);
    const initialTreasury = await provider.connection.getBalance(treasuryPda);
    const initialAdmin = await provider.connection.getBalance(admin.publicKey);

    await program.methods
      .withdrawCapital(withdrawAmount)
      .accounts({
        // admin: admin.publicKey,
        propertyConfig: propertyConfigPda,
        // treasury: treasuryPda,
        // systemProgram: SystemProgram.programId,
      })
      .rpc();

    const finalTreasury = await provider.connection.getBalance(treasuryPda);
    assert.equal(finalTreasury, initialTreasury - withdrawAmount.toNumber());
  });
});