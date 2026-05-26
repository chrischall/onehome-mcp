import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { textResult } from '../mcp.js';

/**
 * Local-only affordability calculator. Solves for max home price under
 * the standard 28/36 DTI rule. Same math used by zillow-mcp /
 * redfin-mcp / compass-mcp / homes-mcp.
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

export function computeAffordability(input: {
  monthly_income: number;
  monthly_debts?: number;
  down_payment: number;
  interest_rate: number;
  loan_term_years?: number;
  property_tax_rate?: number;
  insurance_annual?: number;
  hoa_monthly?: number;
  front_end_dti?: number;
  back_end_dti?: number;
}): {
  max_home_price: number;
  max_monthly_piti: number;
  binding_constraint: 'front_end' | 'back_end';
  monthly_principal_interest: number;
  monthly_property_tax: number;
  monthly_insurance: number;
  monthly_hoa: number;
  loan_amount: number;
  down_payment: number;
  front_end_dti_used: number;
  back_end_dti_used: number;
} {
  const term = input.loan_term_years ?? 30;
  const feDti = input.front_end_dti ?? 0.28;
  const beDti = input.back_end_dti ?? 0.36;
  const taxRate = (input.property_tax_rate ?? 1.1) / 100;
  const insurance = (input.insurance_annual ?? 0) / 12;
  const hoa = input.hoa_monthly ?? 0;
  const debts = input.monthly_debts ?? 0;

  const feMaxPiti = input.monthly_income * feDti;
  const beMaxPiti = Math.max(0, input.monthly_income * beDti - debts);
  const maxPiti = Math.min(feMaxPiti, beMaxPiti);
  const binding: 'front_end' | 'back_end' =
    feMaxPiti <= beMaxPiti ? 'front_end' : 'back_end';

  const r = input.interest_rate / 100 / 12;
  const n = term * 12;
  const piFactor = r > 0 ? r / (1 - Math.pow(1 + r, -n)) : 1 / n;
  const taxPerMonth = (loan: number) =>
    ((loan + input.down_payment) * taxRate) / 12;
  const denom = piFactor + taxRate / 12;
  const loan =
    (maxPiti - (input.down_payment * taxRate) / 12 - insurance - hoa) / denom;
  const loanClamped = Math.max(0, loan);
  const price = loanClamped + input.down_payment;
  const pi = monthlyPI(loanClamped, input.interest_rate, term);
  const tax = taxPerMonth(loanClamped);

  return {
    max_home_price: round(price),
    max_monthly_piti: round(maxPiti),
    binding_constraint: binding,
    monthly_principal_interest: round(pi),
    monthly_property_tax: round(tax),
    monthly_insurance: round(insurance),
    monthly_hoa: hoa,
    loan_amount: round(loanClamped),
    down_payment: input.down_payment,
    front_end_dti_used: feDti,
    back_end_dti_used: beDti,
  };
}

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
    async (i) => textResult(computeAffordability(i))
  );
}
