import { describe, expect, it } from 'vitest';

import { defineTool } from '../src/tools.js';

describe('defineTool', () => {
  it('returns the tool definition unchanged', async () => {
    const tool = defineTool<{ city: string }>({
      description: 'Lookup a city',
      execute: async (args, context) => ({
        city: args.city,
        tenantId: context?.tenantId ?? null,
      }),
      name: 'lookup_city',
      parameters: {
        properties: {
          city: { type: 'string' },
        },
        required: ['city'],
        type: 'object',
      },
    });

    expect(tool.name).toBe('lookup_city');
    expect(tool.parameters.required).toEqual(['city']);
    expect(tool.description).toBe('Lookup a city');
    await expect(
      tool.execute?.(
        { city: 'Berlin' },
        { model: 'gpt-4o', provider: 'openai', tenantId: 'tenant-test' },
      ),
    ).resolves.toEqual({ city: 'Berlin', tenantId: 'tenant-test' });
  });
});
