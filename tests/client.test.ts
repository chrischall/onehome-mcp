import { describe, it, expect } from 'vitest';
import { OneHomeClient, GraphQLResponseError } from '../src/client.js';
import { FakeTransport, ok } from './helpers.js';

describe('OneHomeClient.graphql', () => {
  it('unwraps `data` on a 200 response', async () => {
    const transport = new FakeTransport();
    transport.on('GetOneHomeUser', () => ok({ user: { userId: 'u1' } }));
    const client = new OneHomeClient({ transport });
    const result = await client.graphql<{ user: { userId: string } }>({
      operationName: 'GetOneHomeUser',
      query: '{ user { userId } }',
    });
    expect(result.user.userId).toBe('u1');
  });

  it('throws GraphQLResponseError when `errors` is non-empty', async () => {
    const transport = new FakeTransport();
    transport.on('GetOneHomeUser', () => ({
      data: null,
      errors: [{ message: 'unauthorized' }, { message: 'forbidden' }],
      status: 200,
      url: 'https://services.onehome.com/graphql',
    }));
    const client = new OneHomeClient({ transport });
    await expect(
      client.graphql({
        operationName: 'GetOneHomeUser',
        query: '{ user { userId } }',
      })
    ).rejects.toBeInstanceOf(GraphQLResponseError);
  });

  it('throws a plain Error on HTTP >= 400', async () => {
    const transport = new FakeTransport();
    transport.on('GetOneHomeUser', () => ({
      data: null,
      status: 500,
      url: 'https://services.onehome.com/graphql',
    }));
    const client = new OneHomeClient({ transport });
    await expect(
      client.graphql({
        operationName: 'GetOneHomeUser',
        query: '{ user { userId } }',
      })
    ).rejects.toThrow(/HTTP 500/);
  });

  it('throws when data is missing on a 2xx response', async () => {
    const transport = new FakeTransport();
    transport.on('GetOneHomeUser', () => ({
      status: 200,
      url: 'https://services.onehome.com/graphql',
    }));
    const client = new OneHomeClient({ transport });
    await expect(
      client.graphql({
        operationName: 'GetOneHomeUser',
        query: '{ user { userId } }',
      })
    ).rejects.toThrow(/no `data`/);
  });

  it('graphqlRaw returns the full envelope including errors', async () => {
    const transport = new FakeTransport();
    transport.on('GetOneHomeUser', () => ({
      data: null,
      errors: [{ message: 'oops' }],
      status: 200,
      url: 'https://services.onehome.com/graphql',
    }));
    const client = new OneHomeClient({ transport });
    const env = await client.graphqlRaw({
      operationName: 'GetOneHomeUser',
      query: '{ user { userId } }',
    });
    expect(env.errors).toEqual([{ message: 'oops' }]);
    expect(env.status).toBe(200);
  });
});
