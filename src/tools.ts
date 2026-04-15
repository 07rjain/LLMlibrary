import type { CanonicalTool, JsonObject } from './types.js';

/**
 * Declares a tool while preserving TypeScript inference for its argument shape.
 *
 * @example
 * ```ts
 * const weather = defineTool({
 *   name: 'lookup_weather',
 *   description: 'Look up weather by city',
 *   parameters: {
 *     type: 'object',
 *     properties: {
 *       city: { type: 'string' },
 *     },
 *     required: ['city'],
 *   },
 *   async execute(args) {
 *     return { city: args.city, forecast: 'Sunny' };
 *   },
 * });
 * ```
 */
export function defineTool<TArgs extends JsonObject>(
  tool: CanonicalTool<TArgs>,
): CanonicalTool<TArgs> {
  return tool;
}
