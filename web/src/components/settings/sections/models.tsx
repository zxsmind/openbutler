/**
 * Which models the composer offers.
 *
 * One provider at a time, chosen from a searchable list, then its models from a
 * searchable multi-select. A catalog holds hundreds of models per provider, so
 * the screen never renders the whole catalog at once: it renders the list the
 * owner asked for. Nothing is active by default — an empty set means the
 * composer has nothing to offer until the owner chooses.
 */
import { useCallback, useEffect, useState } from 'react';
import { fetchModelCatalog, setModelActive } from '../../../api.js';
import { Icon } from '../../icon.js';
import { Dropdown, type DropdownItem } from '../../selection/dropdown.js';
import type { ModelCatalogRow } from '../../../types.js';
import { SettingsGroup, SettingsPage, SettingsRow, SettingsSection, SettingsStatus } from '../primitives.js';
import { useSettingsSession } from '../settings-session.js';
import './models.css';

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function ModelsSettings() {
  const { runtime } = useSettingsSession();
  const [rows, setRows] = useState<ModelCatalogRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [providerId, setProviderId] = useState<string | null>(null);
  const [providerOpen, setProviderOpen] = useState(false);
  const [providerQuery, setProviderQuery] = useState('');
  const [modelsOpen, setModelsOpen] = useState(false);
  const [modelQuery, setModelQuery] = useState('');
  const [pending, setPending] = useState(false);
  const [newModel, setNewModel] = useState('');

  const load = useCallback(async () => {
    try {
      const next = await fetchModelCatalog();
      setRows(next);
      setError(null);
      setProviderId((current) => current ?? runtime?.providerId ?? next[0]?.providerId ?? null);
    } catch (cause) {
      setError(describe(cause));
    }
  }, [runtime?.providerId]);

  useEffect(() => {
    void load();
  }, [load]);

  const provider = rows?.find((row) => row.providerId === providerId) ?? rows?.[0];
  const activeCount = provider?.models.filter((model) => model.active).length ?? 0;

  const toggle = async (modelId: string, active: boolean) => {
    if (!provider) return;
    setPending(true);
    try {
      setRows(await setModelActive(provider.providerId, modelId, active));
      setError(null);
    } catch (cause) {
      setError(describe(cause));
    } finally {
      setPending(false);
    }
  };

  const providerItems: DropdownItem[] = (rows ?? [])
    .filter((row) => row.providerId.toLocaleLowerCase('en').includes(providerQuery.trim().toLocaleLowerCase('en')))
    .map((row) => {
      const active = row.models.filter((model) => model.active).length;
      return {
        id: row.providerId,
        label: row.providerId,
        description: `${active} of ${row.models.length} active`,
        selected: row.providerId === provider?.providerId,
        onSelect: () => {
          setProviderId(row.providerId);
          setProviderOpen(false);
        },
      };
    });

  const modelItems: DropdownItem[] = (provider?.models ?? [])
    .filter((model) => `${model.name} ${model.modelId}`.toLocaleLowerCase('en').includes(modelQuery.trim().toLocaleLowerCase('en')))
    .map((model) => ({
      id: model.modelId,
      label: model.name,
      selected: model.active,
      trailing: model.active ? <Icon name="check" size={14} /> : undefined,
      onSelect: () => {
        void toggle(model.modelId, !model.active);
      },
    }));

  return (
    <SettingsPage title="Models">
      <SettingsSection title="Composer" description="Only active models are offered in the composer's selector.">
        {error ? <SettingsStatus>{error}</SettingsStatus> : null}
        {rows === null && !error ? <SettingsStatus>Loading models…</SettingsStatus> : null}
        {rows !== null && rows.length === 0 ? <SettingsStatus>No provider is configured yet. Run `ranite setup`.</SettingsStatus> : null}
        {rows !== null && rows.length > 0 ? (
          <SettingsGroup>
            <SettingsRow label="Provider" description="Configured providers only.">
              <Dropdown
                open={providerOpen}
                onOpenChange={(next) => {
                  setProviderOpen(next);
                  if (next) setProviderQuery('');
                }}
                items={providerItems}
                ariaLabel="Choose provider"
                placement="bottom"
                align="end"
                itemSelectionMode="single"
                search={{
                  value: providerQuery,
                  onChange: setProviderQuery,
                  placeholder: 'Search providers',
                  ariaLabel: 'Search providers',
                }}
                renderTrigger={({ ref, open, toggle: onToggle }) => (
                  <button ref={ref} type="button" className="settings-picker" aria-expanded={open} onClick={onToggle}>
                    <span className="settings-picker__value">{provider?.providerId ?? 'Choose provider'}</span>
                    <Icon name="chevron-down" size={12} />
                  </button>
                )}
              />
            </SettingsRow>

            <SettingsRow
              label="Models"
              description={activeCount === 0 ? 'Nothing active: the composer has no model to offer.' : `${activeCount} active`}
            >
              <Dropdown
                open={modelsOpen}
                onOpenChange={(next) => {
                  setModelsOpen(next);
                  if (next) setModelQuery('');
                }}
                items={modelItems}
                ariaLabel="Choose active models"
                placement="bottom"
                align="end"
                itemSelectionMode="single"
                closeOnSelect={false}
                search={{ value: modelQuery, onChange: setModelQuery, placeholder: 'Search models', ariaLabel: 'Search models' }}
                footer={
                  <div className="settings-picker__add">
                    <input
                      aria-label="Add a model id"
                      placeholder="Add a model id"
                      value={newModel}
                      disabled={pending}
                      onChange={(event) => setNewModel(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key !== 'Enter') return;
                        event.preventDefault();
                        const modelId = newModel.trim();
                        if (!modelId) return;
                        setNewModel('');
                        void toggle(modelId, true);
                      }}
                    />
                    <button
                      type="button"
                      disabled={pending || !newModel.trim()}
                      onClick={() => {
                        const modelId = newModel.trim();
                        if (!modelId) return;
                        setNewModel('');
                        void toggle(modelId, true);
                      }}
                    >
                      Add
                    </button>
                  </div>
                }
                renderTrigger={({ ref, open, toggle: onToggle }) => (
                  <button ref={ref} type="button" className="settings-picker" aria-expanded={open} disabled={pending} onClick={onToggle}>
                    <span className="settings-picker__value">
                      {activeCount} of {provider?.models.length ?? 0} active
                    </span>
                    <Icon name="chevron-down" size={12} />
                  </button>
                )}
              />
            </SettingsRow>
          </SettingsGroup>
        ) : null}
      </SettingsSection>

      <SettingsSection
        title="Active models"
        description={
          activeCount === 0
            ? 'Nothing is active: the composer has no model to offer until one is chosen above.'
            : 'These are offered in the composer. The one picked there answers, and the last pick becomes the default for new chats.'
        }
      >
        {activeCount > 0 ? (
          <ul className="models-chips">
            {(provider?.models ?? [])
              .filter((model) => model.active)
              .map((model) => (
                <li key={model.modelId} className="models-chip">
                  <span className="models-chip__name">{model.name}</span>
                  <button
                    type="button"
                    className="models-chip__remove"
                    aria-label={`Remove ${model.name} from the composer`}
                    disabled={pending}
                    onClick={() => void toggle(model.modelId, false)}
                  >
                    <Icon name="x" size={12} />
                  </button>
                </li>
              ))}
          </ul>
        ) : (
          <SettingsStatus>No active model for {provider?.providerId ?? 'this provider'}.</SettingsStatus>
        )}
      </SettingsSection>
    </SettingsPage>
  );
}
