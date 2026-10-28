import { useCallback, useEffect, useState } from 'react';
import { listFolders } from '../api.js';
import { Icon } from '../components/icon.js';
import type { FolderListing } from '../types.js';

/**
 * The folder picker lives in the page instead of a native window: the server
 * runs in the background, where Windows refuses to raise another process's
 * dialog above the browser, which is what left "Choosing…" hanging with no
 * window the reader could see.
 */
export function FolderBrowser({ onPick, onBack }: { onPick: (path: string) => void; onBack: () => void }) {
  const [listing, setListing] = useState<FolderListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async (path?: string | null) => {
    setLoading(true);
    setError(null);
    try {
      setListing(await listFolders(path ?? undefined));
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : String(problem));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load(null);
  }, [load]);
  return (
    <div className="folder-browser">
      <div className="folder-browser__bar">
        <button
          type="button"
          className="folder-browser__up"
          disabled={loading || !listing?.parent}
          onClick={() => void load(listing?.parent)}
        >
          <Icon name="arrow-up" size={14} />
          Up
        </button>
        <span className="folder-browser__path" title={listing?.path ?? undefined}>
          {listing?.path ?? 'This computer'}
        </span>
      </div>
      {error ? <p className="folder-browser__error">{error}</p> : null}
      <ul className="folder-browser__list">
        {loading && !listing ? (
          <li className="folder-browser__hint">Loading folders…</li>
        ) : listing && listing.folders.length ? (
          listing.folders.map((folder) => (
            <li key={folder.path}>
              <button type="button" className="folder-browser__row" disabled={loading} onClick={() => void load(folder.path)}>
                <Icon name="folder" size={15} />
                <span>{folder.name}</span>
              </button>
            </li>
          ))
        ) : (
          <li className="folder-browser__hint">No folders here.</li>
        )}
      </ul>
      <div className="folder-browser__actions">
        <button type="button" className="create-project__cancel" onClick={onBack} disabled={loading}>
          Back
        </button>
        <button
          type="button"
          className="create-project__submit"
          disabled={loading || !listing?.path}
          onClick={() => listing?.path && onPick(listing.path)}
        >
          Select this folder
        </button>
      </div>
    </div>
  );
}
