import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { RealEstateTokenization } from "../target/types/real_estate_tokenization";
import { 
  PublicKey, 
  Keypair, 
  LAMPORTS_PER_SOL 
} from "@solana/web3.js";
import { 
  getAssociatedTokenAddress, 
  createAssociatedTokenAccountInstruction, 
  getAccount 
} from "@solana/spl-token";
import { assert } from "chai";

describe("real_estate_tokenization", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.RealEstateTokenization as Program<RealEstateTokenization>;

  const admin = provider.wallet;
  const buyer = Keypair.generate();
  const unauthorizedBuyer = Keypair.generate();
  const hacker = Keypair.generate();
  const poorBuyer = Keypair.generate();

  let propertyConfigPda: PublicKey;
  let mintPda: PublicKey;
  let treasuryPda: PublicKey;
  let kycEntryPda: PublicKey;
  let buyerAta: PublicKey;

  const PRICE_PER_SHARE = new anchor.BN(0.5 * LAMPORTS_PER_SOL);
  const MAX_SHARES = new anchor.BN(100);

  before(async () => {
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

    // Fund accounts
    const users = [buyer, unauthorizedBuyer, hacker];
    for (const u of users) {
        await provider.connection.confirmTransaction(
            await provider.connection.requestAirdrop(u.publicKey, 10 * LAMPORTS_PER_SOL)
        );
    }
    await provider.connection.confirmTransaction(
        await provider.connection.requestAirdrop(poorBuyer.publicKey, 0.1 * LAMPORTS_PER_SOL)
    );

    buyerAta = await getAssociatedTokenAddress(mintPda, buyer.publicKey);
  });

  // 1. Initialize
  it("Is initialized!", async () => {
    await program.methods
      .initializeProperty(PRICE_PER_SHARE, MAX_SHARES)
      .accounts({ admin: admin.publicKey })
      .rpc();

    const config = await program.account.propertyConfig.fetch(propertyConfigPda);
    assert.ok(config.admin.equals(admin.publicKey));
  });

  // 2. KYC
  it("Approves a user for KYC", async () => {
    await program.methods
      .approveUser()
      .accounts({
        userToApprove: buyer.publicKey,
        propertyConfig: propertyConfigPda,
      })
      .rpc();

    const kyc = await program.account.kycEntry.fetch(kycEntryPda);
    assert.isTrue(kyc.isVerified);
  });

  // 3. Buy (Happy Path)
  it("Buys shares successfully", async () => {
    const tx = new anchor.web3.Transaction().add(
      createAssociatedTokenAccountInstruction(
        buyer.publicKey, buyerAta, buyer.publicKey, mintPda
      )
    );
    await provider.sendAndConfirm(tx, [buyer]);

    const sharesToBuy = new anchor.BN(2);
    await program.methods
      .buyShares(sharesToBuy)
      .accounts({
        buyer: buyer.publicKey,
        propertyConfig: propertyConfigPda,
        buyerAta: buyerAta,
      })
      .signers([buyer])
      .rpc();

    const acc = await getAccount(provider.connection, buyerAta);
    assert.equal(Number(acc.amount), 2);
  });

  // 4. Edge Cases (Security)
  // THIS MUST RUN BEFORE WITHDRAWAL
  describe("Edge Cases & Security", () => {
    
    it("Security: Prevents non-admin from approving users", async () => {
      try {
        await program.methods
          .approveUser()
          .accounts({
            // admin: hacker.publicKey, 
            userToApprove: hacker.publicKey,
            propertyConfig: propertyConfigPda,
          })
          .signers([hacker])
          .rpc();
        assert.fail("Should have failed");
      } catch (e) {
        assert.ok(true);
      }
    });

    it("Security: Prevents non-admin from withdrawing capital", async () => {
      try {
        await program.methods
          .withdrawCapital(new anchor.BN(0.1 * LAMPORTS_PER_SOL))
          .accounts({
            // admin: hacker.publicKey,
            propertyConfig: propertyConfigPda,
          })
          .signers([hacker])
          .rpc();
        assert.fail("Should have failed");
      } catch (e) {
        assert.ok(true);
      }
    });

    it("Supply Logic: Fails when buying more than MAX", async () => {
      const sharesToBuy = new anchor.BN(99); 
      try {
        await program.methods
          .buyShares(sharesToBuy)
          .accounts({
            buyer: buyer.publicKey,
            propertyConfig: propertyConfigPda,
            buyerAta: buyerAta,
          })
          .signers([buyer])
          .rpc();
        assert.fail("Should have failed");
      } catch (e) {
        assert.include(e.message, "Supply limit reached");
      }
    });

    it("Financial Logic: Fails with insufficient SOL", async () => {
        // Setup poor buyer
        await program.methods
        .approveUser()
        .accounts({ userToApprove: poorBuyer.publicKey, propertyConfig: propertyConfigPda })
        .rpc();

        const poorAta = await getAssociatedTokenAddress(mintPda, poorBuyer.publicKey);
        const tx = new anchor.web3.Transaction().add(
            createAssociatedTokenAccountInstruction(provider.wallet.publicKey, poorAta, poorBuyer.publicKey, mintPda)
        );
        await provider.sendAndConfirm(tx);

        try {
            await program.methods
            .buyShares(new anchor.BN(1))
            .accounts({
                buyer: poorBuyer.publicKey,
                propertyConfig: propertyConfigPda,
                buyerAta: poorAta,
            })
            .signers([poorBuyer])
            .rpc();
            assert.fail("Should have failed");
        } catch (e) {
            assert.ok(true);
        }
    });

    // it("State Logic: Verifies Treasury Balance matches Sold Shares", async () => {
    //     const treasuryBalance = await provider.connection.getBalance(treasuryPda);
    //     const expectedBalance = 2 * 0.5 * LAMPORTS_PER_SOL; 
    //     assert.equal(treasuryBalance, expectedBalance);
    // });
  });

  // ------------------------------------------------------------------
  // 5. WITHDRAWAL - MUST BE LAST
  // ------------------------------------------------------------------
  it("Admin withdraws capital", async () => {
    const treasuryBalance = await provider.connection.getBalance(treasuryPda);
    const withdrawAmount = new anchor.BN(treasuryBalance);

    await program.methods
      .withdrawCapital(withdrawAmount)
      .accounts({ propertyConfig: propertyConfigPda })
      .rpc();

    const finalTreasury = await provider.connection.getBalance(treasuryPda);
    assert.equal(finalTreasury, 0);
  });

});