// fleet-audit#618: the .mcpb manifest must let a Claude Desktop user supply
// their OneHome credential (instead of pasting it into chat) and must list
// every tool the server actually registers.
import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { OneHomeClient } from '../src/client.js';
import { TOOL_REGISTRARS } from '../src/tools/register-all.js';
import { FakeTransport, createTestHarness } from './helpers.js';

interface UserConfigEntry {
  type: string;
  required?: boolean;
  sensitive?: boolean;
}
interface Manifest {
  user_config?: Record<string, UserConfigEntry>;
  server: { mcp_config: { env?: Record<string, string> } };
  tools: Array<{ name: string; description: string }>;
}

const manifest = JSON.parse(
  readFileSync(new URL('../manifest.json', import.meta.url), 'utf8')
) as Manifest;

let harness: Awaited<ReturnType<typeof createTestHarness>> | undefined;
afterAll(async () => {
  if (harness) await harness.close();
});

describe('manifest.json', () => {
  it('offers optional, sensitive magic-link and token fields', () => {
    for (const key of ['onehome_magic_link', 'onehome_token']) {
      const entry = manifest.user_config?.[key];
      expect(entry, key).toBeDefined();
      expect(entry?.type).toBe('string');
      expect(entry?.required).toBe(false);
      expect(entry?.sensitive).toBe(true);
    }
  });

  it('maps them into the server env', () => {
    expect(manifest.server.mcp_config.env).toMatchObject({
      ONEHOME_MAGIC_LINK: '${user_config.onehome_magic_link}',
      ONEHOME_TOKEN: '${user_config.onehome_token}',
    });
  });

  it('lists exactly the tools the server registers', async () => {
    const client = new OneHomeClient({ transport: new FakeTransport() });
    harness = await createTestHarness(async (server) => {
      for (const register of TOOL_REGISTRARS) await register(server, client);
    });
    const registered = (await harness.listTools()).map((t) => t.name).sort();
    expect(manifest.tools.map((t) => t.name).sort()).toEqual(registered);
    for (const t of manifest.tools) expect(t.description.length, t.name).toBeGreaterThan(0);
  });
});
