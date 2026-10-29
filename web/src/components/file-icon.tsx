import { useEffect, useState } from 'react';
import { Icon } from './ui.js';
import { fileIconUrl } from '../file-icon.js';

/**
 * The Material Icon Theme artwork for a file. The generic glyph shows first
 * (and for artwork the theme does not have), so a list never renders an empty
 * gap while an SVG resolves.
 */
export function FileIcon({ fileName, size = 14 }: { fileName: string; size?: number }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    fileIconUrl(fileName)
      ?.then((resolved) => {
        if (live) setUrl(resolved ?? null);
      })
      .catch(() => {
        /* Keeping the generic glyph beats a broken image. */
      });
    return () => {
      live = false;
    };
  }, [fileName]);
  if (url) return <img className="file-icon" src={url} width={size} height={size} alt="" aria-hidden="true" decoding="async" />;
  return <Icon name="file" size={size} />;
}
