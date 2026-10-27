import { useCallback, useEffect, useState } from 'react';
import { fetchModelCatalog, setModelActive } from '../../../api.js';
import { Icon } from '../../icon.js';
import type { ModelCatalogRow } from '../../../types.js';
import { SettingsGroup, SettingsPage, SettingsRow, SettingsSection, SettingsStatus } from '../primitives.js';
import { useSettingsSession } from '../settings-session.js';
import { AddModelDialog } from './add-model-dialog.js';
import './management.css';

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Only enabled models belong on the settings page. Catalog discovery is modal. */
export function ModelsSettings() {
  const { runtime, modelsRevision } = useSettingsSession();
  const [rows, setRows] = useState<ModelCatalogRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [providerId, setProviderId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [pending, setPending] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const next = await fetchModelCatalog();
      setRows(next);
      setError(null);
      setProviderId((current) =>
        next.some((row) => row.providerId === current)
          ? current
          : (next.find((row) => row.providerId === runtime?.providerId)?.providerId ?? next[0]?.providerId ?? null),
      );
    } catch (cause) {
      setError(describe(cause));
    }
  }, [runtime?.providerId]);

  useEffect(() => {
    void load();
  }, [load, modelsRevision]);

  const provider = rows?.find((row) => row.providerId === providerId) ?? null;
  const enabled = (provider?.models ?? []).filter((model) => model.active).sort((a, b) => a.name.localeCompare(b.name));

  const disableModel = async (modelId: string) => {
    if (!provider || pending) return;
    setPending(modelId);
    setError(null);
    try {
      setRows(await setModelActive(provider.providerId, modelId, false));
    } catch (cause) {
      setError(describe(cause));
    } finally {
      setPending(null);
    }
  };

  return (
    <SettingsPage title="Models" description="Manage which models appear in the conversation composer.">
      {error ? <SettingsStatus tone="error">{error}</SettingsStatus> : null}
      {rows === null && !error ? <SettingsStatus>Loading models…</SettingsStatus> : null}
      {rows !== null && rows.length === 0 ? <SettingsStatus>Connect a provider before adding models.</SettingsStatus> : null}
      {rows && rows.length > 0 ? (
        <>
          <SettingsSection title="Provider">
            <SettingsGroup>
              <SettingsRow label="Model provider" description="Select the provider to configure.">
                <select
                  className="settings-native-select"
                  aria-label="Model provider"
                  value={provider?.providerId ?? ''}
                  disabled={pending !== null}
                  onChange={(event) => {
                    setProviderId(event.target.value);
                    setError(null);
                  }}
                >
                  {rows.map((row) => (
                    <option key={row.providerId} value={row.providerId}>
                      {row.providerId}
                    </option>
                  ))}
                </select>
              </SettingsRow>
            </SettingsGroup>
          </SettingsSection>
          <SettingsSection
            title="Enabled models"
            description="These models are available in the composer."
            action={
              <button type="button" className="settings-choice" disabled={pending !== null || !provider} onClick={() => setAdding(true)}>
                <Icon name="plus" size={14} /> Add model
              </button>
            }
          >
            <SettingsGroup>
              {enabled.map((model) => (
                <SettingsRow
                  key={model.modelId}
                  label={model.name}
                  description={`${model.modelId}${model.modelId === runtime?.modelId && provider?.providerId === runtime.providerId ? ' · Current model' : ''}`}
                >
                  <button
                    type="button"
                    role="switch"
                    className="settings-toggle is-on"
                    aria-checked={true}
                    aria-label={`Disable ${model.name}`}
                    disabled={pending !== null}
                    onClick={() => void disableModel(model.modelId)}
                  >
                    <span />
                  </button>
                </SettingsRow>
              ))}
              {enabled.length === 0 ? <p className="settings-model-empty">No enabled models. Select Add model to choose one.</p> : null}
            </SettingsGroup>
          </SettingsSection>
          {adding && provider ? (
            <AddModelDialog
              provider={provider}
              onClose={() => setAdding(false)}
              onAdded={(next) => {
                setRows(next);
                setError(null);
              }}
            />
          ) : null}
        </>
      ) : null}
    </SettingsPage>
  );
}
