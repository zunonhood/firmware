# Threat model

## Assets

Machine funds, installation authority, private task input, publisher revenue, executable integrity and receipt attribution are protected assets.

## Enforced controls

Artifact and manifest digests are pinned. Contract destinations and selectors are allowlisted. Native value and calldata encoded token amounts are derived by the kernel rather than reported by the operator. Budgets have per invocation and rolling window caps. Installations expire and can be revoked. Revisions can be revoked by their publisher. Every offchain request is signed as EIP 712 typed data. The signature binds the Machine, Chip, artifact, canonical input, maximum cost, deadline, nonce, chain and route. EOA signatures and ERC 1271 MachineAccount signatures are supported. Execution nonces prevent replay in the runtime. SQLite transactions bind nonce claims to budget reservations and bind final budget accounting to receipt insertion. Expired reservations can be recovered after a process interruption. Receipt reporters require explicit Machine approval. Settlement recipients and basis points are bound to the receipt with a route digest.

## Trust boundaries

The contracts do not prove arbitrary offchain computation. A Machine must trust its chosen sandbox and receipt reporter. A registry entry is not an audit. A remote artifact URI is not trusted unless its bytes match the registered digest.

## Administration

Chip publishers can revoke their own revisions and transfer publisher authority through a two step flow. Machine owners control operators and installations. The revenue router has no owner and keeps no intended balance.

## Remaining work

Independent audit, production sandbox adapters, contract verification after deployment, hardware backed Machine signing and formal analysis of composed Chip authority remain required before production value is placed at risk.