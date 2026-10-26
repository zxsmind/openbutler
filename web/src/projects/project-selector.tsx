import { useState } from 'react';
import { Dropdown, type DropdownItem } from '../components/selection/dropdown.js';
import { Icon } from '../components/icon.js';
import { IconButton } from '../components/ui.js';
import { ComposerRail } from '../components/composer-rail.js';
import { Feedback } from '../components/feedback.js';
import type { ProjectController } from './use-projects.js';
import './projects.css';

export function ProjectSelector({ controller, onCreate }: { controller: ProjectController; onCreate: () => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const { projects, selected, selectedId, select, loading, error } = controller;
  const matches = projects.filter((project) =>
    `${project.name} ${project.folders.join(' ')}`.toLocaleLowerCase('tr').includes(query.trim().toLocaleLowerCase('tr')),
  );
  const items: DropdownItem[] = matches.map((project) => {
    const folder = project.folders[0]?.split(/[\\/]/).filter(Boolean).at(-1);
    return {
      id: project.id,
      label: (
        <span className="project-selector__name">
          {project.name}
          {folder !== project.name ? <small>{folder}</small> : null}
        </span>
      ),
      leading: <Icon name="folder" size={15} />,
      selected: project.id === selectedId,
      disabled: !project.available,
      description: project.available ? undefined : 'Source folder is unreachable',
      onSelect: () => {
        void select(project.id);
      },
    };
  });
  return (
    <Dropdown
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setQuery('');
      }}
      items={items}
      ariaLabel="Choose project"
      placement="top"
      align="start"
      itemSelectionMode="single"
      panelClassName="project-selector__panel"
      search={{ value: query, onChange: setQuery, placeholder: 'Search projects', ariaLabel: 'Search projects' }}
      renderContent={
        items.length
          ? undefined
          : () => (
              <Feedback layout="compact" tone={loading ? 'loading' : error ? 'error' : 'neutral'}>
                {loading ? 'Loading projects…' : error ? 'Projects could not be loaded.' : query ? 'No project found.' : 'No projects yet.'}
              </Feedback>
            )
      }
      footer={
        <div className="project-selector__actions">
          {error ? (
            <button type="button" onClick={controller.refresh}>
              <Icon name="rotate-ccw" size={15} />
              Try again
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onCreate();
            }}
          >
            <Icon name="plus" size={15} />
            New project
          </button>
          <button
            type="button"
            className={selectedId === null ? 'is-selected' : ''}
            onClick={() => {
              select(null);
              setOpen(false);
            }}
          >
            <Icon name="x" size={15} />
            No project
          </button>
        </div>
      }
      renderTrigger={({ ref, toggle, open: expanded }) => (
        <button
          ref={ref}
          type="button"
          className="project-selector__trigger"
          onClick={toggle}
          aria-label="Choose project"
          aria-haspopup="menu"
          aria-expanded={expanded}
          disabled={controller.selecting}
          title={selected?.folders.join('\n')}
        >
          <Icon name="folder" size={15} />
          <span>{selected?.name ?? (loading ? 'Loading projects…' : 'No project')}</span>
        </button>
      )}
    />
  );
}

export function ProjectContextBar({
  controller,
  onCreate,
  onSettings,
}: {
  controller: ProjectController;
  onCreate: () => void;
  onSettings: () => void;
}) {
  return (
    <ComposerRail tone="muted" aria-label="Chat project">
      <div className="composer-rail__row project-context">
        <ProjectSelector controller={controller} onCreate={onCreate} />
        <span className="project-context__machine">
          <Icon name="laptop" size={16} />
          Bu bilgisayar
        </span>
        <IconButton icon="settings" label="Project and app settings" className="project-context__settings" onClick={onSettings} />
      </div>
    </ComposerRail>
  );
}
