import type { SessionPayload } from '../types.js';
import { IconButton } from './ui.js';
function compact(value: number) {
  return value >= 1e6 ? `${(value / 1e6).toFixed(1)}M` : value >= 1e3 ? `${(value / 1e3).toFixed(1)}k` : String(value);
}

export function SessionDetails({ payload, onClose }: { payload: SessionPayload | null; onClose: () => void }) {
  const runtime = payload?.runtime;
  const tokens = payload?.contextTokens;
  const limit = runtime?.contextWindowTokens || 0;
  return (
    <aside className="session-details" aria-label="Session details">
      <div className="details-heading">
        <strong>Session details</strong>
        <IconButton label="Close details" icon="x" onClick={onClose} />
      </div>
      <dl>
        <dt>Model</dt>
        <dd>{runtime?.modelName || runtime?.modelId || '—'}</dd>
        <dt>Provider</dt>
        <dd>{runtime?.providerName || runtime?.providerId || '—'}</dd>
        <dt>Workspace</dt>
        <dd>{runtime?.workspaceRoot || '—'}</dd>
        <dt>Permissions</dt>
        <dd>{runtime?.approvalMode || '—'}</dd>
        <dt>Entries</dt>
        <dd>{payload?.totalEntries ?? 0}</dd>
        <dt>Queued messages</dt>
        <dd>{payload?.queuedMessageCount ?? 0}</dd>
      </dl>
      <div className="context-usage">
        <span>Context usage</span>
        <span>
          {tokens == null ? '—' : compact(tokens)}
          {limit ? ` / ${compact(limit)}` : ''}
        </span>
        <progress max={limit || 1} value={Math.min(tokens ?? 0, limit)} />
      </div>
    </aside>
  );
}
