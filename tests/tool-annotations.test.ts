import { describe, it, expect, beforeAll } from 'vitest';
import { OneHomeClient } from '../src/client.js';
import { TOOL_REGISTRARS } from '../src/tools/register-all.js';
import { FakeTransport, createTestHarness } from './helpers.js';

/**
 * Fleet annotation meta-test, read off the REGISTERED surface (tools/list),
 * never a hand-kept list. `destructiveHint` defaults to TRUE whenever
 * `readOnlyHint` is false, so a write that forgets to declare it publishes
 * as destructive and nothing else fails; and a missing `openWorldHint`
 * defaults to true, which is wrong for the process-local tools.
 */
interface Ann {
  readOnlyHint?: unknown;
  destructiveHint?: unknown;
  openWorldHint?: unknown;
}

let tools: { name: string; annotations?: Ann }[] = [];

beforeAll(async () => {
  const client = new OneHomeClient({ transport: new FakeTransport() });
  const h = await createTestHarness(async (server) => {
    for (const register of TOOL_REGISTRARS) await register(server, client);
  });
  // h.listTools() trims to name/description; the raw client keeps annotations.
  tools = (await h.client.listTools()).tools as typeof tools;
  await h.close();
});

const names = (pred: (a: Ann) => boolean) =>
  tools.filter((t) => pred(t.annotations ?? {})).map((t) => t.name).sort();

describe('tool annotations', () => {
  it('covers the full surface (guards against a registrar being dropped)', () => {
    expect(tools).toHaveLength(21);
  });

  it('sets an explicit boolean readOnlyHint on every tool', () => {
    expect(names((a) => typeof a.readOnlyHint !== 'boolean')).toEqual([]);
  });

  it('sets an explicit boolean destructiveHint on every write', () => {
    expect(
      names((a) => a.readOnlyHint === false && typeof a.destructiveHint !== 'boolean'),
    ).toEqual([]);
  });

  it('never lets a read claim to be destructive', () => {
    expect(names((a) => a.readOnlyHint === true && a.destructiveHint === true)).toEqual([]);
  });

  it('sets an explicit boolean openWorldHint on every tool', () => {
    expect(names((a) => typeof a.openWorldHint !== 'boolean')).toEqual([]);
  });

  it('classifies the two session writes by the inverse test', () => {
    // onehome_set_active_session only moves the process-local active pointer,
    // and calling it again with the previous session_id restores it.
    // onehome_set_auth ADDS a session to the registry and nothing in this tool
    // set removes one; the extra session changes `~MLS` routing (and can make
    // a two-shares-in-one-MLS request error), so it stays destructive.
    expect(names((a) => a.readOnlyHint === false)).toEqual([
      'onehome_set_active_session',
      'onehome_set_auth',
    ]);
    expect(names((a) => a.readOnlyHint === false && a.destructiveHint === true)).toEqual([
      'onehome_set_auth',
    ]);
  });

  it('marks only the process-local tools closed-world', () => {
    expect(names((a) => a.openWorldHint === false)).toEqual([
      'onehome_calculate_affordability',
      'onehome_calculate_mortgage',
      'onehome_get_session_context',
      'onehome_set_active_session',
    ]);
  });
});
