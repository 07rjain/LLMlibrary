import { readFileSync } from 'node:fs';

const maxAgeDays = Number.parseInt(
  process.env.PRICE_STALENESS_DAYS ?? '45',
  10,
);
const now = new Date();
const today = now.toISOString().slice(0, 10);
const prices = JSON.parse(
  readFileSync(new URL('../src/models/prices.json', import.meta.url), 'utf8'),
);

const staleModels = Object.entries(prices)
  .map(([model, info]) => {
    const lastUpdated = new Date(String(info.lastUpdated));
    const ageDays = Math.floor(
      (now.getTime() - lastUpdated.getTime()) / (24 * 60 * 60 * 1000),
    );

    return {
      ageDays,
      lastUpdated: String(info.lastUpdated),
      model,
      provider: info.provider,
    };
  })
  .filter(
    (entry) => Number.isFinite(entry.ageDays) && entry.ageDays > maxAgeDays,
  );

const expiredModels = Object.entries(prices)
  .filter(([, info]) => info.pricingExpiresAt && info.pricingExpiresAt <= today)
  .map(([model, info]) => ({ model, pricingExpiresAt: info.pricingExpiresAt }));

console.log(
  JSON.stringify(
    {
      checkedModels: Object.keys(prices).length,
      maxAgeDays,
      ok: staleModels.length === 0 && expiredModels.length === 0,
      expiredModels,
      staleModels,
    },
    null,
    2,
  ),
);

if (staleModels.length > 0) {
  throw new Error(
    `Price metadata is stale for ${staleModels.map((entry) => entry.model).join(', ')}.`,
  );
}

if (expiredModels.length > 0) {
  throw new Error(
    `Verified promotional pricing has expired for ${expiredModels.map((entry) => entry.model).join(', ')}.`,
  );
}
