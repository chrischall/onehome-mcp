import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { registerAffordabilityTool } from '@chrischall/realty-core';
import { minifiedResult } from '../mcp.js';

/**
 * Local-only affordability calculator. Solves for max home price under
 * the standard 28/36 DTI rule. The math is hoisted to the canonical
 * `calculateAffordability` in `@chrischall/realty-core` (shared with
 * zillow-mcp / redfin-mcp / compass-mcp / homes-mcp); the canonical
 * output shape is byte-identical to onehome's previous inline result.
 * No network — pure local math.
 */
export function registerAffordabilityTools(server: McpServer): void {
  // realty-core's shared registrar (fleet-audit#1090): schema (with the
  // MAX_LOAN_TERM_YEARS cap), description and math.
  registerAffordabilityTool(server, {
    z,
    prefix: 'onehome',
    toResult: minifiedResult,
  });
}
