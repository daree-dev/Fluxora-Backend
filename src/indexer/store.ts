import { ContractEventRecord, IndexerStoreKind, ReorgRecord } from './types.js';

export type InsertContractEventsResult = { insertedEventIds: string[]; duplicateEventIds: string[]; };

export interface ContractEventStore {
  readonly kind: IndexerStoreKind;
  insertMany(events: ContractEventRecord[]): Promise<InsertContractEventsResult>;
  rollbackBeforeLedger(ledger: number): Promise<void>;
  getLedgerHash(ledger: number): Promise<string | null>;
}

export interface PgClientLike {
  query<T = unknown>(text: string, values?: unknown[]): Promise<{ rows: T[]; rowCount?: number | null }>;
}

export class InMemoryContractEventStore implements ContractEventStore {
  public readonly kind: IndexerStoreKind = 'memory';
  private readonly records = new Map<string, ContractEventRecord>();
  private readonly reorgLog: ReorgRecord[] = [];

  async insertMany(events: ContractEventRecord[]): Promise<InsertContractEventsResult> {
    const insertedEventIds: string[] = [];
    const duplicateEventIds: string[] = [];
    const staged = new Map<string, ContractEventRecord>();
    for (const event of events) {
      if (this.records.has(event.eventId) || staged.has(event.eventId)) {
        duplicateEventIds.push(event.eventId);
        continue;
      }
      staged.set(event.eventId, { ...event, ingestedAt: new Date().toISOString() });
      insertedEventIds.push(event.eventId);
    }
    for (const [id, record] of staged) { this.records.set(id, record); }
    return { insertedEventIds, duplicateEventIds };
  }

  async rollbackBeforeLedger(forkLedger: number): Promise<void> {
    const removedEventIds: string[] = [];
    let evictedHash = '';
    for (const record of this.records.values()) {
      if (record.ledger === forkLedger) { evictedHash = record.ledgerHash; break; }
    }
    for (const [eventId, record] of this.records) {
      if (record.ledger >= forkLedger) { removedEventIds.push(eventId); this.records.delete(eventId); }
    }
    if (removedEventIds.length > 0 || evictedHash !== '') {
      this.reorgLog.push({ forkLedger, evictedHash, incomingHash: '', removedEventIds, rolledBackAt: new Date().toISOString() });
    }
  }

  async getLedgerHash(ledger: number): Promise<string | null> {
    for (const record of this.records.values()) {
      if (record.ledger === ledger) return record.ledgerHash;
    }
    return null;
  }

  reset(): void { this.records.clear(); this.reorgLog.length = 0; }

  all(): ContractEventRecord[] {
    return [...this.records.values()].sort((a, b) => a.eventId.localeCompare(b.eventId));
  }

  byLedger(ledger: number): ContractEventRecord[] {
    return [...this.records.values()].filter((r) => r.ledger === ledger).sort((a, b) => a.eventIndex - b.eventIndex);
  }

  getReorgLog(): Readonly<ReorgRecord[]> { return this.reorgLog; }

  ledgerCount(): number {
    return new Set([...this.records.values()].map((r) => r.ledger)).size;
  }

  tipLedger(): number | null {
    let tip: number | null = null;
    for (const record of this.records.values()) {
      if (tip === null || record.ledger > tip) tip = record.ledger;
    }
    return tip;
  }
}

export class PostgresContractEventStore implements ContractEventStore {
  public readonly kind: IndexerStoreKind = 'postgres';
  constructor(private readonly client: PgClientLike, private readonly tableName = 'contract_events') {}

  async insertMany(events: ContractEventRecord[]): Promise<InsertContractEventsResult> {
    if (events.length === 0) return { insertedEventIds: [], duplicateEventIds: [] };
    const values: unknown[] = [];
    const placeholders = events.map((event, index) => {
      const o = index * 11;
      values.push(event.eventId, event.ledger, event.contractId, event.topic, event.txHash, event.txIndex, event.operationIndex, event.eventIndex, JSON.stringify(event.payload), event.happenedAt, event.ledgerHash);
      return `($${o+1},$${o+2},$${o+3},$${o+4},$${o+5},$${o+6},$${o+7},$${o+8},$${o+9}::jsonb,$${o+10}::timestamptz,$${o+11})`;
    });
    const sql = `INSERT INTO ${this.tableName} (event_id,ledger,contract_id,topic,tx_hash,tx_index,operation_index,event_index,payload,happened_at,ledger_hash) VALUES ${placeholders.join(',')} ON CONFLICT (event_id) DO NOTHING RETURNING event_id`;
    const result = await this.client.query<{ event_id: string }>(sql, values);
    const insertedEventIds = result.rows.map((r) => r.event_id);
    const inserted = new Set(insertedEventIds);
    const duplicateEventIds = events.map((e) => e.eventId).filter((id) => !inserted.has(id));
    return { insertedEventIds, duplicateEventIds };
  }

  async rollbackBeforeLedger(ledger: number): Promise<void> {
    await this.client.query(`DELETE FROM ${this.tableName} WHERE ledger >= $1`, [ledger]);
  }

  async getLedgerHash(ledger: number): Promise<string | null> {
    const result = await this.client.query<{ ledger_hash: string }>(`SELECT ledger_hash FROM ${this.tableName} WHERE ledger = $1 LIMIT 1`, [ledger]);
    return result.rows[0]?.ledger_hash ?? null;
  }
}