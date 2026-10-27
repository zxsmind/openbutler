import { useCallback, useEffect, useState } from 'react';
import { fetchProviderCatalog, removeProvider } from '../../../api.js';
import { Icon } from '../../icon.js';
import type { ProviderCatalogRow } from '../../../types.js';
import { SettingsGroup, SettingsPage, SettingsRow, SettingsSection, SettingsStatus } from '../primitives.js';
import { AddProviderDialog } from './add-provider-dialog.js';
import { useSettingsSession } from '../settings-session.js';
import './management.css';

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function ProvidersSettings() {
  const { modelsRevision } = useSettingsSession();
  const [rows, setRows] = useState<ProviderCatalogRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState('');
  const [removing, setRemoving] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setRows(await fetchProviderCatalog());
      setError(null);
    } catch (cause) {
      setError(describe(cause));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, modelsRevision]);
  const configured = (rows ?? []).filter((row) => row.configured);
  const filtered = configured.filter((row) => row.providerId.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));

  const remove = async (providerId: string) => {
    setRemoving(providerId);
    setError(null);
    try {
      await removeProvider(providerId);
      setConfirming(null);
      await load();
    } catch (cause) {
      setError(describe(cause));
    } finally {
      setRemoving(null);
    }
  };

  return (
    <SettingsPage title="Providers" description="Configure API providers and their credentials. Available models are managed separately.">
      {error ? <SettingsStatus tone="error">{error}</SettingsStatus> : null}
      <SettingsSection
        title="Connected providers"
        description="Services configured on this machine."
        action={
          <button type="button" className="settings-add" onClick={() => setAdding(true)}>
            <Icon name="plus" size={13} /> Add provider
          </button>
        }
      >
        {configured.length > 5 ? (
          <label className="settings-list-search">
            <Icon name="search" size={14} />
            <input
              aria-label="Filter providers"
              placeholder="Search providers"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
        ) : null}
        {rows === null && !error ? <SettingsStatus>Loading providers…</SettingsStatus> : null}
        {rows !== null && configured.length === 0 ? (
          <SettingsStatus>No providers configured. Select Add provider to connect an API.</SettingsStatus>
        ) : null}
        {configured.length > 0 && filtered.length === 0 ? <SettingsStatus>No providers match your search.</SettingsStatus> : null}
        {filtered.length > 0 ? (
          <SettingsGroup>
            {filtered.map((row) => (
              <SettingsRow
                key={row.providerId}
                label={row.providerId}
                description={row.custom ? 'Custom API endpoint' : `${row.modelCount} models in catalog`}
              >
                <span className="settings-value settings-value--muted">{row.activeModels} active</span>
                {confirming === row.providerId ? (
                  <>
                    <button type="button" className="settings-choice" disabled={removing !== null} onClick={() => setConfirming(null)}>
                      Cancel
                    </button>
                    <button
                      type="button"
                      className="settings-choice settings-choice--danger"
                      disabled={removing !== null}
                      onClick={() => void remove(row.providerId)}
                    >
                      {removing === row.providerId ? 'Removing…' : 'Confirm removal'}
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="settings-choice"
                    disabled={removing !== null}
                    onClick={() => setConfirming(row.providerId)}
                  >
                    Remove
                  </button>
                )}
              </SettingsRow>
            ))}
          </SettingsGroup>
        ) : null}
      </SettingsSection>
      {adding ? (
        <AddProviderDialog
          onClose={() => setAdding(false)}
          onAdded={() => {
            void load();
          }}
        />
      ) : null}
    </SettingsPage>
  );
}
