import { describe, expect, it } from 'vitest';
import type { UsageRow } from '../src/activity-ledger.js';
import type { SettingsStore } from '../src/settings.js';
import { pickMostUsedModel, resolveDefaultModel } from '../src/usage/default-model.js';

function settings(defaultProvider = '', defaultModel = ''): SettingsStore {
  return {
    defaultProvider,
    defaultModel,
    providerOrder: ['vercel', 'ghost'],
    approvalMode: 'workspace',
    schedules: [],
    mcpServers: {},
    providers: {
      vercel: { enabled: true, npm: '@ai-sdk/gateway', url: 'https://gateway.example/v1', keys: ['k'] },
      ghost: { enabled: false, npm: '@ai-sdk/gateway', url: 'https://ghost.example/v1', keys: ['k'] },
    },
  };
}

const row = (providerId: string, modelId: string, atMs: number): UsageRow => ({ providerId, modelId, atMs }) as UsageRow;

const untouchedLedger = {
  usageRows: (): UsageRow[] => {
    throw new Error('usage must not be read when the default is explicit');
  },
};

describe('pickMostUsedModel', () => {
  it('ranks by request count with recency breaking ties', () => {
    const rows = [
      row('vercel', 'mimo', 1_000),
      row('vercel', 'mimo', 2_000),
      row('vercel', 'mimo', 3_000),
      row('vercel', 'flash', 4_000),
      row('vercel', 'flash', 5_000),
      row('vercel', 'flash', 9_000),
    ];
    expect(pickMostUsedModel(settings(), rows)).toEqual({ providerId: 'vercel', modelId: 'flash', requests: 3 });
  });

  it('skips disabled providers and unknown entries', () => {
    const rows = [
      row('ghost', 'dead-model', 9_000),
      row('vercel', 'mimo', 1_000),
      row('ghost', 'dead-model', 8_000),
      row('ghost', 'dead-model', 7_000),
    ];
    expect(pickMostUsedModel(settings(), rows)).toEqual({ providerId: 'vercel', modelId: 'mimo', requests: 1 });
    expect(pickMostUsedModel(settings(), [])).toBeNull();
    expect(pickMostUsedModel(settings('vercel', 'mimo'), [])).toBeNull();
  });
});

describe('resolveDefaultModel', () => {
  it('returns an explicit default without touching usage', () => {
    const choice = resolveDefaultModel(settings('vercel', 'mimo'), untouchedLedger);
    expect(choice).toEqual({ providerId: 'vercel', modelId: 'mimo', source: 'settings' });
  });

  it('falls back to usage when no explicit default exists', () => {
    const ledger = { usageRows: () => [row('vercel', 'mimo', 1_000), row('vercel', 'mimo', 2_000)] };
    expect(resolveDefaultModel(settings(), ledger)).toEqual({
      providerId: 'vercel',
      modelId: 'mimo',
      source: 'usage',
      requests: 2,
    });
  });

  it('stays null when usage offers nothing usable', () => {
    const ledger = { usageRows: () => [row('ghost', 'dead-model', 1_000)] };
    expect(resolveDefaultModel(settings(), ledger)).toBeNull();
  });
});
