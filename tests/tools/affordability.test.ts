import { describe, it, expect } from 'vitest';

describe('onehome_calculate_affordability schema caps (realty-core shared registrar, fleet-audit#1090)', () => {
  it('advertises loan_term_years.maximum = MAX_LOAN_TERM_YEARS', async () => {
    const { MAX_LOAN_TERM_YEARS } = await import('@chrischall/realty-core');
    const { registerAffordabilityTools } = await import('../../src/tools/affordability.js');
    const { createTestHarness } = await import('@chrischall/mcp-utils/test');
    const th = await createTestHarness((server) => registerAffordabilityTools(server));
    try {
      const { tools } = await th.client.listTools();
      const props = tools.find((t) => t.name === 'onehome_calculate_affordability')!.inputSchema
        .properties as Record<string, { maximum?: number }>;
      expect(props.loan_term_years.maximum).toBe(MAX_LOAN_TERM_YEARS);
    } finally {
      await th.close();
    }
  });
});
