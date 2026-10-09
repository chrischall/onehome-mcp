// Claude Code reads a plugin's MCP config from `mcpServers`; a key named `mcp`
// is ignored (`claude plugin validate` reports "Unknown field 'mcp'"). It only
// worked here because ./.mcp.json is also the default location.
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const pluginUrl = new URL('../.claude-plugin/plugin.json', import.meta.url);
const plugin = JSON.parse(readFileSync(pluginUrl, 'utf8')) as Record<string, unknown>;

describe('.claude-plugin/plugin.json', () => {
  it('declares its MCP config under mcpServers, not the ignored mcp key', () => {
    expect(plugin).not.toHaveProperty('mcp');
    expect(plugin.mcpServers).toBe('./.mcp.json');
  });

  it('points mcpServers at a file that exists', () => {
    const target = fileURLToPath(new URL(`../${plugin.mcpServers as string}`, import.meta.url));
    expect(existsSync(target)).toBe(true);
  });
});
