import { DatabaseSync } from "node:sqlite";
import type {
  ExecutionReceipt,
  ExecutionStateStore,
  HexDigest
} from "./types.js";
import { ExecutionError } from "./executor.js";

interface AccountRow {
  available: string;
  spent: string;
}

interface ReservationRow {
  machine: string;
  nonce: string;
  deadline: number;
  maximum_cost: string;
}

interface ReceiptRow {
  payload: string;
}

export class SqliteExecutionStore implements ExecutionStateStore {
  private readonly db: DatabaseSync;

  constructor(databasePath: string) {
    this.db = new DatabaseSync(databasePath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = FULL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        machine TEXT PRIMARY KEY,
        available TEXT NOT NULL,
        spent TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS nonces (
        machine TEXT NOT NULL,
        nonce TEXT NOT NULL,
        deadline INTEGER NOT NULL,
        PRIMARY KEY (machine, nonce)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS reservations (
        invocation_id TEXT PRIMARY KEY,
        machine TEXT NOT NULL,
        nonce TEXT NOT NULL,
        deadline INTEGER NOT NULL,
        maximum_cost TEXT NOT NULL,
        FOREIGN KEY (machine) REFERENCES accounts(machine)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS receipts (
        invocation_id TEXT PRIMARY KEY,
        payload TEXT NOT NULL
      ) STRICT;
    `);
  }

  close(): void {
    this.db.close();
  }

  fund(machine: string, amount: bigint): void {
    if (amount < 0n) throw new ExecutionError("INVALID_FUNDING_AMOUNT");
    const key = normalizeMachine(machine);

    this.transaction(() => {
      const current = this.db.prepare(
        "SELECT available, spent FROM accounts WHERE machine = ?"
      ).get(key) as AccountRow | undefined;

      if (current) {
        this.db.prepare(
          "UPDATE accounts SET available = ? WHERE machine = ?"
        ).run((BigInt(current.available) + amount).toString(), key);
      } else {
        this.db.prepare(
          "INSERT INTO accounts(machine, available, spent) VALUES (?, ?, '0')"
        ).run(key, amount.toString());
      }
    });
  }

  async begin(
    machine: string,
    nonce: string,
    deadline: number,
    invocationId: HexDigest,
    maximumCost: bigint
  ): Promise<boolean> {
    const key = normalizeMachine(machine);
    return this.transaction(() => {
      const usedNonce = this.db.prepare(
        "SELECT 1 AS found FROM nonces WHERE machine = ? AND nonce = ?"
      ).get(key, nonce);
      if (usedNonce) return false;

      const duplicate = this.db.prepare(
        `SELECT 1 AS found FROM reservations WHERE invocation_id = ?
         UNION ALL
         SELECT 1 AS found FROM receipts WHERE invocation_id = ?
         LIMIT 1`
      ).get(invocationId, invocationId);
      if (duplicate) throw new ExecutionError("INVOCATION_ALREADY_EXISTS");

      const account = this.db.prepare(
        "SELECT available, spent FROM accounts WHERE machine = ?"
      ).get(key) as AccountRow | undefined;
      if (maximumCost <= 0n || !account || maximumCost > BigInt(account.available)) {
        throw new ExecutionError("BUDGET_EXCEEDED");
      }

      this.db.prepare(
        "UPDATE accounts SET available = ? WHERE machine = ?"
      ).run((BigInt(account.available) - maximumCost).toString(), key);
      this.db.prepare(
        "INSERT INTO nonces(machine, nonce, deadline) VALUES (?, ?, ?)"
      ).run(key, nonce, deadline);
      this.db.prepare(
        "INSERT INTO reservations(invocation_id, machine, nonce, deadline, maximum_cost) VALUES (?, ?, ?, ?, ?)"
      ).run(invocationId, key, nonce, deadline, maximumCost.toString());
      return true;
    });
  }

  async finalize(
    invocationId: HexDigest,
    actualCost: bigint,
    receipt: ExecutionReceipt
  ): Promise<void> {
    this.transaction(() => {
      const reservation = this.db.prepare(
        "SELECT machine, maximum_cost FROM reservations WHERE invocation_id = ?"
      ).get(invocationId) as ReservationRow | undefined;
      if (!reservation) throw new ExecutionError("RESERVATION_NOT_FOUND");

      const maximumCost = BigInt(reservation.maximum_cost);
      if (actualCost < 0n || actualCost > maximumCost) {
        throw new ExecutionError("INVALID_ACTUAL_COST");
      }

      const account = this.db.prepare(
        "SELECT available, spent FROM accounts WHERE machine = ?"
      ).get(reservation.machine) as unknown as AccountRow;

      this.db.prepare(
        "INSERT INTO receipts(invocation_id, payload) VALUES (?, ?)"
      ).run(invocationId, JSON.stringify(receipt));
      this.db.prepare(
        "UPDATE accounts SET available = ?, spent = ? WHERE machine = ?"
      ).run(
        (BigInt(account.available) + maximumCost - actualCost).toString(),
        (BigInt(account.spent) + actualCost).toString(),
        reservation.machine
      );
      this.db.prepare(
        "DELETE FROM reservations WHERE invocation_id = ?"
      ).run(invocationId);
    });
  }

  async abort(machine: string, nonce: string, invocationId: HexDigest): Promise<void> {
    const key = normalizeMachine(machine);
    this.transaction(() => {
      const reservation = this.db.prepare(
        "SELECT machine, maximum_cost FROM reservations WHERE invocation_id = ?"
      ).get(invocationId) as ReservationRow | undefined;

      if (reservation) {
        const account = this.db.prepare(
          "SELECT available, spent FROM accounts WHERE machine = ?"
        ).get(reservation.machine) as unknown as AccountRow;
        this.db.prepare(
          "UPDATE accounts SET available = ? WHERE machine = ?"
        ).run(
          (BigInt(account.available) + BigInt(reservation.maximum_cost)).toString(),
          reservation.machine
        );
        this.db.prepare(
          "DELETE FROM reservations WHERE invocation_id = ?"
        ).run(invocationId);
      }

      this.db.prepare(
        "DELETE FROM nonces WHERE machine = ? AND nonce = ?"
      ).run(key, nonce);
    });
  }

  recoverExpired(now: number = Date.now()): number {
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new ExecutionError("RECOVERY_TIME_INVALID");
    }

    return this.transaction(() => {
      const expired = this.db.prepare(
        "SELECT invocation_id, machine, nonce, deadline, maximum_cost FROM reservations WHERE deadline <= ?"
      ).all(now) as unknown as Array<ReservationRow & { invocation_id: string }>;

      for (const reservation of expired) {
        const account = this.db.prepare(
          "SELECT available, spent FROM accounts WHERE machine = ?"
        ).get(reservation.machine) as unknown as AccountRow;
        this.db.prepare(
          "UPDATE accounts SET available = ? WHERE machine = ?"
        ).run(
          (BigInt(account.available) + BigInt(reservation.maximum_cost)).toString(),
          reservation.machine
        );
        this.db.prepare(
          "DELETE FROM reservations WHERE invocation_id = ?"
        ).run(reservation.invocation_id);
        this.db.prepare(
          "DELETE FROM nonces WHERE machine = ? AND nonce = ?"
        ).run(reservation.machine, reservation.nonce);
      }

      return expired.length;
    });
  }
  balance(machine: string): { available: bigint; spent: bigint } {
    const account = this.db.prepare(
      "SELECT available, spent FROM accounts WHERE machine = ?"
    ).get(normalizeMachine(machine)) as AccountRow | undefined;
    return account
      ? { available: BigInt(account.available), spent: BigInt(account.spent) }
      : { available: 0n, spent: 0n };
  }

  getReceipt(invocationId: HexDigest): ExecutionReceipt | undefined {
    const row = this.db.prepare(
      "SELECT payload FROM receipts WHERE invocation_id = ?"
    ).get(invocationId) as ReceiptRow | undefined;
    return row ? JSON.parse(row.payload) as ExecutionReceipt : undefined;
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      if (
        error instanceof Error &&
        error.message.includes("UNIQUE constraint failed: receipts.invocation_id")
      ) {
        throw new ExecutionError("RECEIPT_ALREADY_EXISTS");
      }
      throw error;
    }
  }
}

function normalizeMachine(machine: string): string {
  return machine.toLowerCase();
}