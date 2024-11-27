use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer, Approve};
use anchor_lang::solana_program::instruction::Instruction;
use anchor_lang::solana_program::sysvar::instructions::{ID as IX_ID, load_instruction_at_checked};
use anchor_lang::solana_program::account_info::AccountInfo as SolanaAccountInfo;

pub mod utils;

declare_id!("DfmArRxQL4usBuAv4QFA7PVhXf3c1KLremcoDDww9DG4");

const OWNER_OFFSET: usize = 8; // Skip discriminator (8 bytes).
const CLAIM_SIGNER_OFFSET: usize = OWNER_OFFSET + 32; // Skip 32 bytes.
const BITMAP_LEN_OFFSET: usize = CLAIM_SIGNER_OFFSET + 32; // Skip claim signer.
const INITIAL_STATE_BYTE_LEN: usize = BITMAP_LEN_OFFSET + 128;

#[program]
pub mod token_claimer {
    use super::*;

    /// Initialize the program state.
    pub fn initialize(ctx: Context<Initialize>, claim_signer: Pubkey) -> Result<()> {
        let state = &mut ctx.accounts.state;
        state.owner = ctx.accounts.owner.key();
        state.claim_signer = claim_signer;
        state.claimed_bitmap = Vec::new();
        Ok(())
    }

    /// Expands the bitmap by 10_000 bytes (80_000 bits).
    pub fn expand_bitmap(ctx: Context<ExpandBitmap>) -> Result<()> {
        let state_info = &ctx.accounts.state;

        // Check if the caller is the owner
        require!(
            ctx.accounts.owner.key()
                == Pubkey::new_from_array(
                    state_info.data.borrow()[OWNER_OFFSET..OWNER_OFFSET + 32]
                        .try_into()
                        .unwrap()
                ),
            CustomError::Unauthorized
        );

        let current_bitmap_len = u32::from_le_bytes(
            state_info.data.borrow()[BITMAP_LEN_OFFSET..BITMAP_LEN_OFFSET + 4]
                .try_into()
                .unwrap(),
        );
        let new_bitmap_len = current_bitmap_len + 10_000;
        require!(
            new_bitmap_len >= current_bitmap_len,
            CustomError::ExpandBitmapOverflow
        );
        let new_account_size = BITMAP_LEN_OFFSET + 4 + new_bitmap_len as usize;

        if new_account_size > state_info.data_len() {
            state_info.realloc(new_account_size, false)?;
        }

        state_info.data.borrow_mut()[BITMAP_LEN_OFFSET..BITMAP_LEN_OFFSET + 4]
            .copy_from_slice(&(new_bitmap_len as u32).to_le_bytes());

        Ok(())
    }

    /// Update the claim signer (only callable by the program owner).
    pub fn set_claim_signer(
        ctx: Context<SetClaimSigner>,
        new_claim_signer: Pubkey,
    ) -> Result<()> {
        // Owner check.
        require!(
            ctx.accounts.owner.key() == ctx.accounts.state.owner,
            CustomError::Unauthorized
        );
        // Update the state.
        let previous_claim_signer = ctx.accounts.state.claim_signer;
        ctx.accounts.state.claim_signer = new_claim_signer;
        // Emit the event.
        emit!(ClaimSignerUpdated {
            previous_claim_signer: previous_claim_signer,
            new_claim_signer: new_claim_signer,
        });
        Ok(())
    }

    /// Transfer ownership of the program.
    pub fn transfer_ownership(ctx: Context<TransferOwnership>, new_owner: Pubkey) -> Result<()> {
        // Owner check.
        require!(
            ctx.accounts.owner.key() == ctx.accounts.state.owner,
            CustomError::Unauthorized
        );
        // Update the state.
        let previous_owner = ctx.accounts.state.owner;
        ctx.accounts.state.owner = new_owner;
        // Emit the event.
        emit!(OwnershipTransferred {
            previous_owner: previous_owner,
            new_owner,
        });
        Ok(())
    }

    /// Process a claim for tokens with a valid signature.
    pub fn claim(
        ctx: Context<Claim>,
        ed25519_instruction_index: u32,
        claim_index: u64,
        amount: u64,
        signature: [u8; 64]
    ) -> Result<()> {
        let solana_account_info: SolanaAccountInfo = ctx.accounts.ix_sysvar.to_account_info();
        let ix: Instruction = load_instruction_at_checked(ed25519_instruction_index.try_into().unwrap(), &solana_account_info)
            .map_err(|_| CustomError::InvalidSignature)?;

        // Check if the claim index has already been processed.
        let byte_index = (claim_index >> 3) as usize; // Division by 8 (bit shift).
        let bit_index = (claim_index & 7) as u8; // Modulo 8 (bit mask).
        require!(
            byte_index < ctx.accounts.state.claimed_bitmap.len(),
            CustomError::InvalidClaimIndex
        );
        let bit_mask = 1 << bit_index;
        require!(
            ctx.accounts.state.claimed_bitmap[byte_index] & bit_mask == 0,
            CustomError::AlreadyClaimed
        );

        // Construct the message for hashing.
        let mut message = Vec::with_capacity(8 + 32 + 32 + 8);
        message.extend_from_slice(&claim_index.to_be_bytes()); // 8 bytes.
        message.extend_from_slice(&ctx.accounts.source_token_account.key().to_bytes()); // 32 bytes.
        message.extend_from_slice(&ctx.accounts.destination_token_account.key().to_bytes()); // 32 bytes.
        message.extend_from_slice(&amount.to_be_bytes()); // 8 bytes.

        let public_key_bytes = ctx.accounts.state.claim_signer.to_bytes();
        require!(utils::verify_ed25519_ix(&ix, &public_key_bytes, &message, &signature), CustomError::InvalidSignature);

        // Mark the claim as processed.
        ctx.accounts.state.claimed_bitmap[byte_index] |= bit_mask;

        // Transfer the tokens.
        // Ensure there are enough tokens in the source account.
        require!(
            ctx.accounts.source_token_account.amount >= amount,
            CustomError::InsufficientFunds
        );
        // Ensure the token program is correct.
        require!(
            ctx.accounts.token_program.key() == anchor_spl::token::ID,
            CustomError::InvalidTokenProgram
        );
        // Perform the token transfer.
        let binding = ctx.accounts.source_token_account.key();
        let seeds = &[
            b"delegate", 
            binding.as_ref(), 
            &[ctx.bumps.delegate],
        ];
        let signer = &[&seeds[..]];
        // Perform the token transfer.
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.source_token_account.to_account_info(),
                to: ctx.accounts.destination_token_account.to_account_info(),
                authority: ctx.accounts.delegate.to_account_info(),
            },
            signer,
        );
        token::transfer(cpi_ctx, amount)?;

        // Emit the claim event.
        emit!(ClaimProcessed {
            claimer: ctx.accounts.claimer.key(),
            claim_index,
            amount,
        });

        Ok(())
    }

    /// Withdraw SPL tokens from the program's token account (only callable by the owner).
    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        // Owner check.
        require!(
            ctx.accounts.owner.key() == ctx.accounts.state.owner,
            CustomError::Unauthorized
        );
        // Ensure there are enough tokens in the source account.
        require!(
            ctx.accounts.source_token_account.amount >= amount,
            CustomError::InsufficientFunds
        );
        // Ensure the token program is correct.
        require!(
            ctx.accounts.token_program.key() == anchor_spl::token::ID,
            CustomError::InvalidTokenProgram
        );
        let binding = ctx.accounts.source_token_account.key();
        let seeds = &[
            b"delegate", 
            binding.as_ref(), 
            &[ctx.bumps.delegate],
        ];
        let signer = &[&seeds[..]];
        // Perform the token transfer.
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.source_token_account.to_account_info(),
                to: ctx.accounts.destination_token_account.to_account_info(),
                authority: ctx.accounts.delegate.to_account_info(),
            },
            signer,
        );
        token::transfer(cpi_ctx, amount)?;

        Ok(())
    }


    pub fn approve_delegate(ctx: Context<ApproveDelegate>, amount: u64) -> Result<()> {
        let cpi_accounts = Approve {
            to: ctx.accounts.token_account.to_account_info(),
            delegate: ctx.accounts.delegate.to_account_info(),
            authority: ctx.accounts.authority.to_account_info(),
        };

        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);

        token::approve(cpi_ctx, amount)?;

        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(init, payer = owner, space = 8 + State::LEN)]
    pub state: Account<'info, State>,
    #[account(mut)]
    pub owner: Signer<'info>, // `msg.sender`.
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ExpandBitmap<'info> {
    #[account(mut)]
    /// CHECK: make sure state is properly resized.
    pub state: AccountInfo<'info>,
    pub owner: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ApproveDelegate<'info> {
    #[account(mut)]
    pub token_account: Account<'info, TokenAccount>, // Source SPL token account
    #[account(
        seeds = [b"delegate", token_account.key().as_ref()],
        bump
    )]
    /// CHECK: The PDA delegated to transfer tokens.
    pub delegate: AccountInfo<'info>, 
    pub authority: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct SetClaimSigner<'info> {
    #[account(mut)]
    pub state: Account<'info, State>,
    pub owner: Signer<'info>, // `msg.sender`.
}

#[derive(Accounts)]
pub struct TransferOwnership<'info> {
    #[account(mut)]
    pub state: Account<'info, State>,
    pub owner: Signer<'info>, // `msg.sender`.
}

#[derive(Accounts)]
pub struct Claim<'info> {
    #[account(mut)]
    pub state: Account<'info, State>,
    #[account(mut)]
    pub source_token_account: Account<'info, TokenAccount>,
    #[account(mut)]
    /// CHECK: The destination account for the tokens. Might not exist yet.
    pub destination_token_account: AccountInfo<'info>,
    #[account(
        seeds = [b"delegate", source_token_account.key().as_ref()],
        bump
    )]
    /// CHECK: The PDA delegated to transfer tokens.
    pub delegate: AccountInfo<'info>,
    pub claimer: Signer<'info>, // `msg.sender`.
    pub token_program: Program<'info, Token>,
    /// CHECK: The address check is needed because otherwise
    /// the supplied Sysvar could be anything else.
    /// The Instruction Sysvar has not been implemented
    /// in the Anchor framework yet, so this is the safe approach.
    #[account(address = IX_ID)]
    pub ix_sysvar: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(mut)]
    pub state: Account<'info, State>, 
    #[account(mut)]
    pub source_token_account: Account<'info, TokenAccount>, 
    #[account(mut)]
    pub destination_token_account: Account<'info, TokenAccount>,
    #[account(
        seeds = [b"delegate", source_token_account.key().as_ref()],
        bump
    )]
    /// CHECK: The PDA delegated to transfer tokens.
    pub delegate: AccountInfo<'info>,
    pub owner: Signer<'info>, // Program owner
    pub token_program: Program<'info, Token>, // SPL token program
}

#[account]
pub struct State {
    pub owner: Pubkey,           // Program owner's public key.
    pub claim_signer: Pubkey,    // Public key of the claim signer.
    pub claimed_bitmap: Vec<u8>, // Fixed-size bitmap for tracking claimed indices.
}

impl State {
    pub const LEN: usize = INITIAL_STATE_BYTE_LEN;
}

#[error_code]
pub enum CustomError {
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("Invalid claim index")]
    InvalidClaimIndex,
    #[msg("Claim already made")]
    AlreadyClaimed,
    #[msg("Invalid signature")]
    InvalidSignature,
    #[msg("Invalid token program")]
    InvalidTokenProgram,
    #[msg("Insufficient funds")]
    InsufficientFunds,
    #[msg("Invalid destination account")]
    InvalidDestinationAccount,
    #[msg("Expand bitmap overflow")]
    ExpandBitmapOverflow,
}

#[event]
pub struct ClaimProcessed {
    pub claimer: Pubkey,
    pub claim_index: u64,
    pub amount: u64,
}

#[event]
pub struct OwnershipTransferred {
    pub previous_owner: Pubkey,
    pub new_owner: Pubkey,
}

#[event]
pub struct ClaimSignerUpdated {
    pub previous_claim_signer: Pubkey,
    pub new_claim_signer: Pubkey,
}
