import {
  Contract,
  TypedDataEncoder,
  verifyTypedData,
  type Provider,
  type Signer
} from "ethers";
import type { Invocation, InvocationAuthorizer } from "./types.js";
import { hashJson } from "./verifier.js";

const DOMAIN_NAME = "firmware";
const DOMAIN_VERSION = "1";
const ERC1271_MAGIC_VALUE = "0x1626ba7e";
const ERC1271_ABI = [
  "function isValidSignature(bytes32 digest, bytes signature) view returns (bytes4)"
];

const INVOCATION_TYPES = {
  Invocation: [
    { name: "invocationId", type: "bytes32" },
    { name: "machine", type: "address" },
    { name: "chipId", type: "bytes32" },
    { name: "artifactDigest", type: "bytes32" },
    { name: "inputDigest", type: "bytes32" },
    { name: "maximumCost", type: "uint256" },
    { name: "deadline", type: "uint256" },
    { name: "nonce", type: "string" },
    { name: "routeDigest", type: "bytes32" }
  ]
};

export function invocationTypedData(invocation: Invocation) {
  return {
    domain: {
      name: DOMAIN_NAME,
      version: DOMAIN_VERSION,
      chainId: invocation.chainId,
      verifyingContract: invocation.verifyingContract
    },
    types: INVOCATION_TYPES,
    value: {
      invocationId: invocation.invocationId,
      machine: invocation.machine,
      chipId: invocation.chipId,
      artifactDigest: invocation.artifactDigest,
      inputDigest: hashJson(invocation.input),
      maximumCost: invocation.maximumCost,
      deadline: invocation.deadline,
      nonce: invocation.nonce,
      routeDigest: invocation.revenueRouteDigest
    }
  };
}

export function invocationDigest(invocation: Invocation): string {
  const typed = invocationTypedData(invocation);
  return TypedDataEncoder.hash(typed.domain, typed.types, typed.value);
}

export async function signInvocation<T>(
  invocation: Omit<Invocation<T>, "signature">,
  signer: Signer
): Promise<Invocation<T>> {
  const unsigned = { ...invocation, signature: "0x" } as Invocation<T>;
  const typed = invocationTypedData(unsigned);
  const signature = await signer.signTypedData(typed.domain, typed.types, typed.value);
  return { ...invocation, signature };
}

export class EvmInvocationAuthorizer implements InvocationAuthorizer {
  private readonly allowedChainIds: ReadonlySet<number>;

  constructor(
    allowedChainIds: Iterable<number>,
    private readonly provider?: Provider
  ) {
    this.allowedChainIds = new Set(allowedChainIds);
  }

  async verify(invocation: Invocation): Promise<boolean> {
    if (!this.allowedChainIds.has(invocation.chainId)) return false;
    if (
      invocation.verifyingContract.toLowerCase() !== invocation.machine.toLowerCase()
    ) {
      return false;
    }

    if (this.provider) {
      const code = await this.provider.getCode(invocation.machine);
      if (code !== "0x") {
        try {
          const account = new Contract(invocation.machine, ERC1271_ABI, this.provider);
          const result = await account.isValidSignature(
            invocationDigest(invocation),
            invocation.signature
          ) as string;
          return result.toLowerCase() === ERC1271_MAGIC_VALUE;
        } catch {
          return false;
        }
      }
    }

    try {
      const typed = invocationTypedData(invocation);
      const recovered = verifyTypedData(
        typed.domain,
        typed.types,
        typed.value,
        invocation.signature
      );
      return recovered.toLowerCase() === invocation.machine.toLowerCase();
    } catch {
      return false;
    }
  }
}