import { describe, expect, it } from 'vitest';

import { ModelRegistry } from '../src/models/registry.js';
import {
  defaultLiveModels,
  getLiveModelMatrix,
  liveTemperature,
} from './live-models.js';

describe('live model matrix', () => {
  it('uses current registry-backed defaults and preserves legacy overrides', () => {
    const matrix = getLiveModelMatrix({});
    expect(matrix).toEqual(defaultLiveModels);

    const registry = new ModelRegistry();
    expect(registry.get(matrix.openai)).toMatchObject({ provider: 'openai' });
    expect(registry.get(matrix.anthropic)).toMatchObject({
      provider: 'anthropic',
    });
    expect(registry.get(matrix.gemini)).toMatchObject({ provider: 'google' });
    for (const model of Object.values(matrix)) {
      expect(registry.get(model).kind ?? 'completion').toBe('completion');
      expect(registry.get(model).supportsTools).toBe(true);
    }

    expect(
      getLiveModelMatrix({ LIVE_REAL_OPENAI_MODEL: 'legacy-openai' }).openai,
    ).toBe('legacy-openai');
    expect(
      getLiveModelMatrix({ LIVE_REAL_ANTHROPIC_MODEL: 'legacy-anthropic' })
        .anthropic,
    ).toBe('legacy-anthropic');
    expect(
      getLiveModelMatrix({ LIVE_REAL_GEMINI_MODEL: 'legacy-gemini' }).gemini,
    ).toBe('legacy-gemini');
    expect(
      getLiveModelMatrix({
        LIVE_REAL_OPENAI_MODEL: 'legacy-openai',
        LIVE_OPENAI_MODEL: 'explicit-openai',
      }).openai,
    ).toBe('explicit-openai');
  });

  it('omits temperature for the Luna OpenAI smoke path only', () => {
    expect(liveTemperature('openai', 'gpt-5.6-luna')).toEqual({});
    expect(liveTemperature('openai', 'custom-openai-model')).toEqual({
      temperature: 0,
    });
    expect(liveTemperature('anthropic', 'gpt-5.6-luna')).toEqual({
      temperature: 0,
    });
  });
});
