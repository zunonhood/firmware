# firmware

firmware is an Anchor program on Solana for bounded agent capabilities. A publisher registers a Chip and immutable revisions. A Machine owner installs one revision with an expiry, SPL token mint, per invocation cost ceiling, rolling budget and three recipient settlement route. An authorized operator records a receipt for completed offchain work. A receipt can be settled exactly once from a Machine controlled token vault.

The repository also contains the public website. Its board and code browser are generated from and mapped to the real Solana program source. The website is an architecture viewer, not a live execution monitor.

## Current status

The Rust program compiles and its unit tests pass in GitHub Actions. There is no public program deployment or token address. The website therefore says NOT DEPLOYED. The program is not audited. Do not fund a vault or rely on this code to protect production assets without independent review and end to end testing.

The current program records operator reported offchain results. It does not execute private code, restrict a local process, verify computation or prove that a reported output is correct. An authorized operator is a trust assumption. Artifact and manifest digests are pinned onchain, but the party installing a Chip must inspect and independently hash the offchain bytes.

## Program ID

`E7XwWNsXYWn81mVEGNwVfaHBynjZBcGYZ8ZwnfSzYgRB`

This is a generated program address, not evidence of deployment. The corresponding local keypair is ignored under `keys/` and must never be committed or shared. A public deployment should use a carefully managed deploy authority. Generate a separate local payer with `solana-keygen new -o keys/deployer.json` before using Anchor commands that sign transactions.

## Account model

| Account | PDA seeds | Purpose |
| --- | --- | --- |
| Chip | `chip`, publisher, 32 byte Chip ID | Stable publisher owned identity and latest revision |
| Revision | `revision`, Chip PDA, little endian revision number | Artifact and manifest digests, revocation flag |
| Machine | `machine`, owner | Owner and current operator authority |
| Installation | `install`, Machine PDA, Chip PDA, little endian installation ID | Pinned revision, expiry, mint, budgets and payment route |
| Receipt | `receipt`, Installation PDA, 32 byte invocation ID | Digests, reporter, cost and one time settlement state |

An account already existing at the same PDA prevents the same identity or invocation from being created again.

## Instruction flow

1. `create_chip` creates a publisher owned Chip.
2. `publish_revision` creates the next revision with nonzero artifact and manifest digests. `revoke_revision` marks a compromised revision.
3. `create_machine` sets an owner and operator. Only the owner may change the operator.
4. `install_chip` pins a live revision and owner selected limits. Only the owner may revoke the installation.
5. `record_receipt` requires the current operator signature. It rejects revoked revisions and installations, expiry, zero or excessive cost, exceeded rolling budget and reused invocation IDs.
6. `settle` checks the committed route, mint and token account authorities, transfers the exact receipt cost with SPL Token `transfer_checked`, and marks the receipt settled. Any caller can pay the transaction fee; only the Machine PDA can authorize spending from its vault.

The owner must fund a token account whose authority is the Machine PDA before settlement. Recipient token accounts must use the installation's publisher, executor and protocol owners and selected mint. Settlement uses integer basis points. Publisher and executor shares round down; the remaining units go to the protocol account.

## Source files

- `programs/firmware/src/lib.rs`: all program instructions, account constraints, state layouts, errors and unit tests.
- `programs/firmware/Cargo.toml`: program dependencies.
- `Cargo.toml`: Rust workspace.
- `Anchor.toml`: program ID and local validator configuration.
- `.github/workflows/solana.yml`: Linux compilation and unit tests.
- `scripts/build-source-data.mjs`: reads real repository files into the website code browser.
- `tests/site.test.mjs`: checks that every board Chip points to a real program symbol and that old chain claims do not reappear.
- `index.html`, `styles.css`, `app.js`: public site and source mapped board.
- `package.json`: website build and test commands.
- `serve.py`: optional local static server.
- `source-data.js`: generated browser data. Do not hand edit it.
- `CNAME`: custom domain configuration.

## Build and test

Use Rust, Solana CLI and Anchor CLI compatible with Anchor 1.2.0. On Windows, run the Solana tooling in WSL or use the GitHub Actions workflow in this repository.

```sh
cargo check --workspace --all-targets
cargo test --workspace --lib
anchor build
npm run source:sync
npm test
```

`cargo check` and `cargo test` run in CI. The site can be served as static files; no frontend framework is required. `npm run source:sync` must run after changing a displayed source file.

`anchor build` and local-validator integration tests are not currently covered by CI. Do not treat host compilation alone as an SBF deployment test.

## Security boundaries

- The owner controls installation and operator changes. The operator can record a cost up to the owner's limits, so operator compromise can create false receipts and charge the Machine vault.
- The program checks account relationships and token account owners before settlement. It cannot determine whether an offchain result is true.
- Revoking a revision prevents new receipts for an installation using it. An already recorded receipt can still be settled.
- Every receipt has a unique PDA and a settled flag. Solana transaction atomicity means failed transfers do not persist a partially settled receipt.
- The rolling budget resets when the configured time window has elapsed. It limits operator reported receipt cost, not every possible external expense of an offchain process.
- A private sandbox, artifact verification service and an independent result challenge mechanism are future work, not hidden features of the current program.

## Website

The website reads source contents from `source-data.js`, generated from files listed in `scripts/build-source-data.mjs`. Clicking a board component opens the Rust source and scrolls to the relevant instruction or account. The board sequence is an architecture trace, not live telemetry.

The CA field remains NOT DEPLOYED until a real token address is supplied. The program ID above is not a token CA.