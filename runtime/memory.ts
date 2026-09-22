import type {
  ExecutionReceipt,
  ExecutionStateStore,
  HexDigest
} from "./types.js";
import { ExecutionError } from "./executor.js";

interface Account {
  available: bigint;
  spent: bigint;
}

interface Reservation {
  machine: string;
  maximumCost: bigint;
}

export class MemoryExecutionStore implements ExecutionStateStore {
  private readonly nonces = new Set<string>();
  private readonly reservations = new Map<HexDigest, Reservation>();
  private readonly receipts = new Map<HexDigest, ExecutionReceipt>();
  private readonly accounts = new Map<string, Account>();

  constructor(initialBalances: Record<string, bigint> = {}) {
    for (const [machine, available] of Object.entries(initialBalances)) {
      this.accounts.set(normalizeMachine(machine), { available, spent: 0n });
    }
  }

  fund(machine: string, amount: bigint): void {
    if (amount < 0n) throw new ExecutionError("INVALID_FUNDING_AMOUNT");
    const key = normalizeMachine(machine);
    const account = this.accounts.get(key) ?? { available: 0n, spent: 0n };
    account.available += amount;
    this.accounts.set(key, account);
  }

  async begin(
    machine: string,
    nonce: string,
    _deadline: number,
    invocationId: HexDigest,
    maximumCost: bigint
  ): Promise<boolean> {
    const machineKey = normalizeMachine(machine);
    const nonceKey = machineKey + ":" + nonce;
    if (this.nonces.has(nonceKey)) return false;
    if (this.reservations.has(invocationId) || this.receipts.has(invocationId)) {
      throw new ExecutionError("INVOCATION_ALREADY_EXISTS");
    }

    const account = this.accounts.get(machineKey);
    if (maximumCost <= 0n || !account || maximumCost > account.available) {
      throw new ExecutionError("BUDGET_EXCEEDED");
    }

    account.available -= maximumCost;
    this.nonces.add(nonceKey);
    this.reservations.set(invocationId, { machine: machineKey, maximumCost });
    return true;
  }

  async finalize(
    invocationId: HexDigest,
    actualCost: bigint,
    receipt: ExecutionReceipt
  ): Promise<void> {
    const reservation = this.reservations.get(invocationId);
    if (!reservation) throw new ExecutionError("RESERVATION_NOT_FOUND");
    if (actualCost < 0n || actualCost > reservation.maximumCost) {
      throw new ExecutionError("INVALID_ACTUAL_COST");
    }
    if (this.receipts.has(invocationId)) {
      throw new ExecutionError("RECEIPT_ALREADY_EXISTS");
    }

    const account = this.accounts.get(reservation.machine)!;
    account.available += reservation.maximumCost - actualCost;
    account.spent += actualCost;
    this.receipts.set(invocationId, Object.freeze({ ...receipt }));
    this.reservations.delete(invocationId);
  }

  async abort(machine: string, nonce: string, invocationId: HexDigest): Promise<void> {
    const reservation = this.reservations.get(invocationId);
    if (reservation) {
      const account = this.accounts.get(reservation.machine)!;
      account.available += reservation.maximumCost;
      this.reservations.delete(invocationId);
    }
    this.nonces.delete(normalizeMachine(machine) + ":" + nonce);
  }

  balance(machine: string): Readonly<Account> {
    const account = this.accounts.get(normalizeMachine(machine));
    return account ? { ...account } : { available: 0n, spent: 0n };
  }

  getReceipt(invocationId: HexDigest): ExecutionReceipt | undefined {
    return this.receipts.get(invocationId);
  }
}

function normalizeMachine(machine: string): string {
  return machine.toLowerCase();
}