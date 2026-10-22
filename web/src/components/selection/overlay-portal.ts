import { createContext, useContext } from 'react';

/** Menus and tooltips belong to the dialog that opened them, including in the top layer. */
export const OverlayPortalContext = createContext<HTMLElement | null>(null);

export function useOverlayPortal() {
  const host = useContext(OverlayPortalContext);
  return host ?? (typeof document === 'undefined' ? null : document.body);
}
