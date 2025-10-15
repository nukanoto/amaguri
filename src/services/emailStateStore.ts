import { STATE_KEY } from "../constants";
import type { WorkerState } from "../types";

const INSERT_STATE_SQL =
  "INSERT INTO state (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value";
const DELETE_HASHES_SQL = "DELETE FROM hashes WHERE state_key = ?1";
const SELECT_STATE_SQL = "SELECT value FROM state WHERE key = ?1";
const SELECT_HASHES_SQL = "SELECT hash FROM hashes WHERE state_key = ?1 ORDER BY ordinal ASC";

const HASH_INSERT_CHUNK = 400;

export class EmailStateStore {
  constructor(private readonly db: D1Database) {}

  async load(): Promise<WorkerState | null> {
    const stateRow = await this.db
      .prepare(SELECT_STATE_SQL)
      .bind(STATE_KEY)
      .first<{ value: string }>();
    const hashesResult = await this.db
      .prepare(SELECT_HASHES_SQL)
      .bind(STATE_KEY)
      .all<{ hash: string }>();
    const hashes = hashesResult.results?.map((row) => row.hash) ?? [];

    if (!stateRow && hashes.length === 0) {
      return null;
    }

    return {
      lastCheck: stateRow?.value ?? null,
      hashes,
    };
  }

  async save(state: WorkerState & { lastCheck: string }): Promise<void> {
    await this.db.prepare(DELETE_HASHES_SQL).bind(STATE_KEY).run();

    if (state.hashes.length > 0) {
      for (let offset = 0; offset < state.hashes.length; offset += HASH_INSERT_CHUNK) {
        const chunk = state.hashes.slice(offset, offset + HASH_INSERT_CHUNK);
        const placeholders = chunk.map(() => "(?, ?, ?)").join(", ");
        const statement = this.db.prepare(
          `INSERT INTO hashes (state_key, ordinal, hash) VALUES ${placeholders}`,
        );
        const params: (string | number)[] = [];
        // D1 のプレースホルダー上限を超えないようにチャンク単位で挿入する。
        chunk.forEach((hash, index) => {
          params.push(STATE_KEY, offset + index, hash);
        });
        await statement.bind(...params).run();
      }
    }

    await this.db.prepare(INSERT_STATE_SQL).bind(STATE_KEY, state.lastCheck).run();
  }
}
