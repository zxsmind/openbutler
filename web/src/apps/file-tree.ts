import type { FileChange, WorkspaceFileTree } from '../../../src/web/files-protocol.js';

export interface FileTreeNode {
  name: string;
  path: string;
  children: FileTreeNode[] | null;
  change: FileChange | null;
  changed: boolean;
}

export function buildFileTree(entries: WorkspaceFileTree['entries'], filter = ''): FileTreeNode[] {
  const roots: FileTreeNode[] = [];
  const nodes = new Map<string, FileTreeNode>();
  const query = filter.trim().toLocaleLowerCase();
  for (const entry of entries) {
    if (query && !entry.path.toLocaleLowerCase().includes(query)) continue;
    const parts = entry.path.split('/').filter(Boolean);
    let siblings = roots;
    for (let index = 0; index < parts.length; index++) {
      const path = parts.slice(0, index + 1).join('/');
      const directory = index < parts.length - 1 || entry.directory === true;
      let node = nodes.get(path);
      if (!node) {
        node = { name: parts[index], path, children: directory ? [] : null, change: null, changed: false };
        nodes.set(path, node);
        siblings.push(node);
      }
      node.changed ||= entry.change !== null;
      if (index === parts.length - 1) node.change = entry.change;
      if (directory) siblings = node.children ??= [];
    }
  }
  const sort = (children: FileTreeNode[]) => {
    children.sort(
      (a, b) => Number(b.children !== null) - Number(a.children !== null) || a.name.localeCompare(b.name, undefined, { numeric: true }),
    );
    for (const child of children) if (child.children) sort(child.children);
  };
  sort(roots);
  return roots;
}
