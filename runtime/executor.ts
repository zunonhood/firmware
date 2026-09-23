import type {
  ChipManifest,
  ExecutionReceipt,
  ExecutionStateStore,
  Installation,
  Invocation,
  InvocationAuthorizer,
  Sandbox
} from "./types.js";
import { hashJson, validateInvocation, verifyInstallation } from "./verifier.js";

export interface ExecutionDependencies {
  sandbox: Sandbox;
  state: ExecutionStateStore;
  authorizer: InvocationAuthorizer;
  now?: () => number;
}

export interface ExecutionPackage {
  manifest: ChipManifest;
  artifact: Uint8Array;
  installation: Installation;
}

export class ExecutionError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "ExecutionError";
  }
}

export async function execute<TInput, TOutput>(
  invocation: Invocation<TInput>,
  installed: ExecutionPackage,
  dependencies: ExecutionDependencies
): Promise<{ output: TOutput; receipt: ExecutionReceipt }> {
  validateInvocation(invocation);

  const now = dependencies.now ?? Date.now;
  const startedAt = now();

  if (startedAt >= invocation.deadline) throw new ExecutionError("INVOCATION_EXPIRED");
  if (
    invocation.chipId.toLowerCase() !== installed.installation.chipId.toLowerCase() ||
    invocation.artifactDigest.toLowerCase() !== installed.installation.artifactDigest.toLowerCase()
  ) {
    throw new ExecutionError("INSTALLATION_MISMATCH");
  }

  if (!await dependencies.authorizer.verify(invocation)) {
    throw new ExecutionError("AUTHORIZATION_DENIED");
  }

  verifyInstallation(
    installed.manifest,
    installed.artifact,
    installed.installation,
    startedAt
  );

  const begun = await dependencies.state.begin(
    invocation.machine,
    invocation.nonce,
    invocation.deadline,
    invocation.invocationId,
    invocation.maximumCost
  );
  if (!begun) throw new ExecutionError("NONCE_ALREADY_USED");

  let finalized = false;
  try {
    const result = await dependencies.sandbox.run(
      installed.artifact,
      installed.manifest.entrypoint,
      invocation.input,
      installed.manifest
    );

    if (result.meteredCost > invocation.maximumCost) {
      throw new ExecutionError("MAXIMUM_COST_EXCEEDED");
    }

    const receipt: ExecutionReceipt = {
      receiptVersion: "1",
      invocationId: invocation.invocationId,
      machine: invocation.machine,
      chipId: invocation.chipId,
      chipVersion: installed.manifest.version,
      artifactDigest: installed.installation.artifactDigest,
      inputDigest: hashJson(invocation.input),
      outputDigest: hashJson(result.output),
      startedAt,
      completedAt: now(),
      cost: result.meteredCost.toString(),
      routeDigest: invocation.revenueRouteDigest,
      status: "completed"
    };

    await dependencies.state.finalize(
      invocation.invocationId,
      result.meteredCost,
      receipt
    );
    finalized = true;
    return { output: result.output as TOutput, receipt };
  } catch (error) {
    if (!finalized) {
      await dependencies.state.abort(
        invocation.machine,
        invocation.nonce,
        invocation.invocationId
      );
    }
    throw error;
  }
}