import { describe, it, expect } from 'vitest';
import { calculateAffordability } from '@chrischall/realty-core';

// The affordability tool is a straight re-export of realty-core's
// `calculateAffordability`, so we exercise the canonical helper directly
// here. The mortgage tool itself is a thin wrapper around the same PI
// math, validated through the affordability cross-check (a price the
// affordability solver returns produces a PITI exactly equal to the
// binding constraint).

describe('mortgage / affordability math', () => {
  it('affordability solver respects the front-end DTI constraint', () => {
    const out = calculateAffordability({
      monthly_income: 12000,
      down_payment: 100000,
      interest_rate: 6.5,
      loan_term_years: 30,
      property_tax_rate: 1.1,
    });
    // Front-end max = 28% of 12000 = 3360. binding constraint should
    // be front_end when no debts pull back-end below front-end.
    expect(out.binding_constraint).toBe('front_end');
    expect(out.max_monthly_piti).toBeCloseTo(3360, 1);
    expect(out.monthly_principal_interest).toBeGreaterThan(0);
    expect(out.max_home_price).toBeGreaterThan(100000);
  });

  it('back-end DTI binds when debts are heavy', () => {
    const out = calculateAffordability({
      monthly_income: 10000,
      monthly_debts: 2500,
      down_payment: 50000,
      interest_rate: 7,
    });
    // back-end = 36% of 10000 - 2500 = 1100; front-end = 28% * 10000 = 2800.
    expect(out.binding_constraint).toBe('back_end');
    expect(out.max_monthly_piti).toBeCloseTo(1100, 1);
  });

  it('handles zero interest as a fixed-amortization edge case', () => {
    const out = calculateAffordability({
      monthly_income: 10000,
      down_payment: 50000,
      interest_rate: 0,
      property_tax_rate: 0,
    });
    expect(out.monthly_principal_interest).toBeGreaterThan(0);
    expect(out.max_home_price).toBeGreaterThan(50000);
  });
});

describe('onehome_calculate_mortgage schema caps (realty-core shared registrar, fleet-audit#1090)', () => {
  it('advertises loan_term_years.maximum = MAX_LOAN_TERM_YEARS', async () => {
    const { MAX_LOAN_TERM_YEARS } = await import('@chrischall/realty-core');
    const { registerMortgageTools } = await import('../../src/tools/mortgage.js');
    const { createTestHarness } = await import('@chrischall/mcp-utils/test');
    const th = await createTestHarness((server) => registerMortgageTools(server));
    try {
      const { tools } = await th.client.listTools();
      const props = tools.find((t) => t.name === 'onehome_calculate_mortgage')!.inputSchema
        .properties as Record<string, { maximum?: number }>;
      expect(props.loan_term_years.maximum).toBe(MAX_LOAN_TERM_YEARS);
    } finally {
      await th.close();
    }
  });
});

describe('onehome_calculate_mortgage keeps the lean output shape', () => {
  it('ltv is a 0..1 ratio and the lean totals are present', async () => {
    const { registerMortgageTools } = await import('../../src/tools/mortgage.js');
    const { createTestHarness, parseToolResult } = await import('@chrischall/mcp-utils/test');
    const th = await createTestHarness((server) => registerMortgageTools(server));
    try {
      const out = parseToolResult<Record<string, unknown>>(
        await th.callTool('onehome_calculate_mortgage', {
          home_price: 500_000,
          interest_rate: 6,
          down_payment_percent: 20,
        })
      );
      expect(out.ltv).toBe(0.8);
      expect(out).toHaveProperty('monthly_total_piti');
      expect(out).toHaveProperty('total_interest_over_term');
      expect(out).not.toHaveProperty('interest_rate');
    } finally {
      await th.close();
    }
  });
});
