/**
 * How much the agent may do without asking, who reviews risky calls, and what has
 * already been allowed.
 */
import { useCallback, useEffect, useState } from 'react';
import { fetchApprovals, forgetPermission, setAutoReview } from '../../../api.js';
import { Icon } from '../../icon.js';
import { Dropdown, type DropdownItem } from '../../selection/dropdown.js';
import type { ApprovalMode, ApprovalsInfo } from '../../../types.js';
import { SettingsGroup, SettingsPage, SettingsRow, SettingsSection, SettingsStatus } from '../primitives.js';
import { useSettingsSession } from '../settings-session.js';
import './approvals.css';

const MODES: Array<{ id: ApprovalMode; label: string; detail: string }> = [
  { id: 'workspace', label: 'Workspace', detail: 'Ask before anything that leaves the workspace.' },
  { id: 'auto-review', label: 'Auto-review', detail: 'A second model checks each risky call before it runs.' },
  { id: 'full-access', label: 'Full access', detail: 'Run everything without asking. Nothing is reviewed.' },
];

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function ApprovalsSettings() {
  const { selectApprovalMode } = useSettingsSession();
  const [info, setInfo] = useState<ApprovalsInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<ApprovalMode | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewQuery, setReviewQuery] = useState('');
  const [timeoutDraft, setTimeoutDraft] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const value = await fetchApprovals();
      setInfo(value);
      setTimeoutDraft(value.autoReview.timeoutSeconds === null ? '' : String(value.autoReview.timeoutSeconds));
      setError(null);
    } catch (problem) {
      setError(describe(problem));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const choose = async (mode: ApprovalMode) => {
    if (!info || info.mode === mode) return;
    setSaving(mode);
    setError(null);
    try {
      await selectApprovalMode(mode);
      setInfo({ ...info, mode });
    } catch (problem) {
      setError(describe(problem));
    } finally {
      setSaving(null);
    }
  };

  const chooseReviewer = async (providerId: string | null, modelId: string | null) => {
    if (!info) return;
    setBusy(true);
    setError(null);
    try {
      await setAutoReview({ providerId, modelId });
      await load();
    } catch (problem) {
      setError(describe(problem));
    } finally {
      setBusy(false);
    }
  };

  const saveTimeout = async () => {
    if (!info) return;
    const trimmed = timeoutDraft.trim();
    const value = trimmed === '' ? null : Number(trimmed);
    if (value !== null && (!Number.isFinite(value) || value < 5 || value > 600)) {
      setError('The review timeout must be between 5 and 600 seconds.');
      return;
    }
    if (value === info.autoReview.timeoutSeconds) return;
    setBusy(true);
    setError(null);
    try {
      await setAutoReview({
        providerId: info.autoReview.providerId,
        modelId: info.autoReview.modelId,
        timeoutSeconds: value,
      });
      await load();
    } catch (problem) {
      setError(describe(problem));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      await forgetPermission(id);
      await load();
    } catch (problem) {
      setError(describe(problem));
    } finally {
      setBusy(false);
    }
  };

  const reviewerLabel = info?.autoReview.modelId ? `${info.autoReview.providerId} · ${info.autoReview.modelId}` : 'Conversation model';

  const reviewItems: DropdownItem[] = [
    {
      id: 'conversation',
      label: 'Conversation model',
      description: 'Use whatever answers the chat',
      selected: !info?.autoReview.modelId,
      onSelect: () => {
        setReviewOpen(false);
        void chooseReviewer(null, null);
      },
    },
    ...(info?.models ?? [])
      .filter((model) =>
        `${model.providerId} ${model.modelId} ${model.name}`.toLocaleLowerCase('en').includes(reviewQuery.trim().toLocaleLowerCase('en')),
      )
      .map((model) => ({
        id: `${model.providerId}/${model.modelId}`,
        label: model.name,
        description: `${model.providerId} · ${model.modelId}`,
        selected: info?.autoReview.providerId === model.providerId && info?.autoReview.modelId === model.modelId,
        onSelect: () => {
          setReviewOpen(false);
          void chooseReviewer(model.providerId, model.modelId);
        },
      })),
  ];

  return (
    <SettingsPage title="Approvals" description="What the agent may do on its own.">
      {error ? <SettingsStatus tone="error">{error}</SettingsStatus> : null}
      {info ? (
        <>
          <SettingsSection title="Mode">
            <div className="settings-group">
              {MODES.map((entry) => (
                <SettingsRow key={entry.id} label={entry.label} description={entry.detail}>
                  <button
                    type="button"
                    className={`settings-choice${info.mode === entry.id ? ' is-active' : ''}`}
                    aria-pressed={info.mode === entry.id}
                    disabled={info.mode === entry.id || saving !== null}
                    onClick={() => void choose(entry.id)}
                  >
                    {info.mode === entry.id ? 'Selected' : 'Use'}
                  </button>
                </SettingsRow>
              ))}
            </div>
          </SettingsSection>

          <SettingsSection
            title="Reviewer"
            description="Used in Auto-review: this model decides whether a risky call may run. A call it cannot judge goes to you."
          >
            <SettingsGroup>
              <SettingsRow label="Reviewer model" description={reviewerLabel}>
                <Dropdown
                  open={reviewOpen}
                  onOpenChange={(next) => {
                    setReviewOpen(next);
                    if (next) setReviewQuery('');
                  }}
                  items={reviewItems}
                  ariaLabel="Choose the reviewer model"
                  placement="bottom"
                  align="end"
                  itemSelectionMode="single"
                  search={{
                    value: reviewQuery,
                    onChange: setReviewQuery,
                    placeholder: 'Search models',
                    ariaLabel: 'Search models',
                  }}
                  renderTrigger={({ ref, open, toggle }) => (
                    <button ref={ref} type="button" className="settings-picker" aria-expanded={open} onClick={toggle}>
                      <span className="settings-picker__value">{info.autoReview.modelId ?? 'Conversation model'}</span>
                      <Icon name="chevron-down" size={12} />
                    </button>
                  )}
                />
              </SettingsRow>
              <SettingsRow label="Review timeout" description="Seconds to wait for the reviewer before asking you. Empty uses the default.">
                <input
                  className="approvals-timeout"
                  type="number"
                  min={5}
                  max={600}
                  aria-label="Review timeout in seconds"
                  placeholder="Default"
                  value={timeoutDraft}
                  disabled={busy}
                  onChange={(event) => setTimeoutDraft(event.target.value)}
                  onBlur={() => void saveTimeout()}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      void saveTimeout();
                    }
                  }}
                />
              </SettingsRow>
            </SettingsGroup>
          </SettingsSection>

          <SettingsSection title="Remembered" description="Calls you allowed once and kept. Each one is an exact command, path or URL.">
            {info.permissions.length === 0 ? (
              <SettingsStatus>Nothing is remembered yet.</SettingsStatus>
            ) : (
              <SettingsGroup>
                {info.permissions.map((permission) => (
                  <SettingsRow
                    key={permission.id}
                    label={permission.label}
                    description={permission.at > 0 ? new Date(permission.at).toLocaleString() : 'Kept before labels were recorded'}
                  >
                    <button type="button" className="settings-choice" disabled={busy} onClick={() => void revoke(permission.id)}>
                      Revoke
                    </button>
                  </SettingsRow>
                ))}
              </SettingsGroup>
            )}
          </SettingsSection>
        </>
      ) : null}
    </SettingsPage>
  );
}
