# CHIP 20 executable capability protocol

CHIP 20 defines a package that a Machine can inspect, install and execute under explicit authority.

## Chain boundary

Robinhood Chain stores Chip identity, immutable revision digests, Machine approved authority, rolling budgets, settlement and execution receipt attestations. Private inputs and the executable artifact do not need to be published onchain.

## Registration

A publisher creates a stable chipId and appends revisions. Each revision binds an artifact digest, a canonical manifest digest, a semantic version and an artifact URI.

Published revision data is immutable. A publisher may revoke a compromised revision but cannot rewrite it.

## Installation

A Machine installs one active revision through PermissionKernel. Installation reads the artifact and manifest digests from the registered revision, then pins expiry, target contracts, function selectors and rolling spend budgets. Each call rule derives spend from native value or a declared uint256 calldata position. Reinstalling creates a new generation and invalidates every rule from the previous generation.

## Execution

MachineAccount.executeChipCall is the enforcement boundary for onchain calls. Before calling the target it asks the kernel to validate the installation, revision status, selector, value and budget. A failed target call reverts the complete transaction, including budget consumption.

Offchain work uses the TypeScript runtime. It strictly validates the invocation and complete manifest, verifies EIP 712 authorization from an EOA Machine or ERC 1271 MachineAccount, verifies canonical manifest and artifact digests, checks expiry and revocation state, then atomically claims a nonce and reserves cost. Final cost accounting and the route bound receipt commit together. A failure releases the reservation and nonce. The SQLite store persists state across restarts and recovers expired reservations left by interruption.

## Receipts

A Machine chooses which reporter may commit a receipt on its behalf. A receipt attributes an invocation to a Machine, Chip revision, artifact, input digest, output digest, cost and status. It is an execution attestation. It is not a general proof that private computation was correct.

## Settlement

RevenueRouter requires the asset, cost and hash of all recipient addresses and basis points to match the authorized receipt before splitting native ETH or ERC20 payment. The router does not retain custody. Basis points must total 10000 and any rounding remainder goes to the publisher.

## Security status

The implementation compiles and its core behavior is covered by automated tests. It has not received an independent security audit and has not been deployed by this repository.