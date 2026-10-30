/**
 * Modal: the GPU the voice stack will run on.
 *
 * The owner pastes a token id and secret; OpenButler verifies them against Modal
 * before storing anything, so a typo never becomes a saved credential. The
 * secret is write-only from this page — it is stored on the machine and never
 * returned to the browser.
 */
import { useCallback, useEffect, useState } from 'react';
import { clearModal, fetchModal, saveModal } from '../../../api.js';
import type { ModalInfo } from '../../../types.js';
import { SettingsGroup, SettingsPage, SettingsRow, SettingsSection, SettingsStatus } from '../primitives.js';
import './models.css';

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function ModalSettings() {
  const [info, setInfo] = useState<ModalInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tokenId, setTokenId] = useState('');
  const [tokenSecret, setTokenSecret] = useState('');
  const [pending, setPending] = useState(false);

  const load = useCallback(async () => {
    try {
      const value = await fetchModal();
      setInfo(value);
      setTokenId(value.tokenId ?? '');
      setError(value.error);
    } catch (cause) {
      setError(describe(cause));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const submit = async () => {
    if (pending || !tokenId.trim() || !tokenSecret.trim()) return;
    setPending(true);
    setError(null);
    try {
      const value = await saveModal(tokenId.trim(), tokenSecret.trim());
      setInfo(value);
      setTokenSecret('');
      setError(null);
    } catch (cause) {
      setError(describe(cause));
    } finally {
      setPending(false);
    }
  };

  const disconnect = async () => {
    setPending(true);
    setError(null);
    try {
      const value = await clearModal();
      setInfo(value);
      setTokenId('');
      setTokenSecret('');
    } catch (cause) {
      setError(describe(cause));
    } finally {
      setPending(false);
    }
  };

  const status = info?.configured
    ? info.verified
      ? `Connected${info.apps === null ? '' : ` · ${info.apps} apps`}`
      : 'Saved, but Modal rejected the token'
    : 'Not connected';

  return (
    <SettingsPage
      title="Modal"
      description="The GPU this machine rents for voice work. Credentials are checked against Modal before they are stored."
    >
      <SettingsSection title="Connection">
        <SettingsGroup>
          <SettingsRow label="Status" description={status}>
            <span className={`settings-tag${info?.verified ? '' : ' settings-tag--muted'}`}>
              {info?.configured ? (info.verified ? 'Verified' : 'Unverified') : 'Empty'}
            </span>
            {info?.configured ? (
              <button type="button" className="settings-choice" disabled={pending} onClick={() => void disconnect()}>
                Disconnect
              </button>
            ) : null}
          </SettingsRow>
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection
        title="Token"
        description="From the Modal dashboard: Settings → API tokens. Both halves are needed; the secret is stored on this machine only."
      >
        <SettingsGroup>
          <SettingsRow label="Token id" description="Starts with ak- for API tokens.">
            <input
              className="settings-input"
              aria-label="Modal token id"
              placeholder="ak-…"
              value={tokenId}
              disabled={pending}
              onChange={(event) => setTokenId(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void submit();
                }
              }}
            />
          </SettingsRow>
          <SettingsRow label="Token secret" description="Write-only: it is never sent back to this page.">
            <input
              className="settings-input"
              type="password"
              aria-label="Modal token secret"
              placeholder={info?.configured ? 'Replace the stored secret' : 'as-…'}
              value={tokenSecret}
              disabled={pending}
              onChange={(event) => setTokenSecret(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void submit();
                }
              }}
            />
          </SettingsRow>
          <SettingsRow label="Save" description="OpenButler calls Modal once to confirm the pair works.">
            <button
              type="button"
              className="settings-choice settings-choice--primary"
              disabled={pending || !tokenId.trim() || !tokenSecret.trim()}
              onClick={() => void submit()}
            >
              {pending ? 'Checking…' : 'Verify and save'}
            </button>
          </SettingsRow>
        </SettingsGroup>
        {error ? <SettingsStatus tone="error">{error}</SettingsStatus> : null}
        {!error && info?.verified ? <SettingsStatus tone="ok">Modal accepted these credentials.</SettingsStatus> : null}
      </SettingsSection>
    </SettingsPage>
  );
}
