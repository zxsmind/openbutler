import { fileExtensions, fileNames } from 'material-icon-theme/dist/material-icons.json';

/**
 * One shared resolver for file artwork, used by every surface that names a
 * file: message citations, the panel tree, the panel header. The associations
 * come from the Material Icon Theme package, resolved in the theme's own
 * order — exact file name first, then extension, then the generic glyph — so a
 * file looks the same wherever it appears.
 *
 * The SVGs stay in the package and are globbed lazily: only icons that are
 * actually rendered resolve to a URL, so the 1,256 artwork files never land
 * in the bundle as a table of inlined data.
 */

const names = fileNames as unknown as Record<string, string>;
const extensions = fileExtensions as unknown as Record<string, string>;

/** The theme's icon key for a file: `markdown`, `typescript`, `file`, … */
export function fileIconKey(fileName: string): string {
  const base = fileName.split('/').at(-1) ?? fileName;
  const byName = names[base];
  if (byName) return byName;
  const dot = base.lastIndexOf('.');
  const extension = dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
  return extensions[extension] ?? 'file';
}

const icons = import.meta.glob<string>('../node_modules/material-icon-theme/icons/*.svg', {
  query: '?url',
  import: 'default',
});

/** Resolves the theme's SVG for a file, or undefined when the package has no such artwork. */
export function fileIconUrl(fileName: string): Promise<string | undefined> | undefined {
  return icons[`../node_modules/material-icon-theme/icons/${fileIconKey(fileName)}.svg`]?.();
}
