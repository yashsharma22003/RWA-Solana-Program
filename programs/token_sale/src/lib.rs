use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer, Transfer};
use anchor_spl::token::{mint_to, Mint, MintTo, Token, TokenAccount};

declare_id!("8GN9gEDfFGksvVKwfquUat3kAei7wZ6Ajw9cWRxz9q2P");

#[program]
pub mod real_estate_tokenization {
    use super::*;

    // 1. Initialize Property (Dynamic: requires property_id)
    pub fn initialize_property(
        ctx: Context<InitializeProperty>,
        property_id: u64, // <--- Unique ID for this property
        price_per_share: u64,
        max_shares: u64,
    ) -> Result<()> {
        let property_config = &mut ctx.accounts.property_config;
        property_config.property_id = property_id;
        property_config.admin = ctx.accounts.admin.key();
        property_config.price_per_share = price_per_share;
        property_config.max_shares = max_shares;
        property_config.shares_sold = 0;
        property_config.bump = ctx.bumps.property_config;
        Ok(())
    }

    // 2. KYC Approval (Global: Verified once, works for all properties)
    pub fn approve_user(ctx: Context<ApproveUser>) -> Result<()> {
        let kyc_entry = &mut ctx.accounts.kyc_entry;
        kyc_entry.user = ctx.accounts.user_to_approve.key();
        kyc_entry.is_verified = true;
        Ok(())
    }

    // 3. Revoke KYC
    pub fn revoke_user(ctx: Context<RevokeUser>) -> Result<()> {
        let kyc_entry = &mut ctx.accounts.kyc_entry;
        kyc_entry.is_verified = false;
        Ok(())
    }

    // 4. Buy Shares (Dynamic: requires property_id)
    pub fn buy_shares(
        ctx: Context<BuyShares>, 
        property_id: u64, // <--- Unique ID to find the correct mint
        amount_of_shares: u64
    ) -> Result<()> {
        let config = &mut ctx.accounts.property_config;

        // A. Validation Checks
        require!(ctx.accounts.kyc_entry.is_verified, Errors::UserNotKycVerified);
        
        let current_supply = ctx.accounts.mint.supply;
        let new_supply = current_supply.checked_add(amount_of_shares).ok_or(Errors::Overflow)?;
        require!(new_supply <= config.max_shares, Errors::SupplyLimitReached);

        // B. Mint Shares to RECEIVER ATA
        // We must include the property_id bytes in the seeds to sign correctly
        let id_bytes = property_id.to_le_bytes();
        let seeds = &[
            b"property_mint".as_ref(),
            id_bytes.as_ref(), // <--- Added ID to signer seeds
            &[ctx.bumps.mint],
        ];
        let signer = &[&seeds[..]];

        let mint_to_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            MintTo {
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.receiver_ata.to_account_info(),
                authority: ctx.accounts.mint.to_account_info(),
            },
            signer,
        );
        mint_to(mint_to_ctx, amount_of_shares)?;

        // Update State
        config.shares_sold = new_supply;

        Ok(())
    }

    // 5. Withdraw Capital (Dynamic: Admin needs to prove ownership of specific property config)
    pub fn withdraw_capital(ctx: Context<WithdrawCapital>, _property_id: u64, amount: u64) -> Result<()> {
        let treasury = &ctx.accounts.treasury;
        require!(treasury.lamports() >= amount, Errors::InsufficientFunds);

        let bump = ctx.bumps.treasury;
        let seeds = &[b"treasury".as_ref(), &[bump]];
        let signer = &[&seeds[..]];

        let transfer_ctx = CpiContext::new_with_signer(
            ctx.accounts.system_program.to_account_info(),
            Transfer {
                from: treasury.to_account_info(),
                to: ctx.accounts.admin.to_account_info(),
            },
            signer,
        );

        transfer(transfer_ctx, amount)?;
        Ok(())
    }
}

// --- Context Structure ---

#[derive(Accounts)]
#[instruction(property_id: u64)] // <--- 1. Instruction Attribute
pub struct InitializeProperty<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        init, 
        payer = admin, 
        space = 8 + PropertyConfig::INIT_SPACE,
        // 2. Dynamic Seed for Config
        seeds = [b"config", property_id.to_le_bytes().as_ref()], 
        bump
    )]
    pub property_config: Account<'info, PropertyConfig>,

    #[account(
        init, 
        payer = admin, 
        // 3. Dynamic Seed for Mint
        seeds = [b"property_mint", property_id.to_le_bytes().as_ref()], 
        bump,
        mint::decimals = 0, 
        mint::authority = mint, 
    )]
    pub mint: Account<'info, Mint>,

    /// CHECK: Global Treasury (Shared across all properties)
    #[account(seeds = [b"treasury"], bump)]
    pub treasury: AccountInfo<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ApproveUser<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    /// CHECK: Public key of user getting KYC'd
    pub user_to_approve: UncheckedAccount<'info>,
    
    // Note: Removed PropertyConfig check here so KYC is global/platform-wide
    
    #[account(
        init_if_needed, payer = admin, space = 8 + KycEntry::INIT_SPACE,
        seeds = [b"kyc", user_to_approve.key().as_ref()], bump
    )]
    pub kyc_entry: Account<'info, KycEntry>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RevokeUser<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    /// CHECK: User to revoke
    pub user_to_revoke: UncheckedAccount<'info>,
    #[account(
        mut, seeds = [b"kyc", user_to_revoke.key().as_ref()], bump,
    )]
    pub kyc_entry: Account<'info, KycEntry>,
}

#[derive(Accounts)]
#[instruction(property_id: u64)] // <--- 1. Instruction Attribute
pub struct BuyShares<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,

    /// CHECK: The user receiving the shares
    pub receiver: UncheckedAccount<'info>,

    #[account(
        mut,
        // 2. Validate Config using ID
        seeds = [b"config", property_id.to_le_bytes().as_ref()],
        bump
    )]
    pub property_config: Account<'info, PropertyConfig>,

    // Global KYC Check
    #[account(
        seeds = [b"kyc", receiver.key().as_ref()],
        bump,
        constraint = kyc_entry.user == receiver.key(),
        constraint = kyc_entry.is_verified == true @ Errors::UserNotKycVerified
    )]
    pub kyc_entry: Account<'info, KycEntry>,

    #[account(
        mut,
        // 3. Validate Mint using ID
        seeds = [b"property_mint", property_id.to_le_bytes().as_ref()],
        bump
    )]
    pub mint: Account<'info, Mint>,

    #[account(
        mut,
        token::mint = mint,
        token::authority = receiver, 
    )]
    pub receiver_ata: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(property_id: u64)] // <--- 1. Instruction Attribute
pub struct WithdrawCapital<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    
    // Check that signer is the admin of THIS specific property
    #[account(
        has_one = admin @ Errors::Unauthorized,
        seeds = [b"config", property_id.to_le_bytes().as_ref()],
        bump
    )]
    pub property_config: Account<'info, PropertyConfig>,

    /// CHECK: Global Treasury
    #[account(mut, seeds = [b"treasury"], bump)]
    pub treasury: AccountInfo<'info>,
    pub system_program: Program<'info, System>,
}

// --- State Structs ---

#[account]
#[derive(InitSpace)]
pub struct PropertyConfig {
    pub property_id: u64, // Added ID to state
    pub admin: Pubkey,
    pub price_per_share: u64,
    pub max_shares: u64,
    pub shares_sold: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct KycEntry {
    pub user: Pubkey,
    pub is_verified: bool,
}

// --- Errors ---

#[error_code]
pub enum Errors {
    #[msg("Unauthorized access")]
    Unauthorized,
    #[msg("Supply limit reached for this property")]
    SupplyLimitReached,
    #[msg("Math overflow")]
    Overflow,
    #[msg("Receiver is not KYC verified/Whitelisted")]
    UserNotKycVerified,
    #[msg("Insufficient funds in treasury")]
    InsufficientFunds,
}