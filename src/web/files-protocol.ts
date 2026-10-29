export type WorkspaceFiles =
  | { kind: 'directory'; path: string; name: string; entries: Array<{ name: string; kind: 'directory' | 'file' | 'link' }> }
  | {
      kind: 'file';
      path: string;
      name: string;
      content: string | null;
      notice: string | null;
      /** Present when the file lies beyond the workspace: one cited, read-only preview. */ external?: boolean;
    };

export type FileChange = 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked';
export interface WorkspaceFileTree {
  name: string;
  rootLabel: string;
  indexed: boolean;
  entries: Array<{ path: string; change: FileChange | null; directory?: boolean }>;
}
