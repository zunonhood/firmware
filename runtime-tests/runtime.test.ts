import test from "node:test";
import assert from "node:assert/strict";
import { Wallet } from "ethers";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execute, ExecutionError } from "../runtime/executor.js";
import { EvmInvocationAuthorizer, invocationDigest } from "../runtime/authorization.js";
import { MemoryExecutionStore } from "../runtime/memory.js";
import { SqliteExecutionStore } from "../runtime/sqlite.js";
import {
  hashJson,
  parseInvocation,
  serializeInvocation,
  sha256,
  validateManifest,
  VerificationError
} from "../runtime/verifier.js";
import type { ChipManifest, Installation, Invocation, Sandbox } from "../runtime/types.js";

const artifact = new TextEncoder().encode("compiled-chip-artifact");
const chipId = "0x" + "11".repeat(32);
const invocationId = "0x" + "22".repeat(32);
const wallet = Wallet.createRandom();
const machine = wallet.address;
const authorizer = new EvmInvocationAuthorizer([46630]);
const routeDigest = "0x" + "44".repeat(32);

function signed<T>(invocation: Invocation<T>): Invocation<T> {
  return {
    ...invocation,
    signature: wallet.signingKey.sign(invocationDigest(invocation)).serialized
  };
}

function fixture() {
  const manifest: ChipManifest = {
    manifestVersion: "1",
    chipId,
    name: "Price Reader",
    version: "1.0.0",
    artifact: {
      uri: "ipfs://bafy-valid-artifact",
      sha256: sha256(artifact),
      runtime: "wasm32-wasi"
    },
    entrypoint: "run",
    permissions: {
      network: ["https://prices.example/v1/*"],
      contracts: [],
      spend: [{
        asset: "0x0000000000000000000000000000000000000000",
        perInvocation: "100",
        perWindow: "1000",
        windowSeconds: 3600
      }],
      delegation: false
    },
    economics: {
      model: "metered",
      asset: "0x0000000000000000000000000000000000000000",
      maximumPrice: "100"
    }
  };

  const installation: Installation = {
    chipId,
    version: "1.0.0",
    manifestDigest: hashJson(manifest),
    artifactDigest: sha256(artifact),
    expiresAt: 10_000,
    revoked: false
  };

  const invocation: Invocation<{ symbol: string }> = {
    invocationId,
    machine,
    chipId,
    artifactDigest: sha256(artifact),
    input: { symbol: "HOOD" },
    maximumCost: 100n,
    deadline: 9_000,
    nonce: "1",
    revenueRouteDigest: routeDigest,
    chainId: 46630,
    verifyingContract: machine,
    signature: "0x" + "00".repeat(65)
  };
  invocation.signature = wallet.signingKey.sign(invocationDigest(invocation)).serialized;

  return { manifest, installation, invocation };
}

const successfulSandbox: Sandbox = {
  async run() {
    return { output: { price: "42.10" }, meteredCost: 25n };
  }
};

test("executes a verified package and atomically commits an attributable receipt", async () => {
  const { manifest, installation, invocation } = fixture();
  const state = new MemoryExecutionStore({ [machine]: 1_000n });
  let clock = 1_000;

  const result = await execute<typeof invocation.input, { price: string }>(
    invocation,
    { manifest, artifact, installation },
    {
      sandbox: successfulSandbox,
      state,
      authorizer,
      now: () => clock++
    }
  );

  assert.deepEqual(result.output, { price: "42.10" });
  assert.equal(result.receipt.inputDigest, hashJson({ symbol: "HOOD" }));
  assert.equal(result.receipt.outputDigest, hashJson({ price: "42.10" }));
  assert.equal(result.receipt.cost, "25");
  assert.equal(result.receipt.routeDigest, routeDigest);
  assert.deepEqual(state.balance(machine), { available: 975n, spent: 25n });
  assert.deepEqual(state.getReceipt(invocationId), result.receipt);

  const replay = signed({ ...invocation, invocationId: "0x" + "33".repeat(32) });
  await assert.rejects(
    execute(replay, { manifest, artifact, installation }, {
      sandbox: successfulSandbox,
      state,
      authorizer,
      now: () => 2_000
    }),
    (error: unknown) => error instanceof ExecutionError && error.code === "NONCE_ALREADY_USED"
  );
});

test("rejects an artifact whose digest does not match the installation", async () => {
  const { manifest, installation, invocation } = fixture();

  await assert.rejects(
    execute(invocation, {
      manifest,
      artifact: new TextEncoder().encode("tampered"),
      installation
    }, {
      sandbox: successfulSandbox,
      state: new MemoryExecutionStore({ [machine]: 1_000n }),
      authorizer,
      now: () => 1_000
    }),
    (error: unknown) =>
      error instanceof VerificationError && error.code === "ARTIFACT_DIGEST_MISMATCH"
  );
});

test("atomically releases budget and nonce when measured cost exceeds the maximum", async () => {
  const { manifest, installation, invocation } = fixture();
  const state = new MemoryExecutionStore({ [machine]: 1_000n });

  let sandbox: Sandbox = {
    async run() {
      return { output: "done", meteredCost: 101n };
    }
  };

  await assert.rejects(
    execute(invocation, { manifest, artifact, installation }, {
      sandbox,
      state,
      authorizer,
      now: () => 1_000
    }),
    (error: unknown) => error instanceof ExecutionError && error.code === "MAXIMUM_COST_EXCEEDED"
  );

  assert.deepEqual(state.balance(machine), { available: 1_000n, spent: 0n });

  sandbox = {
    async run() {
      return { output: "done", meteredCost: 10n };
    }
  };

  const result = await execute(
    invocation,
    { manifest, artifact, installation },
    { sandbox, state, authorizer, now: () => 1_000 }
  );
  assert.equal(result.receipt.cost, "10");
  assert.deepEqual(state.balance(machine), { available: 990n, spent: 10n });
});

test("rejects unknown manifest fields and inconsistent spend declarations", () => {
  const { manifest } = fixture();
  const unknownField = { ...manifest, hiddenAuthority: true };
  assert.throws(
    () => validateManifest(unknownField),
    (error: unknown) =>
      error instanceof VerificationError && error.code === "MANIFEST_FIELDS_INVALID"
  );

  const inconsistent = structuredClone(manifest);
  inconsistent.permissions.contracts.push({
    target: machine,
    selectors: ["0xa9059cbb"],
    maxValueWei: "1",
    spendMode: "calldataUint256",
    budgetAsset: machine,
    amountOffset: 36
  });
  assert.throws(
    () => validateManifest(inconsistent),
    (error: unknown) =>
      error instanceof VerificationError && error.code === "SPEND_MODE_INVALID"
  );
});

test("rejects a signed invocation after any authorized field is changed", async () => {
  const { manifest, installation, invocation } = fixture();
  const tampered = {
    ...invocation,
    input: { symbol: "ETH" }
  };

  await assert.rejects(
    execute(
      tampered,
      { manifest, artifact, installation },
      {
        sandbox: successfulSandbox,
        state: new MemoryExecutionStore({ [machine]: 1_000n }),
        authorizer,
        now: () => 1_000
      }
    ),
    (error: unknown) =>
      error instanceof ExecutionError && error.code === "AUTHORIZATION_DENIED"
  );
});
test("persists balances, nonces and receipts across a SQLite restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "firmware-runtime-"));
  const databasePath = join(directory, "execution.sqlite");
  const { manifest, installation, invocation } = fixture();

  try {
    let state = new SqliteExecutionStore(databasePath);
    state.fund(machine, 1_000n);

    const result = await execute(
      invocation,
      { manifest, artifact, installation },
      { sandbox: successfulSandbox, state, authorizer, now: () => 1_000 }
    );
    state.close();

    state = new SqliteExecutionStore(databasePath);
    assert.deepEqual(state.balance(machine), { available: 975n, spent: 25n });
    assert.deepEqual(state.getReceipt(invocationId), result.receipt);

    const replay = signed({ ...invocation, invocationId: "0x" + "55".repeat(32) });
    await assert.rejects(
      execute(
        replay,
        { manifest, artifact, installation },
        { sandbox: successfulSandbox, state, authorizer, now: () => 2_000 }
      ),
      (error: unknown) =>
        error instanceof ExecutionError && error.code === "NONCE_ALREADY_USED"
    );
    state.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("recovers an expired SQLite reservation after an interrupted process", async () => {
  const directory = await mkdtemp(join(tmpdir(), "firmware-recovery-"));
  const databasePath = join(directory, "execution.sqlite");
  const { invocation } = fixture();

  try {
    let state = new SqliteExecutionStore(databasePath);
    state.fund(machine, 1_000n);
    assert.equal(await state.begin(
      machine,
      invocation.nonce,
      invocation.deadline,
      invocation.invocationId,
      invocation.maximumCost
    ), true);
    assert.deepEqual(state.balance(machine), { available: 900n, spent: 0n });
    state.close();

    state = new SqliteExecutionStore(databasePath);
    assert.equal(state.recoverExpired(invocation.deadline), 1);
    assert.deepEqual(state.balance(machine), { available: 1_000n, spent: 0n });
    assert.equal(await state.begin(
      machine,
      invocation.nonce,
      invocation.deadline + 1_000,
      "0x" + "66".repeat(32),
      invocation.maximumCost
    ), true);
    await state.abort(machine, invocation.nonce, "0x" + "66".repeat(32));
    state.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("round trips a signed invocation through its JSON transport format", async () => {
  const { invocation } = fixture();
  const encoded = JSON.stringify(serializeInvocation(invocation));
  const decoded = parseInvocation(JSON.parse(encoded));

  assert.equal(decoded.maximumCost, 100n);
  assert.equal(decoded.signature, invocation.signature);
  assert.equal(await authorizer.verify(decoded), true);
});