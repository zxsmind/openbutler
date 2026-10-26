import { useRef, useState } from 'react';
import { Feedback } from './feedback.js';
import { Icon } from './icon.js';
import type { ModelSelectionView } from '../model-selection.js';
import type { ModelChoice } from '../types.js';
import { Dropdown, type DropdownItem } from './selection/dropdown.js';
import { StepSlider } from './selection/step-slider.js';
import './model-selector.css';
import './selection/tokens.css';

export interface ComposerModelSelectorControl {
  projection: ModelSelectionView | null;
  pending: boolean;
  error: string | null;
  onSelectModel: (route: { providerId: string; modelId: string }) => Promise<boolean>;
  onSelectReasoning: (value: string | null) => Promise<boolean>;
  onRetry: () => void;
}

interface Props extends ComposerModelSelectorControl {
  disabled: boolean;
  pendingModel?: ModelChoice | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  resetKey: unknown;
  notice?: string | null;
}

export function ModelSelector({
  projection,
  pending,
  error,
  disabled,
  pendingModel,
  open,
  onOpenChange,
  resetKey,
  onSelectModel,
  onSelectReasoning,
  onRetry,
  notice,
}: Props) {
  const text = { loading: 'Loading model…', retry: 'Try again', missing: 'No model activated' };
  const [page, setPage] = useState<'reasoning' | 'models'>('reasoning');
  const [previewLabel, setPreviewLabel] = useState<string | null>(null);
  const navigationSession = useRef(0);
  const items: DropdownItem[] = (projection?.models ?? []).map((model) => ({
    id: JSON.stringify([model.route.providerId, model.route.modelId]),
    label: model.label,
    description: model.description ?? undefined,
    selected: pendingModel
      ? model.route.providerId === pendingModel.providerId && model.route.modelId === pendingModel.modelId
      : model.selected,
    disabled: model.disabled,
    onSelect: async () => {
      const session = navigationSession.current;
      if (!pending && (await onSelectModel(model.route)) && session === navigationSession.current) setPage('reasoning');
    },
  }));
  return (
    <Dropdown
      open={open}
      onOpenChange={(next) => {
        navigationSession.current += 1;
        // Keep the outgoing page intact throughout the shared exit animation.
        if (next) {
          setPage('reasoning');
          setPreviewLabel(null);
        }
        onOpenChange(next);
      }}
      contentKey={JSON.stringify([page, projection == null, error])}
      resetKey={resetKey}
      placement="top"
      align="center"
      closeOnSelect={false}
      panelClassName={pending ? 'composer-model-selector__panel--pending' : undefined}
      itemSelectionMode="single"
      panelRole={page === 'models' ? 'menu' : 'dialog'}
      ariaLabel={projection?.copy.triggerLabel ?? text.loading}
      items={page === 'models' ? items : []}
      header={
        page === 'models' && projection
          ? {
              title: projection.copy.chooseModel,
              onClick: () => setPage('reasoning'),
              ariaLabel: projection.copy.back,
            }
          : undefined
      }
      footer={
        error ? (
          <Feedback tone="error" layout="compact" action={{ label: text.retry, onClick: onRetry }}>
            {error}
          </Feedback>
        ) : undefined
      }
      renderContent={
        page === 'reasoning'
          ? () =>
              projection ? (
                <div className="composer-model-selector__controls" aria-busy={pending}>
                  <div className="composer-model-selector__heading">
                    <Icon name="zap" size={15} className="composer-model-selector__symbol" />
                    <button
                      type="button"
                      className="composer-model-selector__model-link"
                      data-dropdown-option="true"
                      aria-disabled={pending}
                      onClick={() => {
                        if (!pending) setPage('models');
                      }}
                      aria-label={projection.copy.chooseModel}
                    >
                      <span className="composer-model-selector__effort" data-adjustable={projection.reasoning.canSelect || undefined}>
                        {previewLabel ?? projection.reasoning.label}
                      </span>
                      <span className="composer-model-selector__model-name">
                        {projection.modelLabel}
                        <Icon name="chevron-right" size={11} />
                      </span>
                    </button>
                    {projection.reasoning.canSelect ? (
                      <button
                        className="composer-model-selector__reset"
                        type="button"
                        aria-label={projection.copy.reset}
                        title={projection.copy.reset}
                        aria-disabled={pending || !projection.reasoning.canReset}
                        onClick={() => {
                          if (!pending && projection.reasoning.canReset) void onSelectReasoning(null);
                        }}
                      >
                        <Icon name="rotate-ccw" size={14} />
                      </button>
                    ) : null}
                  </div>
                  <StepSlider
                    label={projection.copy.reasoning}
                    unselectedLabel={projection.reasoning.description ?? projection.reasoning.label}
                    options={projection.reasoning.options}
                    value={projection.reasoning.value}
                    disabled={!projection.reasoning.canSelect}
                    busy={pending}
                    onPreviewChange={setPreviewLabel}
                    onChange={async (value) => {
                      await onSelectReasoning(value);
                    }}
                  />
                </div>
              ) : (
                <Feedback layout="compact" tone="loading">
                  {text.loading}
                </Feedback>
              )
          : items.length === 0
            ? () => <Feedback layout="compact">{projection?.copy.empty}</Feedback>
            : undefined
      }
      renderTrigger={({ ref, open: expanded, toggle }) => {
        const reasoningPrompt =
          projection && expanded && page === 'reasoning' && projection.reasoning.canSelect && projection.reasoning.options.length > 1
            ? projection.copy.chooseReasoning
            : null;
        return (
          <button
            ref={ref}
            type="button"
            className="composer-model-selector__trigger"
            disabled={disabled}
            onClick={toggle}
            aria-expanded={expanded}
            aria-haspopup={page === 'models' ? 'menu' : 'dialog'}
            aria-label={reasoningPrompt ?? projection?.copy.triggerLabel ?? (pending ? text.loading : text.missing)}
            title={notice ?? projection?.providerLabel}
          >
            {reasoningPrompt ? (
              <span className="composer-model-selector__trigger-prompt">{reasoningPrompt}</span>
            ) : (
              <>
                <span className="composer-model-selector__trigger-model">
                  {projection?.modelLabel ?? (pending ? text.loading : text.missing)}
                </span>
                <span className="composer-model-selector__trigger-effort">{projection?.reasoning.label ?? ''}</span>
              </>
            )}
            <Icon name="chevron-down" size={12} />
          </button>
        );
      }}
    />
  );
}
