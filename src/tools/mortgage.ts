import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { textResult } from '../mcp.js';

/**
 * Local-only mortgage / PITI calculator. No network — fully
 * deterministic. Same math used by zillow-mcp / redfin-mcp /
 * compass-mcp / homes-mcp; kept here so a OneHome-only session can
 * run scenarios without juggling tool surfaces.
 */

function monthlyPI(loan: number, annualRate: number, years: number): number {
  if (loan <= 0) return 0;
  if (annualRate <= 0) return loan / (years * 12);
  const r = annualRate / 100 / 12;
  const n = years * 12;
  return (loan * r) / (1 - Math.pow(1 + r, -n));
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

export function registerMortgageTools(server: McpServer): void {
  server.registerTool(
    'onehome_calculate_mortgage',
    {
      title: 'Calculate mortgage PITI',
      description:
        'Local-only mortgage payment calculator. Returns a full PITI breakdown (principal + interest, property tax, insurance, HOA, PMI) and total interest over the life of the loan. No network call. Provide either `down_payment` OR `down_payment_percent`; defaults to 20%. Property tax can be given as `property_tax_annual` or `property_tax_rate` (% of home price). PMI applies automatically when LTV > 80% and `pmi_rate` is provided.',
      annotations: {
        title: 'Calculate mortgage PITI',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        home_price: z.number().positive(),
        interest_rate: z.number().nonnegative().describe('Annual %, e.g. 6.5'),
        down_payment: z.number().nonnegative().optional(),
        down_payment_percent: z.number().min(0).max(100).optional(),
        loan_term_years: z.number().int().positive().optional().describe('Default 30'),
        property_tax_annual: z.number().nonnegative().optional(),
        property_tax_rate: z
          .number()
          .nonnegative()
          .optional()
          .describe('Annual % of home price'),
        insurance_annual: z.number().nonnegative().optional(),
        hoa_monthly: z.number().nonnegative().optional(),
        pmi_rate: z
          .number()
          .nonnegative()
          .optional()
          .describe('Annual %, applied when LTV > 80%'),
      },
    },
    async (i) => {
      const term = i.loan_term_years ?? 30;
      const downPmt =
        i.down_payment ?? (i.home_price * (i.down_payment_percent ?? 20)) / 100;
      const loan = Math.max(0, i.home_price - downPmt);
      const pi = monthlyPI(loan, i.interest_rate, term);
      const tax =
        (i.property_tax_annual ??
          (i.home_price * (i.property_tax_rate ?? 0)) / 100) /
        12;
      const ins = (i.insurance_annual ?? 0) / 12;
      const hoa = i.hoa_monthly ?? 0;
      const ltv = i.home_price > 0 ? loan / i.home_price : 0;
      const pmi =
        ltv > 0.8 && i.pmi_rate ? (loan * (i.pmi_rate / 100)) / 12 : 0;
      const total = pi + tax + ins + hoa + pmi;
      const totalInterest = pi * term * 12 - loan;
      return textResult({
        home_price: i.home_price,
        down_payment: downPmt,
        loan_amount: loan,
        ltv,
        monthly_principal_interest: round(pi),
        monthly_property_tax: round(tax),
        monthly_insurance: round(ins),
        monthly_hoa: hoa,
        monthly_pmi: round(pmi),
        monthly_total_piti: round(total),
        total_interest_over_term: round(totalInterest),
        loan_term_years: term,
      });
    }
  );
}
