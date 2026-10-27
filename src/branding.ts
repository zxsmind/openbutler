import { readFile } from 'node:fs/promises';

export const BRAND_LOGO_URL = '/brand/logo.svg';

/** The source SVG is copied to the same module-relative path in dist. */
const brandLogoFile = new URL('./assets/branding/ranite.svg', import.meta.url);

/** All browser brand surfaces receive these exact SVG bytes from the server. */
export function readBrandLogo(): Promise<Buffer> {
  return readFile(brandLogoFile);
}
