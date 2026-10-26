/**
 * Adding a provider, from the catalog or by hand.
 *
 * A custom provider is not a special case in the settings file: it is an entry
 * with the AI SDK package (npm) that speaks it and the base URL of its API. The
 * key goes straight into the secret store through the server and is never sent
 * back, so nothing here can display or re-read it after saving.
 */
import { useEffect, useState } from 'react';
import { addProvider, fetchProviderCatalog } from '../../../api.js';
import { Dialog } from '../../dialog.js';
import { Icon } from '../../icon.js';
import { Feedback } from '../../feedback.js';
import { IconButton } from '../../ui.js';
import type { ModelCatalogRow, ProviderCatalogRow } from '../../../types.js';
import './models.css';

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type Mode = 'catalog' | 'custom';

export function AddProviderDialog({
  onClose,
  onAdded,
}: {
  onClose: () => void;
  onAdded: (rows: ModelCatalogRow[], providerId: string) => void;
}) {
  const [mode, setMode] = useState<Mode>('catalog');
  const [providers, setProviders] = useState<ProviderCatalogRow[] | null>(null);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [customId, setCustomId] = useState('');
  const [npm, setNpm] = useState('');
  const [url, setUrl] = useState('');
  const [firstModel, setFirstModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const rows = await fetchProviderCatalog();
        if (live) setProviders(rows.filter((row) => !row.configured));
      } catch (cause) {
        if (live) setError(describe(cause));
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  const matches = (providers ?? []).filter((row) => row.providerId.toLocaleLowerCase('en').includes(query.trim().toLocaleLowerCase('en')));

  const canSubmit = !pending && (mode === 'catalog' ? Boolean(selected) : Boolean(customId.trim() && npm.trim() && url.trim()));

  const submit = async () => {
    if (!canSubmit) return;
    setPending(true);
    setError(null);
    try {
      const rows =
        mode === 'catalog'
          ? await addProvider(selected!, { apiKey })
          : await addProvider(customId.trim(), {
              ...(apiKey.trim() ? { apiKey } : {}),
              npm: npm.trim(),
              url: url.trim(),
              ...(firstModel.trim() ? { model: firstModel.trim() } : {}),
            });
      onAdded(rows, mode === 'catalog' ? selected! : customId.trim());
      onClose();
    } catch (cause) {
      setError(describe(cause));
      setPending(false);
    }
  };

  return (
    <Dialog label="Add provider" onClose={onClose} className="add-provider">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <header className="add-provider__header">
          <h1>Add provider</h1>
          <IconButton icon="x" label="Close" onClick={onClose} disabled={pending} />
        </header>

        <div className="add-provider__modes" role="tablist" aria-label="Provider source">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'catalog'}
            className={mode === 'catalog' ? 'is-active' : undefined}
            onClick={() => setMode('catalog')}
          >
            From catalog
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'custom'}
            className={mode === 'custom' ? 'is-active' : undefined}
            onClick={() => setMode('custom')}
          >
            Custom
          </button>
        </div>

        {mode === 'catalog' ? (
          <>
            <input
              autoFocus
              data-dialog-autofocus
              className="add-provider__search"
              aria-label="Search providers"
              placeholder="Search providers"
              value={query}
              disabled={pending}
              onChange={(event) => setQuery(event.target.value)}
            />
            <div className="add-provider__list" role="listbox" aria-label="Providers">
              {providers === null && !error ? (
                <Feedback layout="state" tone="loading">
                  Loading providers…
                </Feedback>
              ) : null}
              {providers !== null && matches.length === 0 ? (
                <Feedback layout="state" title="No providers found">
                  Try a different search.
                </Feedback>
              ) : null}
              {matches.map((row) => (
                <button
                  key={row.providerId}
                  type="button"
                  role="option"
                  aria-selected={selected === row.providerId}
                  className={`add-provider__item${selected === row.providerId ? ' is-selected' : ''}`}
                  disabled={pending}
                  onClick={() => setSelected(row.providerId)}
                >
                  <span className="add-provider__name">{row.providerId}</span>
                  <span className="add-provider__meta">{row.modelCount} models</span>
                  {selected === row.providerId ? <Icon name="check" size={14} /> : null}
                </button>
              ))}
            </div>
          </>
        ) : (
          <div className="add-provider__fields">
            <label>
              <span>Provider id</span>
              <input
                autoFocus
                data-dialog-autofocus
                aria-label="Provider id"
                placeholder="my-endpoint"
                value={customId}
                disabled={pending}
                onChange={(event) => setCustomId(event.target.value)}
              />
            </label>
            <label>
              <span>AI SDK package (npm)</span>
              <input
                aria-label="AI SDK package"
                placeholder="@ai-sdk/openai-compatible"
                value={npm}
                disabled={pending}
                onChange={(event) => setNpm(event.target.value)}
              />
            </label>
            <label>
              <span>Base URL</span>
              <input
                aria-label="Base URL"
                placeholder="http://127.0.0.1:8080/v1"
                value={url}
                disabled={pending}
                onChange={(event) => setUrl(event.target.value)}
              />
            </label>
            <label>
              <span>First model id</span>
              <input
                aria-label="First model id"
                placeholder="qwen3-coder"
                value={firstModel}
                disabled={pending}
                onChange={(event) => setFirstModel(event.target.value)}
              />
            </label>
          </div>
        )}

        <label className="add-provider__key">
          <span>API key {mode === 'custom' ? '(optional)' : ''}</span>
          <input
            type="password"
            aria-label="API key"
            placeholder={mode === 'catalog' && !selected ? 'Choose a provider first' : 'Paste the key'}
            value={apiKey}
            disabled={pending || (mode === 'catalog' && !selected)}
            onChange={(event) => setApiKey(event.target.value)}
          />
        </label>

        {error ? <Feedback tone="error">{error}</Feedback> : null}

        <footer className="add-provider__footer">
          <button type="button" className="add-provider__cancel" onClick={onClose} disabled={pending}>
            Cancel
          </button>
          <button type="submit" className="add-provider__save" disabled={!canSubmit}>
            {pending ? 'Saving…' : 'Save provider'}
          </button>
        </footer>
      </form>
    </Dialog>
  );
}
