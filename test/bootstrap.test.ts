import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import worker, { type Env as ContactEnv } from '../src/index';
import { contactRequest, TEST_TIME } from './fixtures';

declare global {
  // Workers exposes bindings through this required global declaration merge.
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Cloudflare {
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- Binding augmentation must be an interface.
    interface Env extends ContactEnv {}
  }
}

describe('contact test runtime', () => {
  it('leaves unconfigured delivery explicitly unavailable', async () => {
    const response = await worker.fetch(contactRequest(), env);
    expect(response.status).toBe(503);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual({ status: 'unavailable' });
  });

  it('uses SQLite-backed Durable Object storage', async () => {
    const stub = env.SUBMISSIONS.get(env.SUBMISSIONS.idFromName('bootstrap'));
    const result = await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec('CREATE TABLE bootstrap (value TEXT)');
      state.storage.sql.exec('INSERT INTO bootstrap VALUES (?)', 'inert fixture');
      return state.storage.sql.exec<{ value: string }>('SELECT value FROM bootstrap').one();
    });
    expect(result).toEqual({ value: 'inert fixture' });
  });

  it('provides a deterministic clock', () => {
    expect(Date.now()).toBe(TEST_TIME.getTime());
  });
});
