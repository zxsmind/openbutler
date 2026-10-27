import { Brand, Button, IconButton, type IconName } from './ui.js';
import './sidebar.css';

/** The same search/header markup for the conversation and Settings sidebars. */
export function SidebarHeader({ onSearch, searchLabel, onClose }: { onSearch: () => void; searchLabel: string; onClose?: () => void }) {
  return (
    <div className="sidebar-heading">
      <Brand />
      <span className="sidebar-brand">Ranite</span>
      <span className="spacer" />
      <IconButton icon="search" label={searchLabel} onClick={onSearch} />
      {onClose ? <IconButton icon="x" label="Close sidebar" className="mobile-only" onClick={onClose} /> : null}
    </div>
  );
}

/** Footer controls share their layout; only destination and label vary. */
export function SidebarFooter({ icon, label, onClick }: { icon: IconName; label: string; onClick: () => void }) {
  return (
    <div className="sidebar-footer">
      <Button className="sidebar-settings" icon={icon} onClick={onClick}>
        <span>{label}</span>
      </Button>
    </div>
  );
}
