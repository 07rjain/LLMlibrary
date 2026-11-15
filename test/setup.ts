import { afterEach, beforeEach, vi } from 'vitest';

// Unit fixtures describe the verified catalog on this date. Keep historical
// models usable in tests as real-world shutdown and offer dates pass.
beforeEach(() => {
  if (
    ![
      process.env.LIVE_TESTS,
      process.env.LIVE_REAL_TESTS,
      process.env.LIVE_CONFORMANCE,
    ].includes('1')
  ) {
    vi.setSystemTime(new Date('2026-11-15T12:00:00Z'));
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
