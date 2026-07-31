import { describe, expect, it, beforeEach } from 'vitest';

import { InMemorySessionStore } from '../src/session-store.js';

interface TestSession {
  messages: unknown[];
  totalCostUSD: number;
  data: string;
}

describe('Session Store', () => {
  describe('InMemorySessionStore', () => {
    let store: InMemorySessionStore<TestSession>;

    beforeEach(() => {
      store = new InMemorySessionStore<TestSession>();
    });

    it('should store and retrieve sessions', async () => {
      const session: TestSession = {
        messages: [{ content: 'test', role: 'user' }],
        totalCostUSD: 0.01,
        data: 'test data',
      };

      await store.set('session-1', session, {
        model: 'gpt-4o',
        provider: 'openai',
      });
      const retrieved = await store.get('session-1');

      expect(retrieved?.snapshot).toEqual(session);
    });

    it('should return null for non-existent sessions', async () => {
      const result = await store.get('non-existent');
      expect(result).toBeNull();
    });

    it('should update existing sessions', async () => {
      const session1: TestSession = {
        messages: [],
        totalCostUSD: 0.01,
        data: 'initial data',
      };
      const session2: TestSession = {
        messages: [],
        totalCostUSD: 0.02,
        data: 'updated data',
      };

      await store.set('session-1', session1, {
        model: 'gpt-4o',
        provider: 'openai',
      });
      await store.set('session-1', session2, {
        model: 'gpt-4o',
        provider: 'openai',
      });

      const retrieved = await store.get('session-1');

      expect(retrieved?.snapshot.data).toBe('updated data');
    });

    it('should delete sessions', async () => {
      const session: TestSession = {
        messages: [],
        totalCostUSD: 0.01,
        data: 'test data',
      };

      await store.set('session-1', session, {
        model: 'gpt-4o',
        provider: 'openai',
      });
      await store.delete('session-1');

      const result = await store.get('session-1');

      expect(result).toBeNull();
    });

    it('should list all sessions', async () => {
      await store.set(
        'session-1',
        { messages: [], totalCostUSD: 0.01, data: 'data1' },
        { model: 'gpt-4o', provider: 'openai' },
      );
      await store.set(
        'session-2',
        { messages: [], totalCostUSD: 0.02, data: 'data2' },
        { model: 'claude-sonnet-4-6', provider: 'anthropic' },
      );

      const sessions = await store.list();

      expect(sessions.length).toBe(2);
      expect(sessions.map((s) => s.sessionId).sort()).toEqual([
        'session-1',
        'session-2',
      ]);
    });

    it('should filter sessions by tenantId', async () => {
      await store.set(
        'session-1',
        { messages: [], totalCostUSD: 0.01, data: 'data1' },
        { model: 'gpt-4o', provider: 'openai', tenantId: 'tenant-a' },
      );
      await store.set(
        'session-2',
        { messages: [], totalCostUSD: 0.02, data: 'data2' },
        { model: 'gpt-4o', provider: 'openai', tenantId: 'tenant-b' },
      );

      const sessionsA = await store.list({ tenantId: 'tenant-a' });
      const sessionsB = await store.list({ tenantId: 'tenant-b' });

      expect(sessionsA.length).toBe(1);
      expect(sessionsA[0]?.sessionId).toBe('session-1');
      expect(sessionsB.length).toBe(1);
      expect(sessionsB[0]?.sessionId).toBe('session-2');
    });

    it('should get sessions with tenant isolation', async () => {
      await store.set(
        'shared-id',
        { messages: [], totalCostUSD: 0.01, data: 'tenant-a data' },
        { model: 'gpt-4o', provider: 'openai', tenantId: 'tenant-a' },
      );
      await store.set(
        'shared-id',
        { messages: [], totalCostUSD: 0.02, data: 'tenant-b data' },
        { model: 'gpt-4o', provider: 'openai', tenantId: 'tenant-b' },
      );

      const sessionA = await store.get('shared-id', 'tenant-a');
      const sessionB = await store.get('shared-id', 'tenant-b');

      expect(sessionA?.snapshot.data).toBe('tenant-a data');
      expect(sessionB?.snapshot.data).toBe('tenant-b data');
    });

    it('should store metadata with sessions', async () => {
      const session: TestSession = {
        messages: [],
        totalCostUSD: 0.01,
        data: 'test data',
      };

      await store.set('session-1', session, {
        model: 'gpt-4o',
        provider: 'openai',
        createdAt: '2026-04-15T09:00:00.000Z',
      });

      const result = await store.get('session-1');

      expect(result?.meta.model).toBe('gpt-4o');
      expect(result?.meta.provider).toBe('openai');
    });

    it('should handle concurrent operations', async () => {
      const promises = [];
      for (let i = 0; i < 10; i++) {
        promises.push(
          store.set(
            `session-${i}`,
            { messages: [], totalCostUSD: 0.01, data: `data-${i}` },
            { model: 'gpt-4o', provider: 'openai' },
          ),
        );
      }

      await Promise.all(promises);

      const sessions = await store.list();
      expect(sessions.length).toBe(10);
    });

    it('should track message count', async () => {
      await store.set(
        'session-1',
        {
          messages: [
            { role: 'user', content: '1' },
            { role: 'assistant', content: '2' },
          ],
          totalCostUSD: 0.01,
          data: 'test',
        },
        { model: 'gpt-4o', provider: 'openai' },
      );

      const sessions = await store.list();
      expect(sessions[0]?.messageCount).toBe(2);
    });

    it('supports opaque keyset pages with filters and deterministic ties', async () => {
      const fixedNow = new Date('2026-07-31T00:00:00.000Z');
      const pagedStore = new InMemorySessionStore<TestSession>({
        now: () => fixedNow,
      });
      for (const sessionId of ['a', 'b', 'c']) {
        await pagedStore.set(
          sessionId,
          { messages: [], totalCostUSD: 0, data: sessionId },
          { model: 'gpt-4o', provider: 'openai', tenantId: 'tenant-a' },
        );
      }

      const first = await pagedStore.listPage({
        limit: 1,
        model: 'gpt-4o',
        provider: 'openai',
        tenantId: 'tenant-a',
      });
      const second = await pagedStore.listPage({
        cursor: first.nextCursor,
        limit: 1,
        model: 'gpt-4o',
        provider: 'openai',
        tenantId: 'tenant-a',
      });

      expect(first.items.map((item) => item.sessionId)).toEqual(['a']);
      expect(second.items.map((item) => item.sessionId)).toEqual(['b']);
      expect(second.previousCursor).toBeDefined();
      await expect(
        pagedStore.listPage({
          cursor: first.nextCursor,
          direction: 'backward',
          limit: 1,
          model: 'gpt-4o',
          provider: 'openai',
          tenantId: 'tenant-a',
        }),
      ).rejects.toMatchObject({
        details: { code: 'invalid_session_cursor' },
        statusCode: 400,
      });
      await expect(
        pagedStore.listPage({ cursor: 'not-a-cursor' }),
      ).rejects.toMatchObject({
        details: { code: 'invalid_session_cursor' },
        statusCode: 400,
      });
      await expect(
        pagedStore.listPage({
          cursor: first.nextCursor as string,
          limit: 1,
          model: 'other-model',
          tenantId: 'tenant-a',
        }),
      ).rejects.toMatchObject({
        details: { code: 'invalid_session_cursor' },
        statusCode: 400,
      });
      await expect(pagedStore.listPage({ limit: 101 })).rejects.toMatchObject({
        details: { code: 'invalid_session_list_limit' },
        statusCode: 400,
      });

      const backwardFirst = await pagedStore.listPage({
        direction: 'backward',
        limit: 1,
        tenantId: 'tenant-a',
      });
      const backwardSecond = await pagedStore.listPage({
        cursor: backwardFirst.nextCursor as string,
        direction: 'backward',
        limit: 1,
        tenantId: 'tenant-a',
      });
      expect(backwardFirst.items.map((item) => item.sessionId)).toEqual(['c']);
      expect(backwardSecond.items.map((item) => item.sessionId)).toEqual(['b']);
    });

    it('orders non-BMP identifiers like Postgres C collation', async () => {
      const fixedNow = new Date('2026-07-31T00:00:00.000Z');
      const pagedStore = new InMemorySessionStore<TestSession>({
        now: () => fixedNow,
      });
      await pagedStore.set(
        '\u{10000}',
        { messages: [], totalCostUSD: 0, data: 'supplementary' },
        { tenantId: 'tenant-a' },
      );
      await pagedStore.set(
        '\uE000',
        { messages: [], totalCostUSD: 0, data: 'private-use' },
        { tenantId: 'tenant-a' },
      );
      await pagedStore.set(
        '\uFFFF',
        { messages: [], totalCostUSD: 0, data: 'noncharacter' },
        { tenantId: 'tenant-a' },
      );

      const page = await pagedStore.listPage({ tenantId: 'tenant-a' });

      expect(page.items.map((item) => item.sessionId)).toEqual([
        '\uE000',
        '\uFFFF',
        '\u{10000}',
      ]);
    });

    it('clears only its own records idempotently', async () => {
      const otherStore = new InMemorySessionStore<TestSession>();
      await store.set('owned', {
        messages: [],
        totalCostUSD: 0,
        data: 'owned',
      });
      await otherStore.set('other', {
        messages: [],
        totalCostUSD: 0,
        data: 'other',
      });

      await store.clear();
      await store.clear();

      await expect(store.get('owned')).resolves.toBeNull();
      await expect(store.list()).resolves.toEqual([]);
      await expect(otherStore.get('other')).resolves.not.toBeNull();
    });
  });

  describe('Session Store Interface', () => {
    it('should enforce SessionStore interface', () => {
      const store = new InMemorySessionStore<TestSession>();

      expect(typeof store.get).toBe('function');
      expect(typeof store.set).toBe('function');
      expect(typeof store.delete).toBe('function');
      expect(typeof store.list).toBe('function');
    });
  });
});
