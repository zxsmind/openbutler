import { FileIcon } from '../components/file-icon.js';
import './file-badge.css';

/** The file glyph the panel tree, message citations and the panel header share. */
export function FileBadge({ name }: { name: string }) {
  return <FileIcon fileName={name} size={14} />;
}
