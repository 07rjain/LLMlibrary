import { readFileSync } from 'node:fs';

const maxAgeDays = Number.parseInt(
  process.env.PRICE_STALENESS_DAYS ?? '45',
  10,
);
const noticeDays = 7;
const now = new Date();
const today = now.toISOString().slice(0, 10);
const noticeThrough = new Date(
  Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + noticeDays,
  ),
)
  .toISOString()
  .slice(0, 10);
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

const offers = Object.entries(prices)
  .filter(([, info]) => info.pricingExpiresAt)
  .map(([model, info]) => ({ model, pricingExpiresAt: info.pricingExpiresAt }));
const expiredModels = offers.filter(
  ({ pricingExpiresAt }) => pricingExpiresAt <= today,
);
const expiringModels = offers.filter(
  ({ pricingExpiresAt }) =>
    pricingExpiresAt > today && pricingExpiresAt <= noticeThrough,
);

console.log(
  JSON.stringify(
    {
      checkedModels: Object.keys(prices).length,
      maxAgeDays,
      ok: staleModels.length === 0 && expiredModels.length === 0,
      expiredModels,
      expiringModels,
      staleModels,
    },
    null,
    2,
  ),
);

for (const { model, pricingExpiresAt } of expiringModels) {
  const message = `Verified promotional pricing for ${model} expires on ${pricingExpiresAt} (UTC). Check for successor rates before then.`;
  console.warn(
    process.env.GITHUB_ACTIONS === 'true' ? `::warning::${message}` : message,
  );
}

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
