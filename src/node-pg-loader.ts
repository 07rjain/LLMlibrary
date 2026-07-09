export async function loadPgPoolConstructor() {
  const module = await import('pg');
  return module.Pool ?? module.default?.Pool;
}
