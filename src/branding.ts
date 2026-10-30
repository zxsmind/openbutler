import { readFile } from 'node:fs/promises';

export const BRAND_LOGO_URL = '/brand/logo.svg';
export const BRAND_FAVICON_SVG_URL = '/brand/favicon.svg';
export const BRAND_FAVICON_ICO_URL = '/favicon.ico';
export const BRAND_FAVICON_PNG_URL = '/favicon-32x32.png';
export const BRAND_APPLE_TOUCH_ICON_URL = '/apple-touch-icon.png';

const brandAssets = new Map<string, { filename: string; contentType: string }>([
  [BRAND_LOGO_URL, { filename: 'openbutler.svg', contentType: 'image/svg+xml; charset=utf-8' }],
  [BRAND_FAVICON_SVG_URL, { filename: 'favicon.svg', contentType: 'image/svg+xml; charset=utf-8' }],
  [BRAND_FAVICON_ICO_URL, { filename: 'favicon.ico', contentType: 'image/x-icon' }],
  [BRAND_FAVICON_PNG_URL, { filename: 'favicon-32.png', contentType: 'image/png' }],
  [BRAND_APPLE_TOUCH_ICON_URL, { filename: 'favicon-180.png', contentType: 'image/png' }],
]);

/** The server, not the browser bundle or workspace, owns all brand assets. */
export function getBrandAsset(pathname: string): { data: Promise<Buffer>; contentType: string } | null {
  const asset = brandAssets.get(pathname);
  if (!asset) return null;
  return {
    data: readFile(new URL(`./assets/branding/${asset.filename}`, import.meta.url)),
    contentType: asset.contentType,
  };
}

export function readBrandLogo(): Promise<Buffer> {
  return readFile(new URL('./assets/branding/openbutler.svg', import.meta.url));
}
