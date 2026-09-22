import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const entries = [
  ["protocol/CHIP-20.md", "SPECIFICATION", "IMPLEMENTED / REVIEW OPEN", "Defines the complete Chip lifecycle and the boundary between onchain authority and private local execution."],
  ["protocol/THREAT-MODEL.md", "SECURITY NOTE", "ACTIVE / REVIEW OPEN", "Lists protected assets, enforced controls, trust assumptions and security work still required before production use."],
  ["schemas/chip.manifest.json", "JSON SCHEMA", "VALIDATION FORMAT / V1", "Defines every field a Chip must declare, including identity, artifact digest, permissions, budgets and pricing."],
  ["schemas/invocation.json", "JSON SCHEMA", "SIGNED TRANSPORT / V1", "Defines the JSON safe EIP 712 invocation whose signature binds execution, cost, nonce, chain and settlement route."],
  ["schemas/execution.receipt.json", "JSON SCHEMA", "VALIDATION FORMAT / V1", "Defines the portable receipt produced after an invocation, including digests, timestamps, cost and status."],
  ["contracts/ChipRegistry.sol", "SOLIDITY", "COMPILED / TESTED", "Creates stable Chip identities and stores immutable, sequential artifact and manifest revisions for each publisher."],
  ["contracts/PermissionKernel.sol", "SOLIDITY", "COMPILED / TESTED", "Pins Registry digests and enforces revision status, expiry, selectors and budgets derived from native value or calldata."],
  ["contracts/MachineAccount.sol", "SOLIDITY", "COMPILED / TESTED", "Enforces kernel approved calls and validates owner EIP 712 authorization through the ERC 1271 contract wallet standard."],
  ["contracts/ExecutionReceiptRegistry.sol", "SOLIDITY", "COMPILED / TESTED", "Accepts one Machine authorized receipt per invocation and binds its asset, cost and revenue route digest."],
  ["contracts/RevenueRouter.sol", "SOLIDITY", "COMPILED / TESTED", "Matches payment and recipient split to the receipt route digest, prevents duplicates and settles without custody."],
  ["contracts/interfaces/IERC20Minimal.sol", "SOLIDITY", "COMPILED", "Defines the minimal ERC20 transfer surface used by settlement without importing an unrelated contract framework."],
  ["contracts/TestTarget.sol", "SOLIDITY", "TEST FIXTURE", "Provides allowed and rejected destination functions used to prove selector enforcement on the local EVM."],
  ["contracts/TestToken.sol", "SOLIDITY", "TEST FIXTURE", "Provides a deterministic ERC20 used to prove token budget derivation, settlement splits and zero router custody."],
  ["runtime/types.ts", "TYPESCRIPT", "COMPILED / TESTED", "Defines signed invocation, transport, authorization, manifest, sandbox, atomic state and receipt boundaries."],
  ["runtime/authorization.ts", "TYPESCRIPT", "EIP 712 / ERC 1271", "Creates and signs firmware typed data and verifies EOA or contract Machine authorization before execution."],
  ["runtime/verifier.ts", "TYPESCRIPT", "COMPILED / TESTED", "Strictly validates manifests and signed invocations, parses JSON safe costs, canonicalizes data and rejects mismatched packages."],
  ["runtime/executor.ts", "TYPESCRIPT", "COMPILED / TESTED", "Coordinates verification, atomic state reservation, sandbox execution, rollback and route bound receipt creation."],
  ["runtime/memory.ts", "TYPESCRIPT", "COMPILED / TESTED", "Provides a Machine scoped atomic execution state store for fast deterministic tests."],
  ["runtime/sqlite.ts", "TYPESCRIPT", "COMPILED / 4 TEST PATHS", "Persists balances, nonces, reservations and receipts with SQLite transactions, restart recovery and expired reservation cleanup."],
  ["scripts/deploy.ts", "TYPESCRIPT", "ROBINHOOD CHAIN / READY", "Deploys the four core contracts in dependency order and writes their addresses to a network deployment manifest."],
  ["scripts/build-source-data.mjs", "JAVASCRIPT", "BUILD TOOL", "Reads these real repository files and regenerates the website source browser without a handwritten duplicate."],
  ["test/contracts/protocol.test.ts", "TEST", "6 TESTS / PASSING", "Proves digest pinning, derived spend, permissions, ERC 1271 owner signatures, receipts and route bound settlement on the local Hardhat EVM."],
  ["runtime-tests/runtime.test.ts", "TEST", "8 TESTS / PASSING", "Proves execution, route receipts, strict validation, replay protection, atomic rollback, restart persistence and crash recovery."],
  ["hardhat.config.ts", "TYPESCRIPT", "BUILD CONFIG", "Pins compiler settings, test runner plugins and official Robinhood Chain network identifiers and RPC endpoints."],
  ["tsconfig.json", "JSON", "BUILD CONFIG", "Enables strict Node ESM compilation for runtime code and runtime tests."],
  ["package.json", "JSON", "PROJECT CONFIG", "Declares the exact build, test, source sync and Robinhood Chain deployment commands."],
  [".env.example", "ENV", "SAFE TEMPLATE", "Lists required deployment variables without including a private key or live secret."],
  ["index.html", "HTML", "WEBSITE SOURCE", "Defines the public architecture board, developer note, real source explorer and project explanation."],
  ["styles.css", "CSS", "WEBSITE SOURCE", "Implements the restrained liquid glass system, circuit board, source explorer and responsive layout."],
  ["app.js", "JAVASCRIPT", "WEBSITE SOURCE", "Connects every inspectable board component to real source and drives the execution trace and code tools."],
  ["serve.py", "PYTHON", "LOCAL SERVER", "Serves the static website on localhost with no frontend framework or build server."],
  ["README.md", "MARKDOWN", "PROJECT GUIDE", "Explains the architecture, every source file, security invariants, local commands and Robinhood Chain deployment."]
];

const objects = {};
for (const [relativePath, language, state, description] of entries) {
  const absolutePath = path.join(root, ...relativePath.split("/"));
  objects[relativePath] = {
    language,
    state,
    description,
    content: fs.readFileSync(absolutePath, "utf8")
  };
}

const groups = new Map();
const rootFiles = [];
for (const [relativePath] of entries) {
  const slash = relativePath.indexOf("/");
  if (slash === -1) {
    rootFiles.push(relativePath);
    continue;
  }
  const folder = relativePath.slice(0, slash);
  if (!groups.has(folder)) groups.set(folder, []);
  groups.get(folder).push(relativePath);
}

const tree = Array.from(groups, ([name, children]) => ({
  name,
  type: "folder",
  children
}));
for (const name of rootFiles) tree.push({ name, type: "file" });

const output =
  "window.FIRMWARE_SOURCE_OBJECTS = " + JSON.stringify(objects, null, 2) + ";\n\n" +
  "window.FIRMWARE_SOURCE_TREE = " + JSON.stringify(tree, null, 2) + ";\n";

fs.writeFileSync(path.join(root, "source-data.js"), output);
console.log("Synced " + entries.length + " real source files into source-data.js");