use anchor_lang::prelude::*;
use anchor_lang::solana_program::keccak;
use anchor_lang::solana_program::sysvar::instructions::{load_instruction_at_checked, ID as IX_ID};
use anchor_spl::token::{self, Approve, Revoke, Token, TokenAccount, Transfer};
use anchor_lang::solana_program::sysvar::clock::Clock;

pub mod utils;

declare_id!("DfmArRxQL4usBuAv4QFA7PVhXf3c1KLremcoDDww9DG4");

const DISCIMINATOR_LEN: usize = 8;
const OWNER_OFFSET: usize = DISCIMINATOR_LEN; // Skip discriminator (8 bytes).
const CLAIM_SIGNER_OFFSET: usize = OWNER_OFFSET + 32; // Skip 32 bytes.
const BITMAP_LEN_OFFSET: usize = CLAIM_SIGNER_OFFSET + 32; // Skip claim signer.
const BITMAP_BYTES_OFFSET: usize = BITMAP_LEN_OFFSET + 4; // Skip bitmap length.
const INITIAL_STATE_BYTE_LEN: usize = BITMAP_BYTES_OFFSET + 128;

macro_rules! state_slice {
    ($ctx:expr, $start:expr, $n:expr) => {
        $ctx.accounts.state.data.borrow_mut()[$start..$start + $n]
    };
}

macro_rules! state_pubkey_slice {
    ($ctx:expr, $start:expr) => {
        state_slice!($ctx, $start, 32)
    };
}

macro_rules! state_pubkey {
    ($ctx:expr, $start:expr) => {
        Pubkey::new_from_array(state_pubkey_slice!($ctx, $start).try_into().unwrap())
    };
}

macro_rules! only_owner {
    ($ctx:expr) => {
        require!(
            $ctx.accounts.owner.key() == state_pubkey!($ctx, OWNER_OFFSET),
            CustomError::Unauthorized
        );
    };
}

macro_rules! state_bitmap_len {
    ($ctx:expr) => {
        u32::from_le_bytes(state_slice!($ctx, BITMAP_LEN_OFFSET, 4).try_into().unwrap())
    };
}

macro_rules! state_claim_bitmap_byte {
    ($ctx:expr, $i:expr) => {
        // The program will panic if the state account doesn't have enough space.
        $ctx.accounts.state.data.borrow_mut()[BITMAP_BYTES_OFFSET + $i as usize]
    };
}

macro_rules! state_copy_from_bytes {
    ($ctx:expr, $start:expr, $source:expr) => {{
        let len = $source.len();
        state_slice!($ctx, $start, len).copy_from_slice($source);
    }};
}

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
        only_owner!(ctx);

        let current_bitmap_len: u32 = state_bitmap_len!(ctx);
        let new_bitmap_len: u32 = current_bitmap_len.saturating_add(10_000);
        let new_account_size = BITMAP_BYTES_OFFSET + new_bitmap_len as usize;

        let state_info = &ctx.accounts.state;
        if new_account_size > state_info.data_len() {
            state_info.realloc(new_account_size, false)?;
        }

        state_copy_from_bytes!(ctx, BITMAP_LEN_OFFSET, &new_bitmap_len.to_le_bytes());

        Ok(())
    }

    /// Update the claim signer (only callable by the program owner).
    pub fn set_claim_signer(ctx: Context<SetClaimSigner>, new_claim_signer: Pubkey) -> Result<()> {
        only_owner!(ctx);

        let previous_claim_signer = state_pubkey!(ctx, CLAIM_SIGNER_OFFSET);
        state_copy_from_bytes!(ctx, CLAIM_SIGNER_OFFSET, &new_claim_signer.to_bytes());

        emit!(ClaimSignerUpdated {
            previous_claim_signer: previous_claim_signer,
            new_claim_signer: new_claim_signer,
        });

        Ok(())
    }

    /// Transfer ownership of the program.
    pub fn transfer_ownership(ctx: Context<TransferOwnership>, new_owner: Pubkey) -> Result<()> {
        only_owner!(ctx);

        let previous_owner = state_pubkey!(ctx, OWNER_OFFSET);
        state_copy_from_bytes!(ctx, OWNER_OFFSET, &new_owner.to_bytes());

        emit!(OwnershipTransferred {
            previous_owner: previous_owner,
            new_owner,
        });

        Ok(())
    }

    /// Process a claim for tokens with a valid signature.
    pub fn claim(ctx: Context<Claim>, claim_indices: Vec<u32>, total_amount: u64, expiry: u32) -> Result<()> {
        let clock = Clock::get()?;
        require!(clock.unix_timestamp < expiry.into(), CustomError::ClaimExpired);
        let solana_account_info = ctx.accounts.ix_sysvar.to_account_info();
        let message = keccak::hashv(&[
            keccak::hash(
                &claim_indices
                    .iter()
                    .flat_map(|index| index.to_le_bytes())
                    .collect::<Vec<u8>>(),
            )
            .as_ref(),
            ctx.accounts.claimer.key().as_ref(),
            ctx.accounts.source_token_account.key().as_ref(),
            ctx.accounts.destination_token_account.key().as_ref(),
            total_amount.to_le_bytes().as_slice(),
            expiry.to_le_bytes().as_slice(),
        ])
        .0;
        let mut has_valid_signature = false;
        for i in 0..64 {
            if let Ok(ix) = load_instruction_at_checked(i, &solana_account_info) {
                // Verify the Ed25519 signature for the instruction
                if utils::verify_ed25519_ix(
                    &ix,
                    &state_pubkey_slice!(ctx, CLAIM_SIGNER_OFFSET),
                    &message,
                ) {
                    has_valid_signature = true;
                    break;
                }
            } else {
                break; // Stop iterating if no more instructions are available.
            }
        }
        require!(has_valid_signature, CustomError::InvalidSignature);

        for claim_index in claim_indices.iter() {
            // Check if the claim index has already been processed.
            let byte_index = claim_index >> 3; // Division by 8 (bit shift).
            let bit_mask = 1 << ((claim_index & 7) as u8); // Modulo 8 (bit mask).
            require!(
                state_claim_bitmap_byte!(ctx, byte_index) & bit_mask == 0,
                CustomError::AlreadyClaimed
            );
            // Mark the claim as processed.
            state_claim_bitmap_byte!(ctx, byte_index) |= bit_mask;
        }

        // Ensure there are enough tokens in the source account.
        require!(
            ctx.accounts.source_token_account.amount >= total_amount,
            CustomError::InsufficientFunds
        );
        // Ensure the token program is correct.
        require!(
            ctx.accounts.token_program.key() == anchor_spl::token::ID,
            CustomError::InvalidTokenProgram
        );
        // Transfer the tokens.
        let binding = ctx.accounts.source_token_account.key();
        let seeds = &[b"delegate", binding.as_ref(), &[ctx.bumps.delegate]];
        let signer = &[&seeds[..]];
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.source_token_account.to_account_info(),
                to: ctx.accounts.destination_token_account.to_account_info(),
                authority: ctx.accounts.delegate.to_account_info(),
            },
            signer,
        );
        token::transfer(cpi_ctx, total_amount)?;

        emit!(ClaimProcessed {
            claimer: ctx.accounts.claimer.key(),
            claim_indices,
            total_amount,
        });

        Ok(())
    }

    /// Unset a claim index.
    pub fn unset_claim_indices(
        ctx: Context<UnsetClaimIndex>,
        claim_indices: Vec<u32>,
    ) -> Result<()> {
        only_owner!(ctx);

        for claim_index in claim_indices.iter() {
            let byte_index = claim_index >> 3; // Division by 8 (bit shift).
            let bit_mask = 1 << ((claim_index & 7) as u8); // Modulo 8 (bit mask).
            state_claim_bitmap_byte!(ctx, byte_index) &= !bit_mask;
        }

        Ok(())
    }

    /// Approve the program's PDA to transfer tokens.
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

    /// Revoke the program's PDA's ability to transfer tokens.
    pub fn revoke_delegate(ctx: Context<RevokeDelegate>) -> Result<()> {
        let cpi_accounts = Revoke {
            source: ctx.accounts.token_account.to_account_info(),
            authority: ctx.accounts.authority.to_account_info(),
        };

        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);

        token::revoke(cpi_ctx)?;

        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(init, payer = owner, space = DISCIMINATOR_LEN + State::LEN)]
    pub state: Account<'info, State>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ExpandBitmap<'info> {
    /// CHECK: We'll rawdog the state.
    #[account(mut)]
    pub state: AccountInfo<'info>,
    pub owner: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ApproveDelegate<'info> {
    #[account(mut)]
    pub token_account: Account<'info, TokenAccount>, // Source SPL token account
    /// CHECK: The PDA delegated to transfer tokens.
    #[account(
        seeds = [b"delegate", token_account.key().as_ref()],
        bump
    )]
    pub delegate: AccountInfo<'info>,
    pub authority: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct RevokeDelegate<'info> {
    #[account(mut)]
    pub token_account: Account<'info, TokenAccount>, // Source SPL token account
    /// CHECK: The PDA delegated to transfer tokens.
    #[account(
        seeds = [b"delegate", token_account.key().as_ref()],
        bump
    )]
    pub delegate: AccountInfo<'info>,
    pub authority: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct SetClaimSigner<'info> {
    /// CHECK: We'll rawdog the state.
    #[account(mut)]
    pub state: AccountInfo<'info>,
    pub owner: Signer<'info>,
}

#[derive(Accounts)]
pub struct TransferOwnership<'info> {
    /// CHECK: We'll rawdog the state.
    #[account(mut)]
    pub state: AccountInfo<'info>,
    pub owner: Signer<'info>,
}

#[derive(Accounts)]
pub struct UnsetClaimIndex<'info> {
    /// CHECK: We'll rawdog the state.
    #[account(mut)]
    pub state: AccountInfo<'info>,
    pub owner: Signer<'info>,
}

#[derive(Accounts)]
pub struct Claim<'info> {
    /// CHECK: We'll rawdog the state.
    #[account(mut)]
    pub state: AccountInfo<'info>,
    #[account(mut)]
    pub source_token_account: Account<'info, TokenAccount>,
    /// CHECK: The destination account for the tokens.
    #[account(mut)]
    pub destination_token_account: AccountInfo<'info>,
    /// CHECK: The PDA delegated to transfer tokens.
    #[account(
        seeds = [b"delegate", source_token_account.key().as_ref()],
        bump
    )]
    pub delegate: AccountInfo<'info>,
    pub claimer: Signer<'info>,
    pub token_program: Program<'info, Token>,
    /// CHECK: The address check is needed because otherwise
    /// the supplied Sysvar could be anything else.
    /// The Instruction Sysvar has not been implemented
    /// in the Anchor framework yet, so this is the safe approach.
    #[account(address = IX_ID)]
    pub ix_sysvar: AccountInfo<'info>,
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
    #[msg("Claim already made")]
    AlreadyClaimed,
    #[msg("Invalid signature")]
    InvalidSignature,
    #[msg("Claim expired")]
    ClaimExpired,
    #[msg("Invalid token program")]
    InvalidTokenProgram,
    #[msg("Insufficient funds")]
    InsufficientFunds,
    #[msg("Invalid destination account")]
    InvalidDestinationAccount,
}

#[event]
pub struct ClaimProcessed {
    pub claimer: Pubkey,
    pub claim_indices: Vec<u32>,
    pub total_amount: u64,
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
