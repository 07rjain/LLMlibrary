import { describe, expect, it } from 'vitest';

import { defineTool } from '../src/tools.js';

import type { CanonicalTool, JsonObject } from '../src/types.js';

describe('Tool Definitions', () => {
  describe('defineTool', () => {
    it('should create a valid tool definition', () => {
      const tool = defineTool({
        name: 'search',
        description: 'Search the web',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query' },
          },
          required: ['query'],
        },
      });

      expect(tool.name).toBe('search');
      expect(tool.description).toBe('Search the web');
      expect(tool.parameters.type).toBe('object');
    });

    it('should create tool with execute function', () => {
      const tool = defineTool({
        name: 'calculate',
        description: 'Perform calculation',
        parameters: {
          type: 'object',
          properties: {
            expression: { type: 'string' },
          },
        },
        execute: async (args) => {
          return { result: args.expression };
        },
      });

      expect(typeof tool.execute).toBe('function');
    });

    it('should create tool with complex parameters', () => {
      const tool = defineTool({
        name: 'create_user',
        description: 'Create a new user',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            age: { type: 'integer' },
            email: { type: 'string' },
            roles: {
              type: 'array',
              items: { type: 'string' },
            },
            settings: {
              type: 'object',
              properties: {
                theme: { type: 'string', enum: ['light', 'dark'] },
                notifications: { type: 'boolean' },
              },
            },
          },
          required: ['name', 'email'],
        },
      });

      expect(tool.parameters.properties?.roles?.type).toBe('array');
      expect(tool.parameters.properties?.settings?.type).toBe('object');
      expect(tool.parameters.required).toContain('name');
      expect(tool.parameters.required).toContain('email');
    });

    it('should preserve tool type information', () => {
      interface SearchArgs extends JsonObject {
        query: string;
        limit?: number;
      }

      const tool = defineTool<SearchArgs>({
        name: 'typed_search',
        description: 'Type-safe search',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            limit: { type: 'integer' },
          },
          required: ['query'],
        },
        execute: async (args) => {
          return { query: args.query, limit: args.limit ?? 10 };
        },
      });

      expect(tool.name).toBe('typed_search');
    });
  });

  describe('Tool Collections', () => {
    it('should create multiple tools for a domain', () => {
      const fileTools: CanonicalTool[] = [
        defineTool({
          name: 'read_file',
          description: 'Read file contents',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string' },
            },
            required: ['path'],
          },
        }),
        defineTool({
          name: 'write_file',
          description: 'Write file contents',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              content: { type: 'string' },
            },
            required: ['path', 'content'],
          },
        }),
        defineTool({
          name: 'list_directory',
          description: 'List directory contents',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string' },
            },
            required: ['path'],
          },
        }),
      ];

      expect(fileTools.length).toBe(3);
      expect(fileTools.map((t) => t.name)).toEqual([
        'read_file',
        'write_file',
        'list_directory',
      ]);
    });

    it('should support tool with execution context', async () => {
      const tool = defineTool({
        name: 'context_aware',
        description: 'Uses execution context',
        parameters: {
          type: 'object',
          properties: {},
        },
        execute: async (_args, context) => {
          return {
            sessionId: context?.sessionId,
            tenantId: context?.tenantId,
            model: context?.model,
          };
        },
      });

      const result = await tool.execute?.(
        {},
        {
          sessionId: 'session-123',
          tenantId: 'tenant-456',
          model: 'gpt-4o',
          provider: 'openai',
        },
      );

      expect(result).toEqual({
        sessionId: 'session-123',
        tenantId: 'tenant-456',
        model: 'gpt-4o',
      });
    });
  });
});
