import { DurableObject } from 'cloudflare:workers';
import type { Env } from './index';
import type { DeliveryOutcome } from './delivery';

export const RETENTION_MS = 24 * 60 * 60_000;
const HOUR_MS = 60 * 60_000;
type StoredState = 'pending' | 'accepted' | 'uncertain' | 'failed';
type StoredSubmission = { payload_hash: string; state: StoredState };

export type Reservation =
  | { state: StoredState | 'missing' | 'conflict' }
  | { state: 'reserved'; createdAt: number }
  | { state: 'limited'; retryAfter: number };

export class SubmissionStore extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS submissions (
      id TEXT PRIMARY KEY,
      payload_hash TEXT NOT NULL,
      ip_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending', 'accepted', 'uncertain', 'failed'))
    )`);
    ctx.storage.sql.exec('CREATE INDEX IF NOT EXISTS submissions_ip_time ON submissions(ip_hash, created_at)');
    ctx.storage.sql.exec('CREATE INDEX IF NOT EXISTS submissions_time ON submissions(created_at)');
  }

  lookup(id: string, payloadHash: string): Reservation {
    const rows = this.ctx.storage.sql.exec<StoredSubmission>(
      'SELECT payload_hash, state FROM submissions WHERE id = ? AND created_at > ?',
      id, Date.now() - RETENTION_MS,
    ).toArray();
    const row = rows[0];
    if (!row) return { state: 'missing' };
    if (row.payload_hash !== payloadHash) return { state: 'conflict' };
    return { state: row.state };
  }

  async reserve(id: string, payloadHash: string, ipHash: string): Promise<Reservation> {
    return this.ctx.blockConcurrencyWhile(async () => {
      const existing = this.lookup(id, payloadHash);
      if (existing.state !== 'missing') return existing;
      const now = Date.now();
      const expiry = now + RETENTION_MS;
      const alarm = await this.ctx.storage.getAlarm();
      // Schedule cleanup before committing a row, so a crash cannot leave it without an alarm.
      if (alarm === null || alarm > expiry) await this.ctx.storage.setAlarm(expiry);
      return this.ctx.storage.transactionSync(() => {
        const current = this.lookup(id, payloadHash);
        if (current.state !== 'missing') return current;
        const dayStart = Math.floor(now / RETENTION_MS) * RETENTION_MS;
        const recent = this.ctx.storage.sql.exec<{ created_at: number }>(
          'SELECT created_at FROM submissions WHERE ip_hash = ? AND created_at > ? ORDER BY created_at',
          ipHash, now - HOUR_MS,
        ).toArray();
        const daily = this.ctx.storage.sql.exec<{ total: number }>(
          'SELECT COUNT(*) AS total FROM submissions WHERE created_at >= ? AND created_at < ?',
          dayStart, dayStart + RETENTION_MS,
        ).one().total;
        let retryAt = now;
        if (recent.length >= 2) retryAt = Math.max(retryAt, (recent[0]?.created_at ?? now) + HOUR_MS);
        if (daily >= 25) retryAt = Math.max(retryAt, dayStart + RETENTION_MS);
        if (retryAt > now) return { state: 'limited', retryAfter: Math.ceil((retryAt - now) / 1000) };
        this.ctx.storage.sql.exec('DELETE FROM submissions WHERE created_at <= ?', now - RETENTION_MS);
        this.ctx.storage.sql.exec(
          'INSERT INTO submissions (id, payload_hash, ip_hash, created_at, state) VALUES (?, ?, ?, ?, ?)',
          id, payloadHash, ipHash, now, 'pending',
        );
        return { state: 'reserved', createdAt: now };
      });
    });
  }

  complete(id: string, payloadHash: string, createdAt: number, outcome: DeliveryOutcome): boolean {
    return this.ctx.storage.transactionSync(() => {
      const row = this.ctx.storage.sql.exec<{ state: StoredState }>(
        'SELECT state FROM submissions WHERE id = ? AND payload_hash = ? AND created_at = ? AND created_at > ?',
        id, payloadHash, createdAt, Date.now() - RETENTION_MS,
      ).toArray()[0];
      if (!row || (row.state !== 'pending' && row.state !== outcome)) {
        return false;
      }
      this.ctx.storage.sql.exec(
        'UPDATE submissions SET state = ? WHERE id = ? AND payload_hash = ? AND created_at = ?',
        outcome, id, payloadHash, createdAt,
      );
      return true;
    });
  }

  async alarm(): Promise<void> {
    await this.ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec('DELETE FROM submissions WHERE created_at <= ?', Date.now() - RETENTION_MS);
      const oldest = this.ctx.storage.sql.exec<{ created_at: number | null }>(
        'SELECT MIN(created_at) AS created_at FROM submissions',
      ).one().created_at;
      if (oldest === null) await this.ctx.storage.deleteAlarm();
      else await this.ctx.storage.setAlarm(oldest + RETENTION_MS);
    });
  }
}
