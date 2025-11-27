use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer, Transfer};
use anchor_spl::token::{mint_to, Mint, MintTo, Token, TokenAccount};

declare_id!("8GN9gEDfFGksvVKwfquUat3kAei7wZ6Ajw9cWRxz9q2P");

#[program]
pub mod real_estate_tokenization {
    use super::*;

    // 1. Initialize the Property (Token Mint + Config)
    // Sets the price per share and the max supply (total shares available)
    pub fn initialize_property(
        ctx: Context<InitializeProperty>, 
        price_per_share: u64, 
        max_shares: u64
    ) -> Result<()> {
        let property_config = &mut ctx.accounts.property_config;
        property_config.admin = ctx.accounts.admin.key();
        property_config.price_per_share = price_per_share;
        property_config.max_shares = max_shares;
        property_config.shares_sold = 0;
        property_config.bump = ctx.bumps.property_config;
        Ok(())
    }

    // 2. KYC Approval (Admin Whitelists a User)
    // The admin creates a PDA for the user. If this PDA exists, the user is "Verified".
    pub fn approve_user(ctx: Context<ApproveUser>) -> Result<()> {
        let kyc_entry = &mut ctx.accounts.kyc_entry;
        kyc_entry.user = ctx.accounts.user_to_approve.key();
        kyc_entry.is_verified = true;
        Ok(())
    }

    // 3. Revoke KYC (Admin removes approval)
    pub fn revoke_user(ctx: Context<RevokeUser>) -> Result<()> {
        let kyc_entry = &mut ctx.accounts.kyc_entry;
        kyc_entry.is_verified = false;
        Ok(())
    }

    // 4. Buy Shares (Mint)
    // Requires the user to have a valid KYC Entry
    pub fn buy_shares(ctx: Context<BuyShares>, amount_of_shares: u64) -> Result<()> {
        let config = &mut ctx.accounts.property_config;

        // A. Validation Checks
        require!(ctx.accounts.kyc_entry.is_verified, Errors::UserNotKycVerified);
        
        let current_supply = ctx.accounts.mint.supply;
        let new_supply = current_supply.checked_add(amount_of_shares).ok_or(Errors::Overflow)?;
        require!(new_supply <= config.max_shares, Errors::SupplyLimitReached);

        // B. Calculate Cost (Shares * Price)
        let total_cost_lamports = amount_of_shares
            .checked_mul(config.price_per_share)
            .ok_or(Errors::Overflow)?;

        // C. Transfer SOL from Buyer to Treasury
        let transfer_instruction = Transfer {
            from: ctx.accounts.buyer.to_account_info(),
            to: ctx.accounts.treasury.to_account_info(),
        };

        let cpi_context = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            transfer_instruction,
        );
        transfer(cpi_context, total_cost_lamports)?;

        // D. Mint Shares (Tokens) to Buyer
        // We sign with the Mint PDA seeds
        let seeds = &[
            b"property_mint".as_ref(),
            &[ctx.bumps.mint],
        ];
        let signer = &[&seeds[..]];

        let mint_to_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            MintTo {
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.buyer_ata.to_account_info(),
                authority: ctx.accounts.mint.to_account_info(),
            },
            signer,
        );
        mint_to(mint_to_ctx, amount_of_shares)?;

        // Update State
        config.shares_sold = new_supply;

        Ok(())
    }

    // 5. Withdraw Capital (Admin only)
    pub fn withdraw_capital(ctx: Context<WithdrawCapital>, amount: u64) -> Result<()> {
        let treasury = &ctx.accounts.treasury;
        
        require!(treasury.lamports() >= amount, Errors::InsufficientFunds);

        let bump = ctx.bumps.treasury;
        let seeds = &[
            b"treasury".as_ref(),
            &[bump],
        ];
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
pub struct InitializeProperty<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    // Stores price and total supply info
    #[account(
        init,
        payer = admin,
        space = 8 + PropertyConfig::INIT_SPACE,
        seeds = [b"config"],
        bump
    )]
    pub property_config: Account<'info, PropertyConfig>,

    // The Token representing the Real Estate Shares
    #[account(
        init,
        payer = admin,
        seeds = [b"property_mint"],
        bump,
        mint::decimals = 0, // 0 decimals = 1 Share is indivisible
        mint::authority = mint, 
    )]
    pub mint: Account<'info, Mint>,

    /// CHECK: Treasury wallet for funds
    #[account(
        seeds = [b"treasury"],
        bump
    )]
    pub treasury: AccountInfo<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ApproveUser<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    /// CHECK: The public key of the user getting KYC'd
    pub user_to_approve: UncheckedAccount<'info>,

    #[account(
        has_one = admin @ Errors::Unauthorized // Only admin in config can approve
    )]
    pub property_config: Account<'info, PropertyConfig>,

    // Create a record verifying this specific user
    #[account(
        init_if_needed,
        payer = admin,
        space = 8 + KycEntry::INIT_SPACE,
        seeds = [b"kyc", user_to_approve.key().as_ref()],
        bump
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

    #[account(has_one = admin)]
    pub property_config: Account<'info, PropertyConfig>,

    #[account(
        mut,
        seeds = [b"kyc", user_to_revoke.key().as_ref()],
        bump,
    )]
    pub kyc_entry: Account<'info, KycEntry>,
}

#[derive(Accounts)]
pub struct BuyShares<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,

    #[account(mut)]
    pub property_config: Account<'info, PropertyConfig>,

    // Ensure the buyer has a valid KYC entry
    #[account(
        seeds = [b"kyc", buyer.key().as_ref()],
        bump,
        constraint = kyc_entry.user == buyer.key(),
        constraint = kyc_entry.is_verified == true @ Errors::UserNotKycVerified
    )]
    pub kyc_entry: Account<'info, KycEntry>,

    #[account(
        mut,
        seeds = [b"property_mint"],
        bump
    )]
    pub mint: Account<'info, Mint>,

    #[account(
        mut,
        token::mint = mint,
        token::authority = buyer,
    )]
    pub buyer_ata: Account<'info, TokenAccount>,

    /// CHECK: Treasury
    #[account(
        mut,
        seeds = [b"treasury"],
        bump
    )]
    pub treasury: AccountInfo<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct WithdrawCapital<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        has_one = admin @ Errors::Unauthorized
    )]
    pub property_config: Account<'info, PropertyConfig>,

    /// CHECK: Treasury
    #[account(mut, seeds = [b"treasury"], bump)]
    pub treasury: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

// --- State Structs ---

#[account]
#[derive(InitSpace)]
pub struct PropertyConfig {
    pub admin: Pubkey,
    pub price_per_share: u64, // in Lamports
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
    #[msg("User is not KYC verified/Whitelisted")]
    UserNotKycVerified,
    #[msg("Insufficient funds in treasury")]
    InsufficientFunds,
}