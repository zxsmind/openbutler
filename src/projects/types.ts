export interface Project {
  id: string;
  name: string;
  folders: string[];
  createdAt: string;
  available: boolean;
}

export type ProjectContext = Pick<Project, 'id' | 'name' | 'folders'>;
export interface SessionProject {
  id: string | null;
  name: string | null;
  folders: string[];
  workspaceRoot: string;
  locked: boolean;
}
export interface ProjectCatalog {
  projects: Project[];
  supportsSelection: boolean;
}
