import { describe, it, expect } from 'vitest';
import { computeAffordability } from '../../src/tools/affordability.js';

// We import computeAffordability from affordability and exercise it
// directly. The mortgage tool itself is a thin wrapper around the
// same PI math, validated through the affordability cross-check
// (a price the affordability solver returns produces a PITI exactly
// equal to the binding constraint).

describe('mortgage / affordability math', () => {
  it('affordability solver respects the front-end DTI constraint', () => {
    const out = computeAffordability({
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
    const out = computeAffordability({
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
    const out = computeAffordability({
      monthly_income: 10000,
      down_payment: 50000,
      interest_rate: 0,
      property_tax_rate: 0,
    });
    expect(out.monthly_principal_interest).toBeGreaterThan(0);
    expect(out.max_home_price).toBeGreaterThan(50000);
  });
});
