import { invalid } from './validation-helpers.js';

export function validateBudgetUsd(
  value: unknown,
  option = 'budgetUsd',
): asserts value is number | undefined {
  if (
    value === undefined ||
    (typeof value === 'number' && Number.isFinite(value) && value >= 0)
  ) {
    return;
  }
  invalid(
    {
      code: 'invalid_budget',
      message: 'Invalid request budget.',
      option,
    },
    'finite_non_negative_number',
    { valueType: value === null ? 'null' : typeof value },
  );
}
