/** Model activation follows the same bounded dialog flow as Add Provider.
 * The full catalog is never rendered inline in the Settings page. */
import { useMemo, useState, type FormEvent } from 'react';
import { setModelActive } from '../../../api.js';
import { Dialog } from '../../dialog.js';
import { Feedback } from '../../feedback.js';
import { Icon } from '../../icon.js';
import { IconButton } from '../../ui.js';
import type { ModelCatalogRow } from '../../../types.js';
import './models.css';

type Source = 'catalog' | 'custom';
const PAGE_SIZE = 60;

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function AddModelDialog({
  provider,
  onAdded,
  onClose,
}: {
  provider: ModelCatalogRow;
  onAdded: (rows: ModelCatalogRow[]) => void;
  onClose: () => void;
}) {
  const [source, setSource] = useState<Source>('catalog');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [customId, setCustomId] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const available = useMemo(() => {
    const search = query.trim().toLocaleLowerCase();
    return provider.models
      .filter((model) => !model.active)
      .filter((model) => !search || `${model.name} ${model.modelId}`.toLocaleLowerCase().includes(search))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [provider.models, query]);
  const candidates = available.slice(0, PAGE_SIZE);
  const targetId = source === 'catalog' ? selected : customId.trim();
  const alreadyActive = provider.models.some((model) => model.modelId === targetId && model.active);
  const canSubmit = !pending && Boolean(targetId) && !alreadyActive;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmit) return;
    setPending(true);
    setError(null);
    try {
      const rows = await setModelActive(provider.providerId, targetId!, true);
      onAdded(rows);
      onClose();
    } catch (cause) {
      setError(describe(cause));
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog label="Add model" className="add-provider add-model" onClose={onClose}>
      <form onSubmit={(event) => void submit(event)}>
        <header className="add-provider__header">
          <h1>Add model</h1>
          <IconButton icon="x" label="Close" onClick={onClose} disabled={pending} />
        </header>
        <p className="add-model__provider">
          Provider: <strong>{provider.providerId}</strong>
        </p>
        <div className="add-provider__modes" role="tablist" aria-label="Model source">
          <button
            type="button"
            role="tab"
            aria-selected={source === 'catalog'}
            className={source === 'catalog' ? 'is-active' : undefined}
            disabled={pending}
            onClick={() => {
              setSource('catalog');
              setError(null);
            }}
          >
            From catalog
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={source === 'custom'}
            className={source === 'custom' ? 'is-active' : undefined}
            disabled={pending}
            onClick={() => {
              setSource('custom');
              setError(null);
            }}
          >
            Custom
          </button>
        </div>
        {source === 'catalog' ? (
          <>
            <input
              data-dialog-autofocus
              type="search"
              className="add-provider__search"
              aria-label="Search models"
              placeholder="Search models"
              value={query}
              disabled={pending}
              onChange={(event) => {
                setQuery(event.target.value);
                setSelected(null);
              }}
            />
            <div className="add-provider__list" role="listbox" aria-label="Available models">
              {candidates.map((model) => (
                <button
                  key={model.modelId}
                  type="button"
                  role="option"
                  aria-selected={selected === model.modelId}
                  className={`add-provider__item${selected === model.modelId ? ' is-selected' : ''}`}
                  disabled={pending}
                  onClick={() => setSelected(model.modelId)}
                >
                  <span className="add-provider__name" title={model.modelId}>
                    {model.name}
                  </span>
                  <span className="add-provider__meta" title={model.modelId}>
                    {model.modelId}
                  </span>
                  {selected === model.modelId ? <Icon name="check" size={14} /> : null}
                </button>
              ))}
              {available.length === 0 ? <Feedback layout="compact">No matching inactive models.</Feedback> : null}
            </div>
            {available.length > PAGE_SIZE ? (
              <p className="add-model__hint">
                Showing {PAGE_SIZE} of {available.length} models. Refine your search to find a specific model.
              </p>
            ) : null}
          </>
        ) : (
          <div className="add-provider__fields">
            <label>
              <span>Model ID</span>
              <input
                data-dialog-autofocus
                aria-label="Custom model ID"
                placeholder="model-id"
                value={customId}
                disabled={pending}
                onChange={(event) => setCustomId(event.target.value)}
              />
            </label>
            {alreadyActive ? <Feedback tone="info">This model is already enabled.</Feedback> : null}
          </div>
        )}
        {error ? <Feedback tone="error">{error}</Feedback> : null}
        <footer className="add-provider__footer">
          <button type="button" className="add-provider__cancel" disabled={pending} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="add-provider__save" disabled={!canSubmit}>
            {pending ? 'Adding…' : 'Add model'}
          </button>
        </footer>
      </form>
    </Dialog>
  );
}
