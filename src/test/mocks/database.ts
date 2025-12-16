import type { QueryResult, QueryResultRow } from 'pg';
import { mock, type Mock } from 'bun:test';

export interface MockPool {
  query: Mock<(...args: unknown[]) => Promise<QueryResult<QueryResultRow>>>;
}

export const createMockPool = (): MockPool => ({
  query: mock(() => Promise.resolve(createQueryResult([]))),
});

export const mockPool = createMockPool();

export const resetMockPool = (): void => {
  mockPool.query.mockReset();
};

// Helper to create mock query results
export const createQueryResult = <T extends QueryResultRow>(
  rows: T[],
  rowCount?: number
): QueryResult<T> => ({
  rows,
  rowCount: rowCount ?? rows.length,
  command: 'SELECT',
  oid: 0,
  fields: [],
});
