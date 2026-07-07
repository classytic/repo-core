/**
 * `runChunkedArchive` orchestrator — write-before-delete ordering,
 * chunk progression, error phases, abort/retry interplay. Pure port/sink
 * doubles; kit-level behavior gets covered by the conformance suite.
 */

import { describe, expect, it } from 'vitest';
import type { ArchivePort, ArchiveSink } from '../../../src/repository/archive.js';
import { runChunkedArchive } from '../../../src/repository/archive.js';

interface Row {
  id: number;
}

/** Port over a mutable array — reads ascending, deletes by identity. */
function arrayPort(rows: Row[]): ArchivePort<Row> {
  return {
    readChunk: async (limit) => rows.slice(0, limit),
    deleteChunk: async (docs) => {
      const ids = new Set(docs.map((d) => d.id));
      const before = rows.length;
      for (let i = rows.length - 1; i >= 0; i--) {
        const row = rows[i];
        if (row && ids.has(row.id)) rows.splice(i, 1);
      }
      return before - rows.length;
    },
  };
}

function collectingSink(): ArchiveSink<Row> & { docs: Row[]; flushes: number } {
  const collected: Row[] = [];
  const sink = {
    docs: collected,
    flushes: 0,
    write: async (docs: readonly Row[]) => {
      collected.push(...docs);
    },
    flush: async () => {
      sink.flushes += 1;
    },
  };
  return sink;
}

const seed = (n: number): Row[] => Array.from({ length: n }, (_, i) => ({ id: i }));

describe('runChunkedArchive', () => {
  it('drains the source in chunks, sink receives every row, flush fires once', async () => {
    const rows = seed(25);
    const sink = collectingSink();
    const progress: number[] = [];

    const result = await runChunkedArchive(
      {
        batchSize: 10,
        onProgress: (e) => {
          progress.push(e.processed);
        },
      },
      sink,
      arrayPort(rows),
    );

    expect(result.ok).toBe(true);
    expect(result.processed).toBe(25);
    expect(sink.docs).toHaveLength(25);
    expect(rows).toHaveLength(0);
    expect(progress).toEqual([10, 20, 25]);
    expect(sink.flushes).toBe(1);
  });

  it('write-before-delete: sink failure reports phase "sink" and deletes nothing', async () => {
    const rows = seed(5);
    const result = await runChunkedArchive(
      {},
      {
        write: async () => {
          throw new Error('boom');
        },
      },
      arrayPort(rows),
    );

    expect(result.ok).toBe(false);
    expect(result.error?.phase).toBe('sink');
    expect(result.processed).toBe(0);
    expect(rows).toHaveLength(5); // nothing lost
  });

  it('read failure reports phase "read"; delete failure reports phase "delete"', async () => {
    const readFail = await runChunkedArchive({}, collectingSink(), {
      readChunk: async () => {
        throw new Error('read boom');
      },
      deleteChunk: async () => 0,
    });
    expect(readFail.error?.phase).toBe('read');

    const deleteFail = await runChunkedArchive({}, collectingSink(), {
      readChunk: async () => [{ id: 1 }],
      deleteChunk: async () => {
        throw new Error('delete boom');
      },
    });
    expect(deleteFail.error?.phase).toBe('delete');
  });

  it('retries transient step failures with the shared RetryPolicy', async () => {
    const rows = seed(3);
    let writeAttempts = 0;
    const sink: ArchiveSink<Row> = {
      write: async () => {
        writeAttempts += 1;
        if (writeAttempts === 1) throw new Error('transient');
      },
    };

    const result = await runChunkedArchive(
      { retry: { maxAttempts: 3, baseDelayMs: 1 } },
      sink,
      arrayPort(rows),
    );

    expect(result.ok).toBe(true);
    expect(result.processed).toBe(3);
    expect(writeAttempts).toBe(2);
  });

  it('abort between chunks keeps committed chunks and reports partial count', async () => {
    const rows = seed(25);
    const sink = collectingSink();
    const controller = new AbortController();

    const result = await runChunkedArchive(
      {
        batchSize: 10,
        signal: controller.signal,
        onProgress: (e) => {
          if (e.processed === 10) controller.abort();
        },
      },
      sink,
      arrayPort(rows),
    );

    expect(result.ok).toBe(false);
    expect(result.processed).toBe(10);
    expect(rows).toHaveLength(15);
    expect(sink.flushes).toBe(0); // flush only on clean completion
  });

  it('rejects a non-positive batchSize loudly', async () => {
    await expect(
      runChunkedArchive({ batchSize: 0 }, collectingSink(), arrayPort([])),
    ).rejects.toThrow(/batchSize/);
  });

  it('empty source completes ok with processed 0 (flush still fires)', async () => {
    const sink = collectingSink();
    const result = await runChunkedArchive({}, sink, arrayPort([]));
    expect(result.ok).toBe(true);
    expect(result.processed).toBe(0);
    expect(sink.flushes).toBe(1);
  });
});
