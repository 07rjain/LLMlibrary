import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('pricecheck', () => {
  it.each([
    ['2026-11-23', 0, false],
    ['2026-11-24', 0, true],
    ['2026-11-30', 0, true],
    ['2026-12-01', 1, false],
  ])('classifies the offer as of %s UTC', (date, status, expiring) => {
    const fixture = mkdtempSync(join(tmpdir(), 'llm-pricecheck-'));
    try {
      mkdirSync(join(fixture, 'scripts'));
      mkdirSync(join(fixture, 'src', 'models'), { recursive: true });
      const script = join(fixture, 'scripts', 'check-price-staleness.mjs');
      copyFileSync(
        new URL('../scripts/check-price-staleness.mjs', import.meta.url),
        script,
      );
      const offer = { model: 'promo-model', pricingExpiresAt: '2026-12-01' };
      writeFileSync(
        join(fixture, 'src', 'models', 'prices.json'),
        JSON.stringify({
          [offer.model]: {
            lastUpdated: '2026-11-15',
            pricingExpiresAt: offer.pricingExpiresAt,
          },
        }),
      );
      const clock = `data:text/javascript,globalThis.Date=class extends Date{constructor(...args){super(...(args.length?args:[${JSON.stringify(date + 'T00:00:00Z')}]));}}`;
      const result = spawnSync(process.execPath, ['--import', clock, script], {
        encoding: 'utf8',
        env: {
          ...process.env,
          GITHUB_ACTIONS: 'true',
          PRICE_STALENESS_DAYS: '45',
        },
      });

      expect(result.status, result.stderr).toBe(status);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: status === 0,
        expiredModels: status === 1 ? [offer] : [],
        expiringModels: expiring ? [offer] : [],
      });
      expect(result.stderr.includes('::warning::')).toBe(expiring);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});
