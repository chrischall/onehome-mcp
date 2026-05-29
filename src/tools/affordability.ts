import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { calculateAffordability } from '@chrischall/realty-core';
import { textResult } from '../mcp.js';

/**
 * Local-only affordability calculator. Solves for max home price under
 * the standard 28/36 DTI rule. The math is hoisted to the canonical
 * `calculateAffordability` in `@chrischall/realty-core` (shared with
 * zillow-mcp / redfin-mcp / compass-mcp / homes-mcp); the canonical
 * output shape is byte-identical to onehome's previous inline result.
 * No network — pure local math.
 */
export function registerAffordabilityTools(server: McpServer): void {
  server.registerTool(
    'onehome_calculate_affordability',
    {
      title: 'Calculate maximum home price you can afford',
      description:
        'Solve for the maximum home price you can afford under the standard 28/36 DTI rule. Inputs: monthly income, recurring monthly debts (car/student loans), down payment, interest rate, optional property-tax rate / insurance / HOA / loan term. Output: max home price, binding constraint (front-end vs back-end), and the PITI breakdown at that price. Same math as zillow-mcp / redfin-mcp / compass-mcp / homes-mcp. No network — pure local math.',
      annotations: {
        title: 'Calculate maximum home price you can afford',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        monthly_income: z.number().positive(),
        monthly_debts: z.number().nonnegative().optional(),
        down_payment: z.number().nonnegative(),
        interest_rate: z.number().nonnegative(),
        loan_term_years: z.number().int().positive().optional(),
        property_tax_rate: z.number().nonnegative().optional(),
        insurance_annual: z.number().nonnegative().optional(),
        hoa_monthly: z.number().nonnegative().optional(),
        front_end_dti: z.number().min(0).max(1).optional(),
        back_end_dti: z.number().min(0).max(1).optional(),
      },
    },
    async (i) => textResult(calculateAffordability(i))
  );
}
