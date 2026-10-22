import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { OverlayPortalContext } from './selection/overlay-portal.js';
import './dialog.css';

/** Native focus containment, background inertness, Escape and restoration. */
export function Dialog({
  label,
  children,
  onClose,
  className = '',
}: {
  label: string;
  children: ReactNode;
  onClose: () => void;
  className?: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [portalHost, setPortalHost] = useState<HTMLDialogElement | null>(null);
  useLayoutEffect(() => {
    const previous = document.activeElement;
    const node = dialog.current;
    setPortalHost(node);
    node?.showModal();
    node?.querySelector<HTMLElement>('[data-dialog-autofocus]')?.focus();
    return () => {
      node?.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      className={`dialog ${className}`}
      aria-label={label}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom)
          onClose();
      }}
    >
      <OverlayPortalContext value={portalHost}>{children}</OverlayPortalContext>
    </dialog>
  );
}
