import { createHash } from "node:crypto";
import type {
  ChipManifest,
  HexDigest,
  Installation,
  Invocation,
  SerializedInvocation
} from "./types.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export class VerificationError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "VerificationError";
  }
}

export function canonicalize(value: unknown): string {
  return canonicalizeValue(value, new Set<object>());
}

function canonicalizeValue(value: unknown, ancestors: Set<object>): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new VerificationError("JSON_NUMBER_INVALID");
    return JSON.stringify(value);
  }
  if (typeof value !== "object") throw new VerificationError("JSON_VALUE_INVALID");
  if (ancestors.has(value)) throw new VerificationError("JSON_CYCLE_INVALID");

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return "[" + value.map((item) => canonicalizeValue(item, ancestors)).join(",") + "]";
    }
    if (Object.getPrototypeOf(value) !== Object.prototype) {
      throw new VerificationError("JSON_OBJECT_INVALID");
    }

    const record = value as Record<string, unknown>;
    return "{" + Object.keys(record)
      .sort()
      .map((key) => JSON.stringify(key) + ":" + canonicalizeValue(record[key], ancestors))
      .join(",") + "}";
  } finally {
    ancestors.delete(value);
  }
}

export function sha256(value: Uint8Array | string): HexDigest {
  return "0x" + createHash("sha256").update(value).digest("hex");
}

export function hashJson(value: unknown): HexDigest {
  return sha256(canonicalize(value));
}

export function parseInvocation<TInput = unknown>(
  value: unknown
): Invocation<TInput> {
  const document = object(value, "INVOCATION_NOT_OBJECT");
  if (!isUintString(document.maximumCost) || document.maximumCost === "0") {
    throw new VerificationError("MAXIMUM_COST_INVALID");
  }

  const invocation = {
    ...document,
    maximumCost: BigInt(document.maximumCost)
  } as unknown as Invocation<TInput>;
  validateInvocation(invocation);
  return invocation;
}

export function serializeInvocation<TInput>(
  invocation: Invocation<TInput>
): SerializedInvocation<TInput> {
  validateInvocation(invocation);
  return {
    ...invocation,
    maximumCost: invocation.maximumCost.toString()
  };
}
export function validateInvocation(value: unknown): asserts value is Invocation {
  const invocation = object(value, "INVOCATION_NOT_OBJECT");
  exactKeys(invocation, [
    "invocationId", "machine", "chipId", "artifactDigest", "input", "maximumCost",
    "deadline", "nonce", "revenueRouteDigest", "chainId", "verifyingContract", "signature"
  ], "INVOCATION_FIELDS_INVALID");

  if (!isDigest(invocation.invocationId)) throw new VerificationError("INVOCATION_ID_INVALID");
  if (!isAddress(invocation.machine)) throw new VerificationError("MACHINE_INVALID");
  if (!isDigest(invocation.chipId)) throw new VerificationError("CHIP_ID_INVALID");
  if (!isDigest(invocation.artifactDigest)) throw new VerificationError("ARTIFACT_DIGEST_INVALID");
  if (typeof invocation.maximumCost !== "bigint" || invocation.maximumCost <= 0n) {
    throw new VerificationError("MAXIMUM_COST_INVALID");
  }
  if (!Number.isSafeInteger(invocation.deadline) || Number(invocation.deadline) < 0) {
    throw new VerificationError("DEADLINE_INVALID");
  }
  if (
    typeof invocation.nonce !== "string" ||
    invocation.nonce.length === 0 ||
    invocation.nonce.length > 128
  ) {
    throw new VerificationError("NONCE_INVALID");
  }
  if (!isDigest(invocation.revenueRouteDigest)) {
    throw new VerificationError("ROUTE_DIGEST_INVALID");
  }
  if (!Number.isSafeInteger(invocation.chainId) || Number(invocation.chainId) <= 0) {
    throw new VerificationError("CHAIN_ID_INVALID");
  }
  if (
    !isAddress(invocation.verifyingContract) ||
    invocation.verifyingContract.toLowerCase() !== String(invocation.machine).toLowerCase()
  ) {
    throw new VerificationError("VERIFYING_CONTRACT_INVALID");
  }
  if (
    typeof invocation.signature !== "string" ||
    !/^0x[0-9a-fA-F]{130}$/.test(invocation.signature)
  ) {
    throw new VerificationError("SIGNATURE_INVALID");
  }
  canonicalize(invocation.input);
}

export function validateManifest(value: unknown): asserts value is ChipManifest {
  const manifest = object(value, "MANIFEST_NOT_OBJECT");
  exactKeys(manifest, [
    "manifestVersion", "chipId", "name", "version",
    "artifact", "entrypoint", "permissions", "economics"
  ], "MANIFEST_FIELDS_INVALID");

  if (manifest.manifestVersion !== "1") throw new VerificationError("MANIFEST_VERSION_UNSUPPORTED");
  if (!isDigest(manifest.chipId)) throw new VerificationError("CHIP_ID_INVALID");
  if (
    typeof manifest.name !== "string" ||
    manifest.name.length === 0 ||
    manifest.name.length > 96 ||
    !isSemver(manifest.version)
  ) {
    throw new VerificationError("IDENTITY_INVALID");
  }

  const artifact = object(manifest.artifact, "ARTIFACT_INVALID");
  exactKeys(artifact, ["uri", "sha256", "runtime"], "ARTIFACT_FIELDS_INVALID");
  if (
    typeof artifact.uri !== "string" ||
    artifact.uri.length === 0 ||
    !isDigest(artifact.sha256)
  ) {
    throw new VerificationError("ARTIFACT_INVALID");
  }
  if (!["wasm32-wasi", "container", "remote"].includes(String(artifact.runtime))) {
    throw new VerificationError("RUNTIME_UNSUPPORTED");
  }
  if (typeof manifest.entrypoint !== "string" || manifest.entrypoint.length === 0) {
    throw new VerificationError("ENTRYPOINT_INVALID");
  }

  const permissions = object(manifest.permissions, "PERMISSIONS_INVALID");
  exactKeys(
    permissions,
    ["network", "contracts", "spend", "delegation"],
    "PERMISSION_FIELDS_INVALID"
  );
  if (
    !Array.isArray(permissions.network) ||
    !Array.isArray(permissions.contracts) ||
    !Array.isArray(permissions.spend) ||
    typeof permissions.delegation !== "boolean"
  ) {
    throw new VerificationError("PERMISSIONS_INVALID");
  }

  assertUniqueStrings(permissions.network, "NETWORK_SCOPE_INVALID");
  if (permissions.network.some((scope) => scope.length === 0)) {
    throw new VerificationError("NETWORK_SCOPE_INVALID");
  }

  for (const candidate of permissions.contracts) {
    const rule = object(candidate, "CONTRACT_RULE_INVALID");
    exactKeys(rule, [
      "target", "selectors", "maxValueWei", "spendMode", "budgetAsset", "amountOffset"
    ], "CONTRACT_RULE_FIELDS_INVALID");

    if (!isAddress(rule.target) || !isAddress(rule.budgetAsset)) {
      throw new VerificationError("CONTRACT_ADDRESS_INVALID");
    }
    if (!Array.isArray(rule.selectors) || rule.selectors.length === 0) {
      throw new VerificationError("SELECTORS_INVALID");
    }
    assertUniqueStrings(rule.selectors, "SELECTORS_INVALID");
    if (rule.selectors.some((selector) => !/^0x[0-9a-fA-F]{8}$/.test(selector))) {
      throw new VerificationError("SELECTORS_INVALID");
    }
    if (!isUintString(rule.maxValueWei)) {
      throw new VerificationError("MAX_VALUE_INVALID");
    }
    if (
      !Number.isInteger(rule.amountOffset) ||
      Number(rule.amountOffset) < 0 ||
      Number(rule.amountOffset) > 65_535
    ) {
      throw new VerificationError("AMOUNT_OFFSET_INVALID");
    }

    const spendMode = rule.spendMode;
    const budgetAsset = String(rule.budgetAsset).toLowerCase();
    const amountOffset = Number(rule.amountOffset);
    if (spendMode === "none") {
      if (budgetAsset !== ZERO_ADDRESS || amountOffset !== 0) {
        throw new VerificationError("SPEND_MODE_INVALID");
      }
    } else if (spendMode === "nativeValue") {
      if (budgetAsset !== ZERO_ADDRESS || amountOffset !== 0) {
        throw new VerificationError("SPEND_MODE_INVALID");
      }
    } else if (spendMode === "calldataUint256") {
      if (
        budgetAsset === ZERO_ADDRESS ||
        amountOffset < 4 ||
        rule.maxValueWei !== "0"
      ) {
        throw new VerificationError("SPEND_MODE_INVALID");
      }
    } else {
      throw new VerificationError("SPEND_MODE_INVALID");
    }
  }

  const spendAssets = new Set<string>();
  for (const candidate of permissions.spend) {
    const spend = object(candidate, "SPEND_RULE_INVALID");
    exactKeys(
      spend,
      ["asset", "perInvocation", "perWindow", "windowSeconds"],
      "SPEND_RULE_FIELDS_INVALID"
    );
    if (
      !isAddress(spend.asset) ||
      !isUintString(spend.perInvocation) ||
      !isUintString(spend.perWindow) ||
      !Number.isSafeInteger(spend.windowSeconds) ||
      Number(spend.windowSeconds) < 1
    ) {
      throw new VerificationError("SPEND_RULE_INVALID");
    }
    if (BigInt(spend.perInvocation) > BigInt(spend.perWindow)) {
      throw new VerificationError("SPEND_LIMIT_INVALID");
    }
    const asset = spend.asset.toLowerCase();
    if (spendAssets.has(asset)) throw new VerificationError("SPEND_ASSET_DUPLICATE");
    spendAssets.add(asset);
  }

  const economics = object(manifest.economics, "ECONOMICS_INVALID");
  exactKeys(economics, ["model", "asset", "maximumPrice"], "ECONOMICS_FIELDS_INVALID");
  if (
    !["fixed", "metered"].includes(String(economics.model)) ||
    !isAddress(economics.asset) ||
    !isUintString(economics.maximumPrice)
  ) {
    throw new VerificationError("ECONOMICS_INVALID");
  }
}

export function verifyInstallation(
  manifest: ChipManifest,
  artifact: Uint8Array,
  installation: Installation,
  now: number = Date.now()
): void {
  validateManifest(manifest);

  if (installation.revoked) throw new VerificationError("AUTHORITY_REVOKED");
  if (!Number.isSafeInteger(installation.expiresAt) || now >= installation.expiresAt) {
    throw new VerificationError("INSTALLATION_EXPIRED");
  }
  if (!isDigest(installation.chipId)) throw new VerificationError("INSTALLATION_CHIP_ID_INVALID");
  if (!isDigest(installation.manifestDigest)) {
    throw new VerificationError("INSTALLATION_MANIFEST_DIGEST_INVALID");
  }
  if (!isDigest(installation.artifactDigest)) {
    throw new VerificationError("INSTALLATION_ARTIFACT_DIGEST_INVALID");
  }
  if (manifest.chipId.toLowerCase() !== installation.chipId.toLowerCase()) {
    throw new VerificationError("CHIP_ID_MISMATCH");
  }
  if (manifest.version !== installation.version) {
    throw new VerificationError("VERSION_MISMATCH");
  }

  const manifestDigest = hashJson(manifest);
  if (manifestDigest.toLowerCase() !== installation.manifestDigest.toLowerCase()) {
    throw new VerificationError("MANIFEST_DIGEST_MISMATCH");
  }

  const artifactDigest = sha256(artifact);
  if (
    artifactDigest.toLowerCase() !== installation.artifactDigest.toLowerCase() ||
    artifactDigest.toLowerCase() !== manifest.artifact.sha256.toLowerCase()
  ) {
    throw new VerificationError("ARTIFACT_DIGEST_MISMATCH");
  }
}

function object(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new VerificationError(code);
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) {
    throw new VerificationError(code);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: string[],
  code: string
): void {
  const actual = Object.keys(value);
  if (
    actual.length !== expected.length ||
    expected.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
  ) {
    throw new VerificationError(code);
  }
}

function assertUniqueStrings(value: unknown[], code: string): asserts value is string[] {
  if (value.some((item) => typeof item !== "string")) {
    throw new VerificationError(code);
  }
  const normalized = value.map((item) => (item as string).toLowerCase());
  if (new Set(normalized).size !== normalized.length) {
    throw new VerificationError(code);
  }
}

function isDigest(value: unknown): value is HexDigest {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
}

function isAddress(value: unknown): value is string {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
}

function isUintString(value: unknown): value is string {
  return typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value);
}

function isSemver(value: unknown): value is string {
  return typeof value === "string" && /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(value);
}