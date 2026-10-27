import { Button, IconButton } from '../ui.js';

/** Uses the conversation sidebar's exact header and search-button markup. */
export function SettingsHeader({ onSearch }: { onSearch: () => void }) {
  return (
    <div className="sidebar-heading">
      <span className="sidebar-brand">Ranite</span>
      <span className="spacer" />
      <IconButton icon="search" label="Search settings" onClick={onSearch} />
    </div>
  );
}

export function SettingsFooter({ onReturn }: { onReturn: () => void }) {
  return (
    <div className="settings-nav__footer">
      <Button className="settings-nav__return" icon="arrow-left" onClick={onReturn} aria-label="Back to chat">
        <span className="settings-nav__return-label">Back to chat</span>
      </Button>
    </div>
  );
}
