import { describe, expect, it, vi } from 'vitest';

import { ConsoleLogger } from '../src/usage.js';

import type { UsageEvent, UsageQuery, UsageLogger } from '../src/usage.js';

describe('Usage Logging', () => {
  describe('ConsoleLogger', () => {
    const createUsageEvent = (overrides: Partial<UsageEvent> = {}): UsageEvent => ({
      cachedTokens: 0,
      cost: '$0.01',
      costUSD: 0.01,
      durationMs: 500,
      finishReason: 'stop',
      inputTokens: 100,
      model: 'gpt-4o',
      outputTokens: 50,
      provider: 'openai',
      timestamp: new Date().toISOString(),
      ...overrides,
    });

    it('should log usage events when enabled', () => {
      const writeMock = vi.fn();
      const logger = new ConsoleLogger({ enabled: true, write: writeMock });

      logger.log(createUsageEvent());

      expect(writeMock).toHaveBeenCalledTimes(1);
      expect(writeMock.mock.calls[0]?.[0]).toContain('llm-usage');
    });

    it('should not log when disabled', () => {
      const writeMock = vi.fn();
      const logger = new ConsoleLogger({ enabled: false, write: writeMock });

      logger.log(createUsageEvent());

      expect(writeMock).not.toHaveBeenCalled();
    });

    it('should serialize event data as JSON', () => {
      const writeMock = vi.fn();
      const logger = new ConsoleLogger({ enabled: true, write: writeMock });
      const event = createUsageEvent({ model: 'gpt-4o', provider: 'openai' });

      logger.log(event);

      const loggedMessage = writeMock.mock.calls[0]?.[0] as string;
      expect(loggedMessage).toContain('gpt-4o');
      expect(loggedMessage).toContain('openai');
    });

    it('should include all event fields', () => {
      const writeMock = vi.fn();
      const logger = new ConsoleLogger({ enabled: true, write: writeMock });
      const event = createUsageEvent({
        botId: 'bot-1',
        sessionId: 'session-1',
        tenantId: 'tenant-1',
      });

      logger.log(event);

      const loggedMessage = writeMock.mock.calls[0]?.[0] as string;
      expect(loggedMessage).toContain('bot-1');
      expect(loggedMessage).toContain('session-1');
      expect(loggedMessage).toContain('tenant-1');
    });
  });

  describe('UsageLogger Interface', () => {
    it('should define the log method', () => {
      const mockLogger: UsageLogger = {
        log: vi.fn(),
      };

      expect(typeof mockLogger.log).toBe('function');
    });

    it('should support optional methods', () => {
      const mockLogger: UsageLogger = {
        log: vi.fn(),
        flush: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined),
        getUsage: vi.fn(async () => ({
          breakdown: [],
          requestCount: 0,
          totalCachedTokens: 0,
          totalCostUSD: 0,
          totalInputTokens: 0,
          totalOutputTokens: 0,
        })),
      };

      expect(typeof mockLogger.flush).toBe('function');
      expect(typeof mockLogger.close).toBe('function');
      expect(typeof mockLogger.getUsage).toBe('function');
    });
  });

  describe('Usage Query Interface', () => {
    it('should support all query parameters', () => {
      const query: UsageQuery = {
        botId: 'bot-1',
        until: '2026-04-15T23:59:59Z',
        model: 'gpt-4o',
        provider: 'openai',
        sessionId: 'session-1',
        since: '2026-04-01T00:00:00Z',
        tenantId: 'tenant-1',
      };

      expect(query.botId).toBe('bot-1');
      expect(query.tenantId).toBe('tenant-1');
      expect(query.model).toBe('gpt-4o');
    });
  });
});
