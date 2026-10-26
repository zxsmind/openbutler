/**
 * Providers: the endpoints this machine can talk to.
 *
 * Separate from Models on purpose. A provider is a destination plus credentials;
 * a model is something offered in the composer. Adding a provider here does not
 * activate any of its models — that is the Models page's job.
 */
import { useCallback, useEffect, useState } from 'react';
import { fetchProviderCatalog, removeProvider } from '../../../api.js';
import { Icon } from '../../icon.js';
import type { ProviderCatalogRow } from '../../../types.js';
import { SettingsGroup, SettingsPage, SettingsRow, SettingsSection, SettingsStatus } from '../primitives.js';
import { AddProviderDialog } from './add-provider-dialog.js';
import { useSettingsSession } from '../settings-session.js';
import './models.css';

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function ProvidersSettings() {
  const { modelsRevision } = useSettingsSession();
  const [rows, setRows] = useState<ProviderCatalogRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
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
    <SettingsPage
      title="Providers"
      description="Endpoints this machine can call. A provider holds credentials; it does not decide which models are offered."
    >
      {error ? <SettingsStatus tone="error">{error}</SettingsStatus> : null}

      <SettingsSection
        title="Configured"
        description="Everything with a stored key or a custom URL."
        action={
          <button type="button" className="settings-add" onClick={() => setAdding(true)}>
            <Icon name="plus" size={13} />
            Add provider
          </button>
        }
      >
        {rows === null && !error ? <SettingsStatus>Loading providers…</SettingsStatus> : null}
        {rows !== null && configured.length === 0 ? (
          <SettingsStatus>No provider yet. Add one above, or run `ranite setup`.</SettingsStatus>
        ) : null}
        {configured.length > 0 ? (
          <SettingsGroup>
            {configured.map((row) => (
              <SettingsRow
                key={row.providerId}
                label={row.providerId}
                description={
                  row.custom ? 'Custom endpoint · models come from this machine’s settings' : `${row.modelCount} models in the catalog`
                }
              >
                <span className="settings-tag">{row.custom ? 'Custom' : 'Catalog'}</span>
                <span className="settings-value settings-value--muted">{row.activeModels} active</span>
                {confirming === row.providerId ? (
                  <>
                    <button
                      type="button"
                      className="settings-choice settings-choice--danger"
                      disabled={removing !== null}
                      onClick={() => void remove(row.providerId)}
                    >
                      {removing === row.providerId ? 'Removing…' : 'Remove'}
                    </button>
                    <button type="button" className="settings-choice" onClick={() => setConfirming(null)}>
                      Cancel
                    </button>
                  </>
                ) : (
                  <button type="button" className="settings-choice" onClick={() => setConfirming(row.providerId)}>
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
