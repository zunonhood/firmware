export type HexDigest = string;

export interface ContractPermission {
  target: string;
  selectors: string[];
  maxValueWei: string;
  spendMode: "none" | "nativeValue" | "calldataUint256";
  budgetAsset: string;
  amountOffset: number;
}

export interface SpendPermission {
  asset: string;
  perInvocation: string;
  perWindow: string;
  windowSeconds: number;
}

export interface ChipManifest {
  manifestVersion: "1";
  chipId: HexDigest;
  name: string;
  version: string;
  artifact: {
    uri: string;
    sha256: HexDigest;
    runtime: "wasm32-wasi" | "container" | "remote";
  };
  entrypoint: string;
  permissions: {
    network: string[];
    contracts: ContractPermission[];
    spend: SpendPermission[];
    delegation: boolean;
  };
  economics: {
    model: "fixed" | "metered";
    asset: string;
    maximumPrice: string;
  };
}

export interface Installation {
  chipId: HexDigest;
  version: string;
  manifestDigest: HexDigest;
  artifactDigest: HexDigest;
  expiresAt: number;
  revoked: boolean;
}

export interface Invocation<TInput = unknown> {
  invocationId: HexDigest;
  machine: string;
  chipId: HexDigest;
  artifactDigest: HexDigest;
  input: TInput;
  maximumCost: bigint;
  deadline: number;
  nonce: string;
  revenueRouteDigest: HexDigest;
  chainId: number;
  verifyingContract: string;
  signature: string;
}

export type SerializedInvocation<TInput = unknown> =
  Omit<Invocation<TInput>, "maximumCost"> & {
    maximumCost: string;
  };
export interface SandboxResult<TOutput = unknown> {
  output: TOutput;
  meteredCost: bigint;
}

export interface ExecutionReceipt {
  receiptVersion: "1";
  invocationId: HexDigest;
  machine: string;
  chipId: HexDigest;
  chipVersion: string;
  artifactDigest: HexDigest;
  inputDigest: HexDigest;
  outputDigest: HexDigest;
  startedAt: number;
  completedAt: number;
  cost: string;
  routeDigest: HexDigest;
  status: "completed";
}

export interface InvocationAuthorizer {
  verify(invocation: Invocation): Promise<boolean>;
}

export interface Sandbox {
  run(
    artifact: Uint8Array,
    entrypoint: string,
    input: unknown,
    manifest: ChipManifest
  ): Promise<SandboxResult<unknown>>;
}

export interface ExecutionStateStore {
  begin(
    machine: string,
    nonce: string,
    deadline: number,
    invocationId: HexDigest,
    maximumCost: bigint
  ): Promise<boolean>;
  finalize(
    invocationId: HexDigest,
    actualCost: bigint,
    receipt: ExecutionReceipt
  ): Promise<void>;
  abort(machine: string, nonce: string, invocationId: HexDigest): Promise<void>;
}