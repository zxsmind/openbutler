import { useEffect, useState } from 'react';
import { createProject, fetchProjects } from '../api.js';
import type { Project, SessionPayload } from '../types.js';

/** Domain state is a server projection. Only request/error presentation lives here. */
export function useProjects(
  session: SessionPayload['session'] | undefined,
  requestSelection: (id: string | null) => Promise<void>,
  canStartChat: boolean,
) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [selecting, setSelecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const [supportsSelection, setSupportsSelection] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchProjects()
      .then((catalog) => {
        if (cancelled) return;
        setProjects(catalog.projects);
        setSupportsSelection(catalog.supportsSelection);
      })
      .catch((problem: unknown) => {
        if (!cancelled) setError(problem instanceof Error ? problem.message : String(problem));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [reload]);
  const select = async (id: string | null) => {
    setSelecting(true);
    setSelectionError(null);
    try {
      await requestSelection(id);
      return true;
    } catch (problem) {
      setSelectionError(problem instanceof Error ? problem.message : String(problem));
      return false;
    } finally {
      setSelecting(false);
    }
  };
  const create = async (name: string, folders: string[]) => {
    const project = await createProject(name, folders);
    setProjects((previous) => (previous.some((item) => item.id === project.id) ? previous : [...previous, project]));
    if ((!session?.projectLocked || canStartChat) && !(await select(project.id)))
      throw new Error('The project was created, but the chat could not be selected. Open a new chat in it from the sidebar.');
    return project;
  };
  return {
    projects,
    selectedId: session?.project?.id ?? null,
    selected: session?.project?.id ? session.project : null,
    locked: session?.projectLocked === true,
    loading,
    selecting,
    error,
    selectionError,
    supportsSelection,
    select,
    create,
    refresh: () => setReload((value) => value + 1),
  };
}
export type ProjectController = ReturnType<typeof useProjects>;
