export function loadPgPoolConstructor(): Promise<
  new (options: { connectionString: string }) => {
    end?: () => Promise<void>;
    query: <TRow = Record<string, unknown>>(
      text: string,
      values?: unknown[],
    ) => Promise<{ rowCount?: null | number; rows: TRow[] }>;
  }
>;
