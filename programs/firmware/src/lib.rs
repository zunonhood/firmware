use anchor_lang::prelude::*;
use solana_sha256_hasher::hashv;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};

declare_id!("E7XwWNsXYWn81mVEGNwVfaHBynjZBcGYZ8ZwnfSzYgRB");

#[program]
pub mod firmware {
    use super::*;

    pub fn create_chip(ctx: Context<CreateChip>, chip_id: [u8; 32]) -> Result<()> {
        let chip = &mut ctx.accounts.chip;
        chip.publisher = ctx.accounts.publisher.key();
        chip.chip_id = chip_id;
        chip.latest_revision = 0;
        chip.bump = ctx.bumps.chip;
        Ok(())
    }

    pub fn publish_revision(
        ctx: Context<PublishRevision>,
        number: u32,
        artifact_digest: [u8; 32],
        manifest_digest: [u8; 32],
    ) -> Result<()> {
        require!(number > 0, FirmwareError::InvalidRevision);
        require!(
            number == ctx.accounts.chip.latest_revision.checked_add(1)
                .ok_or(FirmwareError::ArithmeticOverflow)?,
            FirmwareError::InvalidRevision
        );
        require!(artifact_digest != [0; 32], FirmwareError::InvalidDigest);
        require!(manifest_digest != [0; 32], FirmwareError::InvalidDigest);

        let revision = &mut ctx.accounts.revision;
        revision.chip = ctx.accounts.chip.key();
        revision.number = number;
        revision.artifact_digest = artifact_digest;
        revision.manifest_digest = manifest_digest;
        revision.revoked = false;
        revision.bump = ctx.bumps.revision;
        ctx.accounts.chip.latest_revision = number;
        Ok(())
    }

    pub fn revoke_revision(ctx: Context<RevokeRevision>) -> Result<()> {
        ctx.accounts.revision.revoked = true;
        Ok(())
    }

    pub fn create_machine(ctx: Context<CreateMachine>, operator: Pubkey) -> Result<()> {
        require!(operator != Pubkey::default(), FirmwareError::InvalidOperator);
        let machine = &mut ctx.accounts.machine;
        machine.owner = ctx.accounts.owner.key();
        machine.operator = operator;
        machine.bump = ctx.bumps.machine;
        Ok(())
    }

    pub fn set_operator(ctx: Context<SetOperator>, operator: Pubkey) -> Result<()> {
        require!(operator != Pubkey::default(), FirmwareError::InvalidOperator);
        ctx.accounts.machine.operator = operator;
        Ok(())
    }

    pub fn install_chip(ctx: Context<InstallChip>, args: InstallArgs) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require!(!ctx.accounts.revision.revoked, FirmwareError::RevisionRevoked);
        require!(args.expires_at > now, FirmwareError::InstallationExpired);
        require!(args.max_cost > 0, FirmwareError::InvalidBudget);
        require!(args.window_limit >= args.max_cost, FirmwareError::InvalidBudget);
        require!(args.window_seconds > 0, FirmwareError::InvalidBudget);
        require_keys_eq!(
            args.publisher,
            ctx.accounts.chip.publisher,
            FirmwareError::PublisherMismatch
        );
        require!(
            args.publisher != args.executor
                && args.publisher != args.protocol
                && args.executor != args.protocol,
            FirmwareError::DuplicateRecipient
        );
        require!(
            u32::from(args.publisher_bps)
                + u32::from(args.executor_bps)
                + u32::from(args.protocol_bps)
                == 10_000,
            FirmwareError::InvalidRoute
        );
        require!(args.mint != Pubkey::default(), FirmwareError::InvalidMint);

        let installation = &mut ctx.accounts.installation;
        installation.machine = ctx.accounts.machine.key();
        installation.chip = ctx.accounts.chip.key();
        installation.revision = ctx.accounts.revision.key();
        installation.installation_id = args.installation_id;
        installation.artifact_digest = ctx.accounts.revision.artifact_digest;
        installation.manifest_digest = ctx.accounts.revision.manifest_digest;
        installation.expires_at = args.expires_at;
        installation.mint = args.mint;
        installation.max_cost = args.max_cost;
        installation.window_limit = args.window_limit;
        installation.window_seconds = args.window_seconds;
        installation.window_start = now;
        installation.window_spent = 0;
        installation.publisher = args.publisher;
        installation.executor = args.executor;
        installation.protocol = args.protocol;
        installation.publisher_bps = args.publisher_bps;
        installation.executor_bps = args.executor_bps;
        installation.protocol_bps = args.protocol_bps;
        installation.route_digest = route_digest(&args);
        installation.active = true;
        installation.bump = ctx.bumps.installation;
        Ok(())
    }

    pub fn revoke_installation(ctx: Context<RevokeInstallation>) -> Result<()> {
        ctx.accounts.installation.active = false;
        Ok(())
    }

    pub fn record_receipt(
        ctx: Context<RecordReceipt>,
        invocation_id: [u8; 32],
        input_digest: [u8; 32],
        output_digest: [u8; 32],
        cost: u64,
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let installation = &mut ctx.accounts.installation;
        require!(installation.active, FirmwareError::InstallationRevoked);
        require!(!ctx.accounts.revision.revoked, FirmwareError::RevisionRevoked);
        require!(now < installation.expires_at, FirmwareError::InstallationExpired);
        require!(cost > 0 && cost <= installation.max_cost, FirmwareError::CostExceedsLimit);
        require!(invocation_id != [0; 32], FirmwareError::InvalidDigest);
        require!(input_digest != [0; 32], FirmwareError::InvalidDigest);
        require!(output_digest != [0; 32], FirmwareError::InvalidDigest);

        if now >= installation.window_start
            .checked_add(installation.window_seconds)
            .ok_or(FirmwareError::ArithmeticOverflow)?
        {
            installation.window_start = now;
            installation.window_spent = 0;
        }
        let next_spent = installation.window_spent.checked_add(cost)
            .ok_or(FirmwareError::ArithmeticOverflow)?;
        require!(next_spent <= installation.window_limit, FirmwareError::WindowLimitExceeded);
        installation.window_spent = next_spent;

        let receipt = &mut ctx.accounts.receipt;
        receipt.installation = installation.key();
        receipt.invocation_id = invocation_id;
        receipt.input_digest = input_digest;
        receipt.output_digest = output_digest;
        receipt.cost = cost;
        receipt.route_digest = installation.route_digest;
        receipt.reporter = ctx.accounts.operator.key();
        receipt.recorded_at = now;
        receipt.settled = false;
        receipt.bump = ctx.bumps.receipt;
        Ok(())
    }

    pub fn settle(ctx: Context<Settle>) -> Result<()> {
        require!(!ctx.accounts.receipt.settled, FirmwareError::AlreadySettled);
        require!(
            ctx.accounts.receipt.route_digest == ctx.accounts.installation.route_digest,
            FirmwareError::RouteMismatch
        );
        let installation = &ctx.accounts.installation;
        let cost = ctx.accounts.receipt.cost;
        let publisher_amount = share(cost, installation.publisher_bps)?;
        let executor_amount = share(cost, installation.executor_bps)?;
        let protocol_amount = cost.checked_sub(publisher_amount)
            .and_then(|remaining| remaining.checked_sub(executor_amount))
            .ok_or(FirmwareError::ArithmeticOverflow)?;
        require!(
            ctx.accounts.vault.amount >= cost,
            FirmwareError::InsufficientFunds
        );

        let bump = [ctx.accounts.machine.bump];
        let seeds: &[&[u8]] = &[
            b"machine",
            ctx.accounts.machine.owner.as_ref(),
            &bump,
        ];
        let signer_seeds: &[&[&[u8]]] = &[seeds];
        transfer_to(
            &ctx.accounts.token_program,
            &ctx.accounts.mint,
            &ctx.accounts.vault,
            &ctx.accounts.publisher_tokens,
            &ctx.accounts.machine,
            signer_seeds,
            publisher_amount,
        )?;
        transfer_to(
            &ctx.accounts.token_program,
            &ctx.accounts.mint,
            &ctx.accounts.vault,
            &ctx.accounts.executor_tokens,
            &ctx.accounts.machine,
            signer_seeds,
            executor_amount,
        )?;
        transfer_to(
            &ctx.accounts.token_program,
            &ctx.accounts.mint,
            &ctx.accounts.vault,
            &ctx.accounts.protocol_tokens,
            &ctx.accounts.machine,
            signer_seeds,
            protocol_amount,
        )?;
        ctx.accounts.receipt.settled = true;
        Ok(())
    }
}

fn transfer_to<'info>(
    token_program: &Interface<'info, TokenInterface>,
    mint: &InterfaceAccount<'info, Mint>,
    vault: &InterfaceAccount<'info, TokenAccount>,
    recipient: &InterfaceAccount<'info, TokenAccount>,
    machine: &Account<'info, Machine>,
    signer_seeds: &[&[&[u8]]],
    amount: u64,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    let accounts = TransferChecked {
        mint: mint.to_account_info(),
        from: vault.to_account_info(),
        to: recipient.to_account_info(),
        authority: machine.to_account_info(),
    };
    token_interface::transfer_checked(
        CpiContext::new_with_signer(token_program.key(), accounts, signer_seeds),
        amount,
        mint.decimals,
    )
}

fn share(cost: u64, basis_points: u16) -> Result<u64> {
    let amount = u128::from(cost)
        .checked_mul(u128::from(basis_points))
        .ok_or(FirmwareError::ArithmeticOverflow)?
        / 10_000;
    u64::try_from(amount).map_err(|_| error!(FirmwareError::ArithmeticOverflow))
}

fn route_digest(args: &InstallArgs) -> [u8; 32] {
    hashv(&[
        b"firmware-route-v1",
        args.mint.as_ref(),
        args.publisher.as_ref(),
        args.executor.as_ref(),
        args.protocol.as_ref(),
        &args.publisher_bps.to_le_bytes(),
        &args.executor_bps.to_le_bytes(),
        &args.protocol_bps.to_le_bytes(),
    ])
    .to_bytes()
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct InstallArgs {
    pub installation_id: u64,
    pub expires_at: i64,
    pub mint: Pubkey,
    pub max_cost: u64,
    pub window_limit: u64,
    pub window_seconds: i64,
    pub publisher: Pubkey,
    pub executor: Pubkey,
    pub protocol: Pubkey,
    pub publisher_bps: u16,
    pub executor_bps: u16,
    pub protocol_bps: u16,
}

#[derive(Accounts)]
#[instruction(chip_id: [u8; 32])]
pub struct CreateChip<'info> {
    #[account(mut)]
    pub publisher: Signer<'info>,
    #[account(
        init,
        payer = publisher,
        space = Chip::SPACE,
        seeds = [b"chip", publisher.key().as_ref(), chip_id.as_ref()],
        bump
    )]
    pub chip: Account<'info, Chip>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(number: u32)]
pub struct PublishRevision<'info> {
    #[account(mut)]
    pub publisher: Signer<'info>,
    #[account(mut, has_one = publisher)]
    pub chip: Account<'info, Chip>,
    #[account(
        init,
        payer = publisher,
        space = Revision::SPACE,
        seeds = [b"revision", chip.key().as_ref(), &number.to_le_bytes()],
        bump
    )]
    pub revision: Account<'info, Revision>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RevokeRevision<'info> {
    pub publisher: Signer<'info>,
    #[account(has_one = publisher)]
    pub chip: Account<'info, Chip>,
    #[account(mut, has_one = chip)]
    pub revision: Account<'info, Revision>,
}

#[derive(Accounts)]
pub struct CreateMachine<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        init,
        payer = owner,
        space = Machine::SPACE,
        seeds = [b"machine", owner.key().as_ref()],
        bump
    )]
    pub machine: Account<'info, Machine>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetOperator<'info> {
    pub owner: Signer<'info>,
    #[account(mut, has_one = owner)]
    pub machine: Account<'info, Machine>,
}

#[derive(Accounts)]
#[instruction(args: InstallArgs)]
pub struct InstallChip<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(has_one = owner)]
    pub machine: Account<'info, Machine>,
    pub chip: Account<'info, Chip>,
    #[account(has_one = chip)]
    pub revision: Account<'info, Revision>,
    #[account(
        init,
        payer = owner,
        space = Installation::SPACE,
        seeds = [
            b"install",
            machine.key().as_ref(),
            chip.key().as_ref(),
            &args.installation_id.to_le_bytes()
        ],
        bump
    )]
    pub installation: Account<'info, Installation>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RevokeInstallation<'info> {
    pub owner: Signer<'info>,
    #[account(has_one = owner)]
    pub machine: Account<'info, Machine>,
    #[account(mut, has_one = machine)]
    pub installation: Account<'info, Installation>,
}

#[derive(Accounts)]
#[instruction(invocation_id: [u8; 32])]
pub struct RecordReceipt<'info> {
    #[account(mut)]
    pub operator: Signer<'info>,
    #[account(has_one = operator)]
    pub machine: Account<'info, Machine>,
    #[account(
        mut,
        has_one = machine,
        has_one = revision
    )]
    pub installation: Account<'info, Installation>,
    pub revision: Account<'info, Revision>,
    #[account(
        init,
        payer = operator,
        space = Receipt::SPACE,
        seeds = [b"receipt", installation.key().as_ref(), invocation_id.as_ref()],
        bump
    )]
    pub receipt: Account<'info, Receipt>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Settle<'info> {
    pub caller: Signer<'info>,
    #[account(
        seeds = [b"machine", machine.owner.as_ref()],
        bump = machine.bump
    )]
    pub machine: Account<'info, Machine>,
    #[account(has_one = machine)]
    pub installation: Account<'info, Installation>,
    #[account(
        mut,
        has_one = installation
    )]
    pub receipt: Account<'info, Receipt>,
    #[account(address = installation.mint)]
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(
        mut,
        token::mint = mint,
        token::authority = machine,
        token::token_program = token_program
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(
        mut,
        token::mint = mint,
        token::authority = installation.publisher,
        token::token_program = token_program
    )]
    pub publisher_tokens: InterfaceAccount<'info, TokenAccount>,
    #[account(
        mut,
        token::mint = mint,
        token::authority = installation.executor,
        token::token_program = token_program
    )]
    pub executor_tokens: InterfaceAccount<'info, TokenAccount>,
    #[account(
        mut,
        token::mint = mint,
        token::authority = installation.protocol,
        token::token_program = token_program
    )]
    pub protocol_tokens: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[account]
pub struct Chip {
    pub publisher: Pubkey,
    pub chip_id: [u8; 32],
    pub latest_revision: u32,
    pub bump: u8,
}
impl Chip {
    pub const SPACE: usize = 8 + 32 + 32 + 4 + 1;
}

#[account]
pub struct Revision {
    pub chip: Pubkey,
    pub number: u32,
    pub artifact_digest: [u8; 32],
    pub manifest_digest: [u8; 32],
    pub revoked: bool,
    pub bump: u8,
}
impl Revision {
    pub const SPACE: usize = 8 + 32 + 4 + 32 + 32 + 1 + 1;
}

#[account]
pub struct Machine {
    pub owner: Pubkey,
    pub operator: Pubkey,
    pub bump: u8,
}
impl Machine {
    pub const SPACE: usize = 8 + 32 + 32 + 1;
}

#[account]
pub struct Installation {
    pub machine: Pubkey,
    pub chip: Pubkey,
    pub revision: Pubkey,
    pub installation_id: u64,
    pub artifact_digest: [u8; 32],
    pub manifest_digest: [u8; 32],
    pub expires_at: i64,
    pub mint: Pubkey,
    pub max_cost: u64,
    pub window_limit: u64,
    pub window_seconds: i64,
    pub window_start: i64,
    pub window_spent: u64,
    pub publisher: Pubkey,
    pub executor: Pubkey,
    pub protocol: Pubkey,
    pub publisher_bps: u16,
    pub executor_bps: u16,
    pub protocol_bps: u16,
    pub route_digest: [u8; 32],
    pub active: bool,
    pub bump: u8,
}
impl Installation {
    pub const SPACE: usize = 8 + 512;
}

#[account]
pub struct Receipt {
    pub installation: Pubkey,
    pub invocation_id: [u8; 32],
    pub input_digest: [u8; 32],
    pub output_digest: [u8; 32],
    pub cost: u64,
    pub route_digest: [u8; 32],
    pub reporter: Pubkey,
    pub recorded_at: i64,
    pub settled: bool,
    pub bump: u8,
}
impl Receipt {
    pub const SPACE: usize = 8 + 256;
}

#[error_code]
pub enum FirmwareError {
    #[msg("Revision number must be sequential")]
    InvalidRevision,
    #[msg("Digest must not be zero")]
    InvalidDigest,
    #[msg("Revision has been revoked")]
    RevisionRevoked,
    #[msg("Installation has expired")]
    InstallationExpired,
    #[msg("Installation has been revoked")]
    InstallationRevoked,
    #[msg("Operator key is invalid")]
    InvalidOperator,
    #[msg("Budget is invalid")]
    InvalidBudget,
    #[msg("Publisher does not match the Chip")]
    PublisherMismatch,
    #[msg("Payment recipients must be distinct")]
    DuplicateRecipient,
    #[msg("Revenue shares must total 10000 basis points")]
    InvalidRoute,
    #[msg("Mint key is invalid")]
    InvalidMint,
    #[msg("Receipt cost exceeds the per-invocation limit")]
    CostExceedsLimit,
    #[msg("Rolling budget would be exceeded")]
    WindowLimitExceeded,
    #[msg("Receipt has already been settled")]
    AlreadySettled,
    #[msg("Receipt route does not match the installation")]
    RouteMismatch,
    #[msg("Vault balance is insufficient")]
    InsufficientFunds,
    #[msg("Arithmetic overflow")]
    ArithmeticOverflow,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_every_unit_without_overpayment() {
        let cost = 101;
        let publisher = share(cost, 5000).unwrap();
        let executor = share(cost, 3000).unwrap();
        let protocol = cost - publisher - executor;
        assert_eq!((publisher, executor, protocol), (50, 30, 21));
    }

    #[test]
    fn large_share_does_not_overflow() {
        assert_eq!(share(u64::MAX, 10_000).unwrap(), u64::MAX);
    }
}
