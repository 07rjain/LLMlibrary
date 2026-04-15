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

      await store.set('session-1', session, { model: 'gpt-4o', provider: 'openai' });
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

      await store.set('session-1', session1, { model: 'gpt-4o', provider: 'openai' });
      await store.set('session-1', session2, { model: 'gpt-4o', provider: 'openai' });

      const retrieved = await store.get('session-1');

      expect(retrieved?.snapshot.data).toBe('updated data');
    });

    it('should delete sessions', async () => {
      const session: TestSession = {
        messages: [],
        totalCostUSD: 0.01,
        data: 'test data',
      };

      await store.set('session-1', session, { model: 'gpt-4o', provider: 'openai' });
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
      expect(sessions.map((s) => s.sessionId).sort()).toEqual(['session-1', 'session-2']);
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
        { messages: [{ role: 'user', content: '1' }, { role: 'assistant', content: '2' }], totalCostUSD: 0.01, data: 'test' },
        { model: 'gpt-4o', provider: 'openai' },
      );

      const sessions = await store.list();
      expect(sessions[0]?.messageCount).toBe(2);
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
