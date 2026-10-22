import { useRef, useState } from 'react';
import type { ApprovalMode } from '../types.js';
import { Dropdown } from './selection/dropdown.js';
import { Icon } from './ui.js';
import './selection/tokens.css';

const modes: Array<{ id: ApprovalMode; label: string; description: string }> = [
  { id: 'workspace', label: 'Workspace', description: 'Ask for approval before actions outside the workspace.' },
  { id: 'auto-review', label: 'Auto review', description: 'Send actions that need approval to a safety review.' },
  { id: 'full-access', label: 'Full access', description: 'Run actions without asking for approval.' },
];

export function ApprovalSelector({
  value,
  disabled,
  onChange,
}: {
  value?: string | null;
  disabled: boolean;
  onChange: (mode: ApprovalMode) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const saving = useRef(false);
  return (
    <Dropdown
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setError(null);
      }}
      ariaLabel="Safety and approval"
      placement="top"
      align="start"
      itemSelectionMode="single"
      closeOnSelect={false}
      header={{ title: 'Safety and approval' }}
      footer={error ? <span role="alert">{error}</span> : undefined}
      items={modes.map((mode) => ({
        ...mode,
        selected: mode.id === value,
        disabled: pending,
        onSelect: async ({ close }) => {
          if (saving.current) return;
          if (mode.id === value) {
            close();
            return;
          }
          saving.current = true;
          setPending(true);
          setError(null);
          try {
            await onChange(mode.id);
            close();
          } catch (error) {
            setError(error instanceof Error ? error.message : String(error));
          } finally {
            saving.current = false;
            setPending(false);
          }
        },
      }))}
      renderTrigger={({ ref, toggle, open }) => (
        <button
          ref={ref}
          type="button"
          className="button button-ghost permission-button"
          aria-label="Safety and approval"
          aria-haspopup="menu"
          aria-expanded={open}
          disabled={disabled || pending}
          onClick={toggle}
        >
          <Icon name="shield-check" />
          {modes.find((mode) => mode.id === value)?.label ?? 'Safety'}
        </button>
      )}
    />
  );
}
