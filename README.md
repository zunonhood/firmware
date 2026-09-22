# firmware

firmware is executable capability infrastructure for Robinhood Chain.

A Chip is a versioned software capability with a declared job, exact contract permissions, spending limits and a payment rule. A Machine installs a Chip, grants only the authority required for that job, executes it locally or onchain and records an attributable receipt.

The goal is simple. An agent should be able to use software without receiving unlimited wallet access, unlimited network access or permission to silently change what it runs.

## Project status

This repository contains a working implementation rather than interface mockups.

The Solidity contracts compile with Solidity 0.8.26. The TypeScript runtime compiles with TypeScript 5.9. Six contract integration tests and eight runtime tests pass locally. The deployment script completes against the local Hardhat network.

The contracts are not audited and this repository does not claim a public deployment. The header on the website remains NOT DEPLOYED until real Robinhood Chain addresses exist.

No token has been issued.

## What firmware does

firmware separates an agent capability into five layers.

1. Registration gives a Chip a stable identity and an immutable revision history.
2. Installation lets a Machine choose one revision and grant limited authority.
3. Execution verifies the installed package and runs only the permitted action.
4. Receipts record which Machine, Chip revision, artifact and cost belonged to an invocation.
5. Settlement checks the receipt and sends payment to the declared recipients without keeping custody.

Private inputs and executable bytes do not need to be stored onchain. Robinhood Chain is used for shared identity, permission records, receipt attribution and settlement.

## Execution flow

A publisher creates a Chip identifier in ChipRegistry and publishes a revision. The revision contains the artifact digest, manifest digest, semantic version and artifact location.

A Machine owner deploys or uses a MachineAccount. The owner installs a revision through PermissionKernel and supplies exact contract targets, function selectors, native value limits, spending assets and rolling budget windows.

An approved Machine operator requests a call through MachineAccount. MachineAccount asks PermissionKernel to validate the installation, revision status, expiry, target, selector, value and available budget. Only then does it call the destination contract.

For local work, runtime/executor.ts strictly validates the signed invocation, verifies EIP 712 authorization for an EOA or ERC 1271 Machine, validates the installation and package, then atomically claims the invocation nonce, reserves its maximum cost and calls a Sandbox adapter. A successful execution commits the final cost and receipt in one state transaction. A failed execution releases the nonce and reserved budget. The SQLite store persists balances, nonces, reservations and receipts across restarts and can recover reservations left by an interrupted process after their deadlines.

ExecutionReceiptRegistry accepts a receipt only from the Machine or a reporter that Machine approved. RevenueRouter then checks the recorded asset and amount, prevents the invocation from being settled twice and divides the payment between publisher, executor and protocol recipients.

## Repository map

### Protocol documents

protocol/CHIP-20.md

Defines the implemented CHIP 20 lifecycle. It explains registration, installation, onchain execution, local execution, receipts, settlement and the boundary between public records and private computation.

protocol/THREAT-MODEL.md

Lists protected assets, enforced controls, trust boundaries and work still required before production use. It makes clear that a registry entry is not an audit and a receipt is not a general proof of arbitrary private computation.

### Data formats

schemas/chip.manifest.json

JSON Schema for a Chip manifest. It requires a versioned Chip identity, artifact URI, SHA256 artifact digest, runtime type, entrypoint, network scopes, contract rules, spend limits, delegation choice and pricing information. Unknown top level fields are rejected.

schemas/execution.receipt.json

JSON Schema for runtime receipts. It defines invocation identity, Machine, Chip revision, artifact digest, input digest, output digest, timestamps, cost and completion status.

### Solidity contracts

contracts/ChipRegistry.sol

Stores Chip ownership and immutable revision history.

A publisher creates a stable chipId. Each new revision receives a sequential number and binds an artifact digest, manifest digest, semantic version and artifact URI. Existing revision contents cannot be overwritten. Publishers can revoke compromised revisions and transfer publisher authority through a two step acceptance flow.

contracts/PermissionKernel.sol

Stores the authority a Machine granted to an installed Chip.

Every installation has a revision, artifact digest, manifest digest, expiry and generation number. Both digests are read directly from ChipRegistry during installation and cannot be supplied by the installer. Exact target and selector pairs are stored as call rules. Each rule declares whether spend is absent, equal to native value or encoded as a uint256 at a fixed calldata offset. Budgets include one asset, a per invocation limit, a rolling window limit and a window duration.

Reinstalling a Chip increments its generation. Rules and budgets from an older generation stop working without requiring an expensive mapping cleanup.

contracts/MachineAccount.sol

Provides the actual enforcement boundary for onchain actions.

The owner installs and revokes Chips and chooses approved operators. An operator cannot call a destination directly through the Machine. It must call executeChipCall. That function asks PermissionKernel to authorize and consume budget before forwarding the call.

If the destination call fails, the complete transaction reverts, including the budget update. MachineAccount implements ERC 1271 so its owner can authorize the same typed offchain invocation format used by the runtime. Signatures enforce the lower s rule and reject malformed values. Ownership transfer uses a two step acceptance flow.

contracts/ExecutionReceiptRegistry.sol

Stores one attributable record for each invocation.

A receipt can be committed by the Machine itself or by a reporter explicitly approved by that Machine. Duplicate invocation identifiers are rejected. The receipt binds the settlement asset, exact cost and revenue route digest. RevenueRouter reads all three values from this contract.

The receipt is an authorized attestation. It does not claim to prove arbitrary offchain computation.

contracts/RevenueRouter.sol

Settles the exact asset and amount recorded in an execution receipt.

Each invocation can be settled once. Native ETH and ERC20 payments are supported. Recipient addresses and basis points are hashed and must exactly match the route digest authorized in the receipt. Basis points must total 10000. Rounding remainder goes to the publisher. Funds are sent directly to recipients and the router is not intended to retain custody.

contracts/interfaces/IERC20Minimal.sol

Contains only the ERC20 transfer and transferFrom functions required by RevenueRouter. Keeping this interface small avoids importing a large contract framework for two calls.

contracts/TestTarget.sol

Test only destination contract used by the integration suite to prove that an allowed selector succeeds and an unapproved selector fails.

contracts/TestToken.sol

Test only ERC20 implementation used to verify token settlement and confirm that RevenueRouter retains no token balance.

### TypeScript runtime

runtime/types.ts

Defines the runtime boundary types: ChipManifest, Installation, signed Invocation, SerializedInvocation, InvocationAuthorizer, Sandbox, the atomic ExecutionStateStore and ExecutionReceipt.

runtime/verifier.ts

Canonicalizes JSON with sorted object keys, rejects non JSON input, safely converts maximumCost between a decimal JSON string and bigint, computes SHA256 digests and strictly validates every manifest and invocation field. It also checks Chip identity, version, expiry, revocation, manifest digest and artifact digest.

runtime/executor.ts

Coordinates one local invocation.

It rejects malformed, unsigned, incorrectly signed, expired or mismatched requests, verifies the exact signed artifact and package, atomically claims the nonce and reserves the maximum cost, invokes the Sandbox adapter, rejects costs above the signed maximum and atomically commits the final cost and route bound receipt. On failure it releases reserved budget and nonce state.

runtime/memory.ts

Provides an in memory implementation of the atomic ExecutionStateStore. It uses Machine scoped balances, replay protected nonces, reservations and immutable receipts for fast deterministic tests.

runtime/sqlite.ts

Provides the persistent ExecutionStateStore using Node native SQLite. WAL mode and FULL synchronous writes are enabled. Nonce claiming and budget reservation occur in one transaction. Final cost accounting and receipt insertion occur in another transaction. The store survives restarts and recoverExpired releases reservations whose invocation deadline passed during an interrupted process.

### Persistent runtime state

Create one store for the runtime service and fund each Machine balance from the service accounting source.

    import { SqliteExecutionStore } from "./runtime/sqlite.js";

    const state = new SqliteExecutionStore("./data/firmware.sqlite");
    state.fund(machineAddress, 1000000n);
    state.recoverExpired(Date.now());

Pass state to execute together with the selected Sandbox adapter. Always close the store during a graceful shutdown.

    const result = await execute(invocation, installedPackage, {
      sandbox,
      state
    });

    state.close();

fund is an accounting primitive, not an onchain deposit listener. A deployed service must call it only after its own authenticated funding or credit process. recoverExpired must use trusted local time and should run once during startup and periodically while the service is active.

Node currently labels node:sqlite experimental even though it is available in supported Node 22 and newer releases. Pin and test the exact Node release used in deployment.

### Tests

test/contracts/protocol.test.ts

Runs six integration tests on the Hardhat network.

The suite verifies immutable revisions and revocation, selector and value enforcement, rolling budget consumption, Machine approved receipt reporting, native settlement, ERC20 settlement, exact receipt amount matching, duplicate settlement rejection and zero retained router balance, valid Machine owner ERC 1271 signatures and rejection of unauthorized or malformed signatures.

runtime-tests/runtime.test.ts

Runs eight Node tests against the TypeScript runtime.

The suite verifies successful execution and route bound receipt generation, artifact tamper detection, nonce replay rejection, strict manifest rules, atomic failure rollback, SQLite restart persistence, recovery of an expired reservation after an interrupted process, signed field tamper rejection and lossless JSON transport.

### Build and deployment

scripts/deploy.ts

Deploys ChipRegistry, PermissionKernel, ExecutionReceiptRegistry and RevenueRouter in dependency order. It accepts only Robinhood Chain mainnet, Robinhood Chain testnet or the local Hardhat chain. A deployment manifest is written to the deployments directory.

scripts/build-source-data.mjs

Reads the real files listed in the source catalog and generates source-data.js for the website. This keeps the code browser synchronized with the repository. The website does not maintain a second handwritten copy of the protocol code.

hardhat.config.ts

Configures Solidity 0.8.26, optimizer settings, Hardhat 3, the Ethers plugin, the Node test runner and Robinhood Chain network values.

tsconfig.json

Compiles the runtime and runtime tests as strict Node ESM modules targeting ES2022.

package.json

Pins the project commands and development tools. The project uses Hardhat 3, ethers 6 and TypeScript 5.

.env.example

Lists the deployment variables without including secrets. Copy it to .env only when preparing a public network deployment.

### Website files

index.html

Contains the public site structure, interactive execution board, developer note, code explorer and long form project explanation.

styles.css

Contains the liquid glass visual system, PCB layout, responsive rules, code explorer and article styles.

app.js

Controls the source tree, syntax rendering, copy and download actions, board execution animation and chip to source mapping.

source-data.js

Generated browser data containing the current real source files. Do not edit it manually. Run npm run source:sync or npm run build.

assets/firmware-logo-transparent.png

Transparent firmware logo used in the site header and repository panel.

serve.py

Small local static server used to preview the website without adding a frontend framework.

## Security invariants

A published revision cannot be overwritten.

A revoked revision cannot be installed or executed through PermissionKernel.

An offchain invocation must carry a valid Machine EIP 712 or ERC 1271 signature that binds its Chip, artifact, input, maximum cost, deadline, nonce, chain and revenue route.

A Machine call must match both the allowed target and the exact four byte function selector.

Native call value cannot exceed the rule maximum.

Budget cost cannot exceed either the per invocation limit or the current rolling window limit. The operator cannot self report this amount. It is derived from native value or the configured calldata word.

Rules from an older installation generation cannot become active after reinstalling a Chip.

A receipt reporter requires explicit approval from the Machine.

An invocation identifier can have only one receipt and one settlement.

Settlement asset, amount, recipient addresses and basis point split must exactly match the receipt.

RevenueRouter does not intentionally retain ETH or ERC20 balances.

## Local setup

Requirements:

Node.js 22.5 or newer.

Python 3 for the static website server.

Install dependencies:

    npm install

Run every contract and runtime test:

    npm test

Compile Solidity and TypeScript, then synchronize the website source browser:

    npm run build

Start the website:

    python serve.py

Open:

    http://127.0.0.1:4173/

## Available commands

    npm run compile

Compiles Solidity and TypeScript.

    npm test

Runs six contract integration tests and eight runtime tests.

    npm run test:runtime

Runs only the TypeScript runtime tests.

    npm run source:sync

Regenerates source-data.js from the real repository files.

    npm run build

Compiles everything and regenerates the website source catalog.

    npm run deploy:testnet

Deploys to Robinhood Chain testnet using the configured environment variables.

    npm run deploy:mainnet

Deploys to Robinhood Chain mainnet. This is intentionally separate from the testnet command.

## Robinhood Chain configuration

Robinhood Chain is EVM compatible.

Mainnet chain ID: 4663

Mainnet RPC: https://rpc.mainnet.chain.robinhood.com

Mainnet explorer: https://robinhoodchain.blockscout.com

Testnet chain ID: 46630

Testnet RPC: https://rpc.testnet.chain.robinhood.com

Testnet explorer: https://explorer.testnet.chain.robinhood.com

The native gas asset is ETH.

## Deployment

Copy the environment template.

    Copy-Item .env.example .env

Set DEPLOYER_PRIVATE_KEY in .env. Never paste a private key into the website, source code, issue tracker or chat history.

Fund the deployer with testnet ETH before the first public deployment.

Run the test suite.

    npm test

Deploy to testnet.

    npm run deploy:testnet

Review the generated deployments/robinhood-testnet.json file and verify every address in the testnet explorer.

Only after testnet review, independent security review and explicit approval should the mainnet command be considered.

The website CA field must remain NOT DEPLOYED until verified public addresses exist.

## What is not implemented yet

No independent security audit has been completed.

No production Sandbox adapter is bundled. The runtime defines the boundary and includes both deterministic memory storage and transactional SQLite storage, but production WASI or container isolation requires a separate hardened adapter.

The contracts do not prove arbitrary offchain computation.

The SQLite state store is implemented and tested locally, but deployment still needs authenticated funding integration, backups, monitoring and an operational review. The memory store remains test only.

Contract verification automation is not included yet.

No public Robinhood Chain deployment is claimed.

No token exists.

## Independent project notice

firmware is an independent project built for Robinhood Chain. It is not produced, sponsored or endorsed by Robinhood.