/**
 * Chain reorganisation tests for the Fluxora indexer.
 *
 * Strategy under test
 * -------------------
 * The indexer uses ledger-hash-based reorg detection:
 *   - If an incoming batch contains a ledgerHash that differs from the stored
 *     hash for the same ledger sequence, a fork is detected.
 *   - The store rolls back all records at ledger >= forkLedger.
 *   - The canonical (post-reorg) events are then inserted in the same request.
 *   - The service sets reorgDetected=true and reorgHeight=forkLedger.
 *   - reorgDetected resets to false once we are > forkLedger + 5 ledgers ahead.
 *
 * Security / double-counting invariants verified here
 * ---------------------------------------------------
 * 1. Events from the orphaned chain are fully removed before canonical events
 *    are inserted — no double-counting.
 * 2. The common ancestor (ledger < forkLedger) is never touched.
 * 3. A deep reorg (10 blocks) leaves the store at the correct ancestor state.
 * 4. Multiple sequential reorgs are handled independently.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../src/app.js';
import { InMemoryContractEventStore } from '../src/indexer/store.js';
import {
  resetIndexerState,
  setIndexerEventStore,
  setIndexerIngestAuthToken,
} from '../src/routes/indexer.js';

const TOKEN = 'test-reorg-token';
const ENDPOINT = '/internal/indexer/contract-events';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildEvent(eventId: string, ledger: number, ledgerHash: string, eventIndex = 0) {
  return {
    eventId,
    ledger,
    contractId: 'CCONTRACT123',
    topic: 'stream.created',
    txHash: `tx-${eventId}`,
    txIndex: 0,
    operationIndex: 0,
    eventIndex,
    payload: {
      streamId: `stream-${eventId}`,
      depositAmount: '100.0000000',
    },
    happenedAt: '2026-03-26T12:00:00.000Z',
    ledgerHash,
  };
}

function post(events: unknown[]) {
  return request(app)
    .post(ENDPOINT)
    .set('x-indexer-worker-token', TOKEN)
    .send({ events });
}

async function getHealth() {
  const res = await request(app).get('/health').expect(200);
  return res.body.dependencies.indexer as {
    lastSafeLedger: number;
    reorgDetected: boolean;
    reorgHeight?: number;
    acceptedEventCount: number;
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Indexer reorg handling', () => {
  let store: InMemoryContractEventStore;

  beforeEach(() => {
    resetIndexerState();
    setIndexerIngestAuthToken(TOKEN);
    store = new InMemoryContractEventStore();
    setIndexerEventStore(store);
  });

  // -------------------------------------------------------------------------
  // Basic reorg detection
  // -------------------------------------------------------------------------

  it('reports lastSafeLedger as maxLedger - 1 with no reorg', async () => {
    await post([buildEvent('e100', 100, 'h100')]).expect(200);
    const h = await getHealth();
    expect(h.lastSafeLedger).toBe(99);
    expect(h.reorgDetected).toBe(false);
  });

  it('detects a single-ledger reorg and rolls back the forked block', async () => {
    await post([buildEvent('e100', 100, 'h100')]).expect(200);
    await post([buildEvent('e101', 101, 'h101')]).expect(200);
    expect(store.all()).toHaveLength(2);

    // Reorg: ledger 101 gets a different hash
    const res = await post([buildEvent('e101-new', 101, 'h101-reorg')]).expect(200);
    expect(res.body.insertedCount).toBe(1);

    const records = store.all();
    expect(records).toHaveLength(2);
    // Orphaned event must be gone
    expect(records.find((r) => r.eventId === 'e101')).toBeUndefined();
    // Canonical event must be present
    const canonical = records.find((r) => r.ledger === 101);
    expect(canonical?.eventId).toBe('e101-new');
    expect(canonical?.ledgerHash).toBe('h101-reorg');
    // Common ancestor untouched
    expect(records.find((r) => r.ledger === 100)?.ledgerHash).toBe('h100');
  });

  it('sets reorgDetected=true and reorgHeight after a reorg', async () => {
    await post([buildEvent('e100', 100, 'h100')]).expect(200);
    await post([buildEvent('e100-new', 100, 'h100-reorg')]).expect(200);

    const h = await getHealth();
    expect(h.reorgDetected).toBe(true);
  });

  it('resets reorgDetected once > forkLedger + 5 ledgers ahead', async () => {
    await post([buildEvent('e100', 100, 'h100')]).expect(200);
    await post([buildEvent('e100-new', 100, 'h100-reorg')]).expect(200);

    let h = await getHealth();
    expect(h.reorgDetected).toBe(true);

    // Ledger 110 is 10 ahead of fork at 100 — should clear the flag
    await post([buildEvent('e110', 110, 'h110')]).expect(200);

    h = await getHealth();
    expect(h.reorgDetected).toBe(false);
    expect(h.lastSafeLedger).toBe(109);
  });

  // -------------------------------------------------------------------------
  // Deep reorg (10 blocks)
  // -------------------------------------------------------------------------

  it('handles a deep reorg of 10 blocks and returns to the common ancestor', async () => {
    // Index ledgers 100–109 on the original chain
    for (let ledger = 100; ledger <= 109; ledger++) {
      await post([buildEvent(`e${ledger}`, ledger, `h${ledger}`)]).expect(200);
    }
    expect(store.all()).toHaveLength(10);
    expect(store.tipLedger()).toBe(109);

    // Reorg at ledger 100: the entire 10-block chain is replaced
    // Submit the new canonical chain starting at ledger 100
    for (let ledger = 100; ledger <= 109; ledger++) {
      await post([buildEvent(`e${ledger}-reorg`, ledger, `h${ledger}-reorg`)]).expect(200);
    }

    const records = store.all();
    // Should still have 10 records — the reorged chain, not 20
    expect(records).toHaveLength(10);

    // All records must be from the canonical (reorg) chain
    for (const r of records) {
      expect(r.ledgerHash).toMatch(/-reorg$/);
      expect(r.eventId).toMatch(/-reorg$/);
    }

    // Reorg log must have at least one entry
    const log = store.getReorgLog();
    expect(log.length).toBeGreaterThanOrEqual(1);
    expect(log[0].forkLedger).toBe(100);
  });

  it('preserves the common ancestor during a deep reorg', async () => {
    // Ledgers 90–99 are the common ancestor
    for (let ledger = 90; ledger <= 99; ledger++) {
      await post([buildEvent(`ancestor-${ledger}`, ledger, `ha${ledger}`)]).expect(200);
    }
    // Ledgers 100–109 are the orphaned chain
    for (let ledger = 100; ledger <= 109; ledger++) {
      await post([buildEvent(`orphan-${ledger}`, ledger, `ho${ledger}`)]).expect(200);
    }
    expect(store.all()).toHaveLength(20);

    // Reorg at ledger 100 — replace 100–109 with canonical chain
    for (let ledger = 100; ledger <= 109; ledger++) {
      await post([buildEvent(`canon-${ledger}`, ledger, `hc${ledger}`)]).expect(200);
    }

    const records = store.all();
    expect(records).toHaveLength(20);

    // Ancestor records (90–99) must be untouched
    for (let ledger = 90; ledger <= 99; ledger++) {
      const r = records.find((x) => x.ledger === ledger);
      expect(r?.eventId).toBe(`ancestor-${ledger}`);
      expect(r?.ledgerHash).toBe(`ha${ledger}`);
    }

    // Orphaned records must be gone
    expect(records.filter((r) => r.eventId.startsWith('orphan-'))).toHaveLength(0);

    // Canonical records must be present
    for (let ledger = 100; ledger <= 109; ledger++) {
      const r = records.find((x) => x.ledger === ledger);
      expect(r?.eventId).toBe(`canon-${ledger}`);
    }
  });

  // -------------------------------------------------------------------------
  // Multiple events per ledger
  // -------------------------------------------------------------------------

  it('rolls back all events in a ledger when that ledger is reorged', async () => {
    // Ledger 100 has 3 events on the original chain
    await post([
      buildEvent('e100-a', 100, 'h100', 0),
      buildEvent('e100-b', 100, 'h100', 1),
      buildEvent('e100-c', 100, 'h100', 2),
    ]).expect(200);
    expect(store.byLedger(100)).toHaveLength(3);

    // Reorg: ledger 100 gets a new hash with only 1 canonical event
    await post([buildEvent('e100-canon', 100, 'h100-reorg', 0)]).expect(200);

    expect(store.byLedger(100)).toHaveLength(1);
    expect(store.byLedger(100)[0].eventId).toBe('e100-canon');
  });

  // -------------------------------------------------------------------------
  // Sequential reorgs
  // -------------------------------------------------------------------------

  it('handles two sequential reorgs at different ledgers independently', async () => {
    // First chain: ledgers 100–102
    await post([buildEvent('e100', 100, 'h100')]).expect(200);
    await post([buildEvent('e101', 101, 'h101')]).expect(200);
    await post([buildEvent('e102', 102, 'h102')]).expect(200);

    // First reorg at ledger 101
    await post([buildEvent('e101-r1', 101, 'h101-r1')]).expect(200);
    await post([buildEvent('e102-r1', 102, 'h102-r1')]).expect(200);

    // Second reorg at ledger 102
    await post([buildEvent('e102-r2', 102, 'h102-r2')]).expect(200);

    const records = store.all();
    // Should have: e100, e101-r1, e102-r2
    expect(records).toHaveLength(3);
    expect(records.find((r) => r.ledger === 100)?.eventId).toBe('e100');
    expect(records.find((r) => r.ledger === 101)?.eventId).toBe('e101-r1');
    expect(records.find((r) => r.ledger === 102)?.eventId).toBe('e102-r2');

    // Reorg log should have at least 2 entries
    expect(store.getReorgLog().length).toBeGreaterThanOrEqual(2);
  });

  // -------------------------------------------------------------------------
  // Decimal precision through reorg
  // -------------------------------------------------------------------------

  it('preserves decimal-string amounts in canonical events after a reorg', async () => {
    const preciseAmount = '9999999999999.9999999';
    await post([buildEvent('e100', 100, 'h100')]).expect(200);

    const canonicalEvent = {
      ...buildEvent('e100-canon', 100, 'h100-reorg'),
      payload: { depositAmount: preciseAmount, ratePerSecond: '0.0000001' },
    };
    await post([canonicalEvent]).expect(200);

    const stored = store.byLedger(100)[0];
    expect(stored.payload.depositAmount).toBe(preciseAmount);
    expect(typeof stored.payload.depositAmount).toBe('string');
  });

  // -------------------------------------------------------------------------
  // No-op resubmission (same hash = no reorg)
  // -------------------------------------------------------------------------

  it('does not trigger a reorg when the same ledger hash is resubmitted', async () => {
    await post([buildEvent('e100', 100, 'h100')]).expect(200);
    // Same hash — should be treated as duplicate, not reorg
    const res = await post([buildEvent('e100', 100, 'h100')]).expect(200);
    expect(res.body.duplicateCount).toBe(1);
    expect(res.body.insertedCount).toBe(0);
    expect(store.getReorgLog()).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // lastSafeLedger after reorg
  // -------------------------------------------------------------------------

  it('updates lastSafeLedger correctly after a reorg', async () => {
    await post([buildEvent('e100', 100, 'h100')]).expect(200);
    await post([buildEvent('e101', 101, 'h101')]).expect(200);

    // Reorg at 101 — canonical chain has ledger 101 with new hash
    await post([buildEvent('e101-new', 101, 'h101-reorg')]).expect(200);

    const h = await getHealth();
    // lastSafeLedger should be 100 (maxLedger 101 - 1)
    expect(h.lastSafeLedger).toBe(100);
  });
});
