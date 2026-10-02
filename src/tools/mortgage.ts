import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { registerMortgageTool } from '@chrischall/realty-core';
import { minifiedResult } from '../mcp.js';

/**
 * Local-only mortgage / PITI calculator. No network — fully
 * deterministic. The PITI math is hoisted to the canonical
 * `calculateMortgage` in `@chrischall/realty-core` (shared with
 * zillow-mcp / redfin-mcp / compass-mcp / homes-mcp); this tool is a
 * thin adapter that maps the canonical breakdown back to onehome's
 * leaner output shape (`monthly_total_piti` / `total_interest_over_term`
 * and an `ltv` ratio) so the tool surface is unchanged. Kept here so a
 * OneHome-only session can run scenarios without juggling tool surfaces.
 */
export function registerMortgageTools(server: McpServer): void {
  // realty-core's shared registrar (fleet-audit#1090) in the lean shape —
  // the same projection this file used to hand-write — with
  // `loan_term_years` capped at MAX_LOAN_TERM_YEARS.
  registerMortgageTool(server, {
    z,
    prefix: 'onehome',
    shape: 'lean',
    toResult: minifiedResult,
  });
}
