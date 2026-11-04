/**
 * Context-group hints, published on each tool as `_meta.mint` (mcp-host's
 * `mintHintSchema`, the context-groups contract). Inert data: a host that does
 * not read them sees an extra `_meta` key and nothing else. The shape is fixed
 * by the host's contract, so it is restated here rather than imported — this
 * server takes no dependency on mcp-host.
 *
 * `subject` and `when` name THIS tool's own argument names (the host fills
 * them), never values; `aliases` are lowercase, at most 8, each at most 40
 * chars. Every tool here is in the `home` group; `onehome_healthcheck` carries
 * no hint and so joins no group.
 */
import type { McpServer } from '@modelcontextprotocol/server';

export type MintIntent =
  | 'whats-new'
  | 'whats-due'
  | 'whats-on'
  | 'lookup'
  | 'turn-on-off'
  | 'send'
  | 'change'
  | 'other';

export interface MintHint {
  domain: 'home';
  intent: MintIntent;
  canonical?: true;
  subject?: string;
  when?: { start: string; end: string };
  aliases?: string[];
}

/** `_meta` for a OneHome tool. */
export function homeMeta(
  intent: MintIntent,
  extra: Omit<MintHint, 'domain' | 'intent'> = {}
): { mint: MintHint } {
  return { mint: { domain: 'home', intent, ...extra } };
}

/** A read that looks something up (a listing, a search, a calculation). */
export const LOOKUP_META = homeMeta('lookup');

/** What a person says when they ask what is new in their house hunt. */
export const SAVED_SEARCH_ALIASES = [
  'new listings',
  'saved homes',
  'house hunt',
  'homes for sale',
  'listings',
  'real estate',
];

/**
 * The server, with every `registerTool` call through it gaining `_meta`.
 * For the shared registrars in `@chrischall/realty-core` (the mortgage and
 * affordability calculators), which build their own tool config and take no
 * `_meta` option. Any `_meta` the registrar did set is kept beside the hint.
 */
export function withToolMeta(server: McpServer, meta: Record<string, unknown>): McpServer {
  return new Proxy(server, {
    get(target, prop, receiver) {
      if (prop === 'registerTool') {
        return (name: string, config: { _meta?: Record<string, unknown> }, cb: unknown) =>
          (target.registerTool as (...a: unknown[]) => unknown).call(
            target,
            name,
            { ...config, _meta: { ...config._meta, ...meta } },
            cb
          );
      }
      const value: unknown = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}
