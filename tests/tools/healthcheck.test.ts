import { describe, it, expect, afterEach } from 'vitest';
import { OneHomeClient } from '../../src/client.js';
import { registerHealthcheckTools } from '../../src/tools/healthcheck.js';
import { FakeTransport, createTestHarness } from '../helpers.js';

let harness: Awaited<ReturnType<typeof createTestHarness>> | undefined;
afterEach(async () => {
  if (harness) {
    await harness.close();
    harness = undefined;
  }
});

describe('onehome_healthcheck — capture-mode hint', () => {
  it('names ContextMint Bridge (not the old fetchproxy extension) when capture fails', async () => {
    const t = new FakeTransport();
    t.setStatus({ authMode: 'fetchproxy_capture', authReady: false });
    t.on('GetOneHomeUser', () => {
      throw new Error('no Authorization header captured yet');
    });
    const client = new OneHomeClient({ transport: t });
    harness = await createTestHarness((server) =>
      registerHealthcheckTools(server, client)
    );
    const r = await harness.callTool('onehome_healthcheck', {});
    const first = r.content[0]!;
    if (first.type !== 'text') throw new Error('expected text');
    const body = JSON.parse(first.text) as { ok: boolean; hint: string };
    expect(body.ok).toBe(false);
    expect(body.hint).toContain(
      'make sure the ContextMint Bridge browser extension is installed and paired'
    );
    expect(body.hint).not.toMatch(/fetchproxy browser extension|Transporter/);
  });
});
