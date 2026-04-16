export function getEnvironmentVariable(name: string): string | undefined {
  if (typeof process === 'undefined' || !process.env) {
    return undefined;
  }

  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}

export function isProductionRuntime(): boolean {
  return getEnvironmentVariable('NODE_ENV') === 'production';
}
