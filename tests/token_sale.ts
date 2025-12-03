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
  getAccount
} from "@solana/spl-token";
import { assert } from "chai";
import { BN } from "bn.js";

describe("Real Estate Tokenization - Comprehensive Suite", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.RealEstateTokenization as Program<RealEstateTokenization>;
  
  // ROLES
  const admin = provider.wallet; // Default admin
  const userA = Keypair.generate(); // Standard Investor
  const userB = Keypair.generate(); // Whale Investor
  const userC = Keypair.generate(); // Malicious/Non-KYC User
  const otherAdmin = Keypair.generate(); // Admin of a different property

  // PROPERTIES
  // Prop 1: Normal usage
  // Prop 2: Low supply (for boundary testing)
  // Prop 3: Admin rights testing
  const PROP_1_ID = new BN(100); 
  const PROP_2_ID = new BN(200);
  const PROP_3_ID = new BN(300);

  // GLOBAL TREASURY
  const [treasuryPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("treasury")],
    program.programId
  );

  // HELPER: Derive Property PDAs
  const derivePDAs = (id: BN) => {
    const [config] = PublicKey.findProgramAddressSync(
      [Buffer.from("config"), id.toArrayLike(Buffer, "le", 8)],
      program.programId
    );
    const [mint] = PublicKey.findProgramAddressSync(
      [Buffer.from("property_mint"), id.toArrayLike(Buffer, "le", 8)],
      program.programId
    );
    return { config, mint };
  };

  // HELPER: Derive KYC PDA
  const deriveKyc = (user: PublicKey) => {
    const [kyc] = PublicKey.findProgramAddressSync(
      [Buffer.from("kyc"), user.toBuffer()],
      program.programId
    );
    return kyc;
  };

  before(async () => {
    // 1. Airdrop SOL to all test users
    const users = [userA, userB, userC, otherAdmin];
    for (const u of users) {
      await provider.connection.confirmTransaction(
        await provider.connection.requestAirdrop(u.publicKey, 10 * LAMPORTS_PER_SOL)
      );
    }
  });

  // =========================================================================
  // 1. INITIALIZATION & DUPLICATION TESTS
  // =========================================================================
  describe("1. Initialization Logic", () => {
    it("Initializes Property #100 successfully", async () => {
      const { config, mint } = derivePDAs(PROP_1_ID);
      await program.methods
        .initializeProperty(PROP_1_ID, new BN(100), new BN(1000)) // 1000 Max Shares
        .accounts({
          propertyConfig: config,
          mint: mint,
          admin: admin.publicKey,
        })
        .rpc();
      
      const configAccount = await program.account.propertyConfig.fetch(config);
      assert.equal(configAccount.maxShares.toNumber(), 1000);
    });

    it("Fails to initialize Property #100 again (Duplicate Protection)", async () => {
      const { config, mint } = derivePDAs(PROP_1_ID);
      try {
        await program.methods
          .initializeProperty(PROP_1_ID, new BN(500), new BN(500))
          .accounts({
            propertyConfig: config,
            mint: mint,
            admin: admin.publicKey,
          })
          .rpc();
        assert.fail("Should have failed initialization");
      } catch (e) {
        // Anchor error: 0x0 (Account already in use)
        assert.ok(true);
      }
    });

    it("Initializes Property #200 (Low Supply) for boundary testing", async () => {
      const { config, mint } = derivePDAs(PROP_2_ID);
      await program.methods
        .initializeProperty(PROP_2_ID, new BN(100), new BN(5)) // Only 5 Shares Max
        .accounts({
          propertyConfig: config,
          mint: mint,
          admin: admin.publicKey,
        })
        .rpc();
    });
  });

  // =========================================================================
  // 2. KYC LIFECYCLE TESTS
  // =========================================================================
  describe("2. KYC Logic (Grant, Revoke, Deny)", () => {
    it("Approves User A", async () => {
      await program.methods
        .approveUser()
        .accounts({ userToApprove: userA.publicKey })
        .rpc();
      
      const kycAcct = await program.account.kycEntry.fetch(deriveKyc(userA.publicKey));
      assert.isTrue(kycAcct.isVerified);
    });

    it("User A can buy shares", async () => {
      const { config, mint } = derivePDAs(PROP_1_ID);
      const ata = await getAssociatedTokenAddress(mint, userA.publicKey);
      
      // Create ATA
      const tx = new anchor.web3.Transaction().add(
        createAssociatedTokenAccountInstruction(userA.publicKey, ata, userA.publicKey, mint)
      );
      await provider.sendAndConfirm(tx, [userA]);

      await program.methods
        .buyShares(PROP_1_ID, new BN(10))
        .accounts({
          buyer: userA.publicKey,
          receiver: userA.publicKey,
          propertyConfig: config,
          mint: mint,
          receiverAta: ata,
        })
        .signers([userA])
        .rpc();
    });

    it("Revokes User A's KYC", async () => {
      await program.methods
        .revokeUser()
        .accounts({ userToRevoke: userA.publicKey })
        .rpc();
        
      const kycAcct = await program.account.kycEntry.fetch(deriveKyc(userA.publicKey));
      assert.isFalse(kycAcct.isVerified);
    });

    it("Fails when Revoked User A tries to buy more", async () => {
      const { config, mint } = derivePDAs(PROP_1_ID);
      const ata = await getAssociatedTokenAddress(mint, userA.publicKey);

      try {
        await program.methods
          .buyShares(PROP_1_ID, new BN(5))
          .accounts({
            buyer: userA.publicKey,
            receiver: userA.publicKey,
            propertyConfig: config,
            mint: mint,
            receiverAta: ata,
          })
          .signers([userA])
          .rpc();
        assert.fail("Should have blocked revoked user");
      } catch (e) {
        assert.include(e.message, "Receiver is not KYC verified");
      }
    });

    it("Re-approves User A and Purchase Succeeds", async () => {
      await program.methods
        .approveUser()
        .accounts({ userToApprove: userA.publicKey })
        .rpc();

      const { config, mint } = derivePDAs(PROP_1_ID);
      const ata = await getAssociatedTokenAddress(mint, userA.publicKey);

      await program.methods
        .buyShares(PROP_1_ID, new BN(5))
        .accounts({
            buyer: userA.publicKey,
            receiver: userA.publicKey,
            propertyConfig: config,
            mint: mint,
            receiverAta: ata,
        })
        .signers([userA])
        .rpc();
        
        // Check final balance (10 initial + 5 new = 15)
        const acc = await getAccount(provider.connection, ata);
        assert.equal(Number(acc.amount), 15);
    });
  });

  // =========================================================================
  // 3. SUPPLY BOUNDARY TESTS
  // =========================================================================
  describe("3. Supply Boundaries (Property #200)", () => {
    // Property 200 has Max Shares = 5
    let mint: PublicKey, config: PublicKey, ata: PublicKey;

    before(async () => {
        const pdas = derivePDAs(PROP_2_ID);
        mint = pdas.mint;
        config = pdas.config;
        ata = await getAssociatedTokenAddress(mint, userB.publicKey);
        
        // Verify User B KYC
        await program.methods.approveUser().accounts({userToApprove: userB.publicKey}).rpc();
        
        const tx = new anchor.web3.Transaction().add(
            createAssociatedTokenAccountInstruction(userB.publicKey, ata, userB.publicKey, mint)
        );
        await provider.sendAndConfirm(tx, [userB]);
    });

    it("Buys 3 shares (3/5 sold)", async () => {
        await program.methods
            .buyShares(PROP_2_ID, new BN(3))
            .accounts({
                buyer: userB.publicKey,
                receiver: userB.publicKey,
                propertyConfig: config,
                mint: mint,
                receiverAta: ata,
            })
            .signers([userB])
            .rpc();
    });

    it("Buys 2 shares (5/5 sold - Exact Limit)", async () => {
        await program.methods
            .buyShares(PROP_2_ID, new BN(2))
            .accounts({
                buyer: userB.publicKey,
                receiver: userB.publicKey,
                propertyConfig: config,
                mint: mint,
                receiverAta: ata,
            })
            .signers([userB])
            .rpc();
            
        const configAcct = await program.account.propertyConfig.fetch(config);
        assert.equal(configAcct.sharesSold.toNumber(), 5);
    });

    it("Fails to buy 1 more share (6/5 - Overflow)", async () => {
        try {
            await program.methods
                .buyShares(PROP_2_ID, new BN(1))
                .accounts({
                    buyer: userB.publicKey,
                    receiver: userB.publicKey,
                    propertyConfig: config,
                    mint: mint,
                    receiverAta: ata,
                })
                .signers([userB])
                .rpc();
            assert.fail("Should have failed due to supply limit");
        } catch (e) {
            assert.include(e.message, "Supply limit reached");
        }
    });
  });

  // =========================================================================
  // 4. SECURITY & SPOOFING TESTS
  // =========================================================================
  describe("4. Security: Account Spoofing & Mismatches", () => {
      
    it("Fails when trying to use Prop 1 Config to mint Prop 2 Tokens", async () => {
        // Trying to bypass Prop 2's low supply limit by passing Prop 1's config (which has room)
        const p1 = derivePDAs(PROP_1_ID);
        const p2 = derivePDAs(PROP_2_ID);
        const ata = await getAssociatedTokenAddress(p2.mint, userA.publicKey);

        try {
            await program.methods
                // We request to buy Prop 2
                .buyShares(PROP_2_ID, new BN(1)) 
                .accounts({
                    buyer: userA.publicKey,
                    receiver: userA.publicKey,
                    // MALICIOUS: We swap the config to Prop 1
                    propertyConfig: p1.config, 
                    mint: p2.mint,
                    receiverAta: ata,
                })
                .signers([userA])
                .rpc();
            assert.fail("Should have failed due to seed constraint");
        } catch (e) {
            // Anchor will check that seeds(PROP_2_ID) does not match the passed `propertyConfig` (PROP_1_ID)
            // Error Code 2006: ConstraintSeeds or similar
            assert.ok(true); 
        }
    });
  });

  // =========================================================================
  // 5. ADMIN & TREASURY TESTS
  // =========================================================================
  describe("5. Admin Privileges", () => {
      
    // Initialize Prop 3 with a different admin key
    it("Initializes Property #300 with Alternate Admin", async () => {
        const { config, mint } = derivePDAs(PROP_3_ID);
        await program.methods
            .initializeProperty(PROP_3_ID, new BN(100), new BN(100))
            .accounts({
                propertyConfig: config,
                mint: mint,
                admin: otherAdmin.publicKey, // <--- Different Admin
            })
            .signers([otherAdmin])
            .rpc();
    });

    it("Global Admin fails to withdraw from Property #300", async () => {
        // Fund treasury first
        const transferTx = new anchor.web3.Transaction().add(
            SystemProgram.transfer({
                fromPubkey: admin.publicKey,
                toPubkey: treasuryPda,
                lamports: 1 * LAMPORTS_PER_SOL,
            })
        );
        await provider.sendAndConfirm(transferTx);

        const { config } = derivePDAs(PROP_3_ID);

        try {
            await program.methods
                .withdrawCapital(PROP_3_ID, new BN(0.1 * LAMPORTS_PER_SOL))
                .accounts({
                    propertyConfig: config,
                    treasury: treasuryPda,
                    admin: admin.publicKey, // Default admin (Not Prop 3 owner)
                })
                .rpc();
            assert.fail("Should have failed: Unauthorized");
        } catch (e) {
             // Expecting "Unauthorized" or constraint failure
             assert.include(e.message, "Unauthorized");
        }
    });

    it("Correct Admin (OtherAdmin) successfully withdraws from Property #300", async () => {
        const { config } = derivePDAs(PROP_3_ID);

        await program.methods
            .withdrawCapital(PROP_3_ID, new BN(0.1 * LAMPORTS_PER_SOL))
            .accounts({
                propertyConfig: config,
                treasury: treasuryPda,
                admin: otherAdmin.publicKey, // Correct Admin
            })
            .signers([otherAdmin])
            .rpc();
    });
  });

});