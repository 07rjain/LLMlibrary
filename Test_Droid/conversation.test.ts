import { describe, expect, it, vi } from 'vitest';

import { Conversation } from '../src/conversation.js';
import { BudgetExceededError, MaxToolRoundsError } from '../src/errors.js';

import type { ConversationClient, ConversationSnapshot } from '../src/conversation.js';
import type { CanonicalResponse, CanonicalTool, StreamChunk } from '../src/types.js';

describe('Conversation - Core Functionality', () => {
  describe('Message Management', () => {
    it('should create a new conversation with system prompt', () => {
      const client = createMockClient();
      const conversation = new Conversation(client, {
        system: 'You are a helpful assistant.',
        sessionId: 'test-session',
      });

      expect(conversation.toMessages()).toEqual([
        { content: 'You are a helpful assistant.', pinned: true, role: 'system' },
      ]);
      expect(conversation.id).toBe('test-session');
    });

    it('should append user messages and get assistant response', async () => {
      const client = createMockClient({
        completeResponse: {
          content: [{ text: 'Hello!', type: 'text' }],
          finishReason: 'stop',
          model: 'gpt-4o',
          provider: 'openai',
          raw: {},
          text: 'Hello!',
          toolCalls: [],
          usage: { cachedTokens: 0, cost: '$0.01', costUSD: 0.01, inputTokens: 10, outputTokens: 5 },
        },
      });

      const conversation = new Conversation(client, { system: 'Be helpful' });
      const response = await conversation.send('Hi there');

      expect(response.text).toBe('Hello!');
      expect(conversation.history.length).toBe(2);
      expect(conversation.history[0]).toEqual({ content: 'Hi there', role: 'user' });
      expect(conversation.history[1]).toEqual({ content: 'Hello!', role: 'assistant' });
    });

    it('should clear non-system history', async () => {
      const client = createMockClient({
        completeResponse: {
          content: [{ text: 'Response', type: 'text' }],
          finishReason: 'stop',
          model: 'gpt-4o',
          provider: 'openai',
          raw: {},
          text: 'Response',
          toolCalls: [],
          usage: { cachedTokens: 0, cost: '$0.01', costUSD: 0.01, inputTokens: 5, outputTokens: 3 },
        },
      });

      const conversation = new Conversation(client, { system: 'System prompt' });
      await conversation.send('Message 1');
      expect(conversation.history.length).toBe(2);

      conversation.clear();

      expect(conversation.history.length).toBe(0);
      expect(conversation.toMessages()).toEqual([
        { content: 'System prompt', pinned: true, role: 'system' },
      ]);
    });
  });

  describe('Cost Tracking', () => {
    it('should track cumulative costs across multiple turns', async () => {
      let callCount = 0;
      const client = createMockClient({
        completeResponse: () => {
          callCount += 1;
          return {
            content: [{ text: `Response ${callCount}`, type: 'text' }],
            finishReason: 'stop',
            model: 'gpt-4o',
            provider: 'openai',
            raw: {},
            text: `Response ${callCount}`,
            toolCalls: [],
            usage: { cachedTokens: 0, cost: '$0.05', costUSD: 0.05, inputTokens: 10, outputTokens: 5 },
          };
        },
      });

      const conversation = new Conversation(client, { system: 'Test' });
      await conversation.send('First');
      await conversation.send('Second');

      const totals = conversation.totals;
      expect(totals.costUSD).toBe(0.1);
      expect(totals.inputTokens).toBe(20);
      expect(totals.outputTokens).toBe(10);
    });

    it('should track budget usage', async () => {
      const client = createMockClient({
        completeResponse: {
          content: [{ text: 'Response', type: 'text' }],
          finishReason: 'stop',
          model: 'gpt-4o',
          provider: 'openai',
          raw: {},
          text: 'Response',
          toolCalls: [],
          usage: { cachedTokens: 0, cost: '$0.50', costUSD: 0.5, inputTokens: 100, outputTokens: 50 },
        },
      });

      const conversation = new Conversation(client, { budgetUsd: 1.0, system: 'Test' });

      await conversation.send('First');
      expect(conversation.totals.costUSD).toBe(0.5);
    });
  });

  describe('Tool Execution', () => {
    it('should execute tools and continue conversation loop', async () => {
      const toolExecutor = vi.fn(async () => ({ result: 'tool output' }));
      const tools: CanonicalTool[] = [
        {
          description: 'A test tool',
          execute: toolExecutor,
          name: 'test_tool',
          parameters: { type: 'object', properties: {} },
        },
      ];

      let callCount = 0;
      const client = createMockClient({
        completeResponse: () => {
          callCount += 1;
          if (callCount === 1) {
            return {
              content: [{ args: { input: 'test' }, id: 'call_1', name: 'test_tool', type: 'tool_call' }],
              finishReason: 'tool_call',
              model: 'gpt-4o',
              provider: 'openai',
              raw: {},
              text: '',
              toolCalls: [{ args: { input: 'test' }, id: 'call_1', name: 'test_tool' }],
              usage: { cachedTokens: 0, cost: '$0.01', costUSD: 0.01, inputTokens: 10, outputTokens: 5 },
            };
          }
          return {
            content: [{ text: 'Done with tool', type: 'text' }],
            finishReason: 'stop',
            model: 'gpt-4o',
            provider: 'openai',
            raw: {},
            text: 'Done with tool',
            toolCalls: [],
            usage: { cachedTokens: 0, cost: '$0.01', costUSD: 0.01, inputTokens: 15, outputTokens: 8 },
          };
        },
      });

      const conversation = new Conversation(client, { tools });
      const response = await conversation.send('Use the tool');

      expect(toolExecutor).toHaveBeenCalledWith({ input: 'test' }, expect.any(Object));
      expect(response.text).toBe('Done with tool');
    });

    it('should enforce max tool rounds limit', async () => {
      const tools: CanonicalTool[] = [
        {
          description: 'Infinite loop tool',
          execute: async () => ({ result: 'continue' }),
          name: 'loop_tool',
          parameters: { type: 'object', properties: {} },
        },
      ];

      const client = createMockClient({
        completeResponse: {
          content: [{ args: {}, id: 'call_1', name: 'loop_tool', type: 'tool_call' }],
          finishReason: 'tool_call',
          model: 'gpt-4o',
          provider: 'openai',
          raw: {},
          text: '',
          toolCalls: [{ args: {}, id: 'call_1', name: 'loop_tool' }],
          usage: { cachedTokens: 0, cost: '$0.01', costUSD: 0.01, inputTokens: 5, outputTokens: 3 },
        },
      });

      const conversation = new Conversation(client, { maxToolRounds: 2, tools });

      await expect(conversation.send('Trigger loop')).rejects.toThrow(MaxToolRoundsError);
    });

    it('should handle tool execution errors gracefully', async () => {
      const tools: CanonicalTool[] = [
        {
          description: 'Failing tool',
          execute: async () => { throw new Error('Tool crashed'); },
          name: 'failing_tool',
          parameters: { type: 'object', properties: {} },
        },
      ];

      let callCount = 0;
      const client = createMockClient({
        completeResponse: () => {
          callCount += 1;
          if (callCount === 1) {
            return {
              content: [{ args: {}, id: 'call_1', name: 'failing_tool', type: 'tool_call' }],
              finishReason: 'tool_call',
              model: 'gpt-4o',
              provider: 'openai',
              raw: {},
              text: '',
              toolCalls: [{ args: {}, id: 'call_1', name: 'failing_tool' }],
              usage: { cachedTokens: 0, cost: '$0.01', costUSD: 0.01, inputTokens: 5, outputTokens: 3 },
            };
          }
          return {
            content: [{ text: 'Handled error', type: 'text' }],
            finishReason: 'stop',
            model: 'gpt-4o',
            provider: 'openai',
            raw: {},
            text: 'Handled error',
            toolCalls: [],
            usage: { cachedTokens: 0, cost: '$0.01', costUSD: 0.01, inputTokens: 10, outputTokens: 5 },
          };
        },
      });

      const conversation = new Conversation(client, { tools });
      const response = await conversation.send('Use failing tool');

      expect(response.text).toBe('Handled error');
    });
  });

;

  describe('Serialization', () => {
    it('should serialize and deserialize conversation state', async () => {
      const client = createMockClient({
        completeResponse: {
          content: [{ text: 'Response', type: 'text' }],
          finishReason: 'stop',
          model: 'gpt-4o',
          provider: 'openai',
          raw: {},
          text: 'Response',
          toolCalls: [],
          usage: { cachedTokens: 0, cost: '$0.05', costUSD: 0.05, inputTokens: 10, outputTokens: 5 },
        },
      });

      const conversation = new Conversation(client, {
        sessionId: 'serialize-test',
        system: 'Be helpful',
        model: 'gpt-4o',
        provider: 'openai',
      });

      await conversation.send('Test message');

      const snapshot = conversation.serialise();

      expect(snapshot.sessionId).toBe('serialize-test');
      expect(snapshot.system).toBe('Be helpful');
      expect(snapshot.messages.length).toBe(2);
      expect(snapshot.totalCostUSD).toBe(0.05);
    });

    it('should restore conversation from snapshot', () => {
      const client = createMockClient();
      const snapshot: ConversationSnapshot = {
        createdAt: '2026-04-15T09:00:00.000Z',
        messages: [
          { content: 'User message', role: 'user' },
          { content: 'Assistant response', role: 'assistant' },
        ],
        model: 'gpt-4o',
        provider: 'openai',
        sessionId: 'restored-session',
        system: 'Restored system',
        totalCachedTokens: 5,
        totalCostUSD: 0.1,
        totalInputTokens: 50,
        totalOutputTokens: 25,
        updatedAt: '2026-04-15T10:00:00.000Z',
      };

      const conversation = Conversation.restore(client, snapshot);

      expect(conversation.id).toBe('restored-session');
      expect(conversation.history.length).toBe(2);
      expect(conversation.totals.costUSD).toBe(0.1);
      expect(conversation.toMessages()[0]).toEqual({
        content: 'Restored system',
        pinned: true,
        role: 'system',
      });
    });
  });

  describe('Markdown Export', () => {
    it('should export conversation as markdown', async () => {
      const client = createMockClient({
        completeResponse: {
          content: [{ text: 'Hello human!', type: 'text' }],
          finishReason: 'stop',
          model: 'gpt-4o',
          provider: 'openai',
          raw: {},
          text: 'Hello human!',
          toolCalls: [],
          usage: { cachedTokens: 0, cost: '$0.01', costUSD: 0.01, inputTokens: 5, outputTokens: 3 },
        },
      });

      const conversation = new Conversation(client, {
        sessionId: 'markdown-test',
        system: 'Be concise',
        model: 'gpt-4o',
        provider: 'openai',
      });

      await conversation.send('Hello');
      const markdown = conversation.toMarkdown();

      expect(markdown).toContain('# Conversation markdown-test');
      expect(markdown).toContain('## System');
      expect(markdown).toContain('Be concise');
      expect(markdown).toContain('## User');
      expect(markdown).toContain('Hello');
      expect(markdown).toContain('## Assistant');
      expect(markdown).toContain('Hello human!');
    });
  });


});

function createMockClient(options: {
  completeResponse?: CanonicalResponse | (() => CanonicalResponse) | (() => Promise<CanonicalResponse>);
  streamResponse?: () => AsyncGenerator<StreamChunk, void, void>;
} = {}): ConversationClient {
  const defaultResponse: CanonicalResponse = {
    content: [{ text: 'Default response', type: 'text' }],
    finishReason: 'stop',
    model: 'gpt-4o',
    provider: 'openai',
    raw: {},
    text: 'Default response',
    toolCalls: [],
    usage: { cachedTokens: 0, cost: '$0.01', costUSD: 0.01, inputTokens: 5, outputTokens: 3 },
  };

  return {
    complete: vi.fn(async () => {
      if (!options.completeResponse) return defaultResponse;
      if (typeof options.completeResponse === 'function') {
        return options.completeResponse();
      }
      return options.completeResponse;
    }),
    stream: vi.fn(function* () {
      if (options.streamResponse) {
        return options.streamResponse();
      }
      return (async function* () {
        yield { delta: 'Default', type: 'text-delta' } as StreamChunk;
        yield {
          finishReason: 'stop',
          type: 'done',
          usage: { cachedTokens: 0, cost: '$0.01', costUSD: 0.01, inputTokens: 5, outputTokens: 3 },
        } as StreamChunk;
      })();
    }) as ConversationClient['stream'],
  };
}
