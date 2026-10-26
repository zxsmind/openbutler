import type { Transition, Variants } from 'framer-motion';

/**
 * Shared motion contract for compact surfaces such as menus, popovers and
 * dropdown panels. Feature components should consume these values instead of
 * defining their own timings and easing curves.
 */
export const surfaceMotionTransition: Transition = {
  duration: 0.16,
  ease: [0.2, 0.8, 0.2, 1],
};

/** Open surfaces keep their anchor while content changes their bounds. */
export const surfaceLayoutTransition: Transition = {
  duration: 0.2,
  ease: [0.4, 0, 0.2, 1],
};

/** Chromium tab bounds: 200 ms with gfx::Tween::EASE_OUT (quadratic).
 * https://chromium.googlesource.com/chromium/src/+/7956363699684821b85960b5a056fb2e3fe8b3db/chrome/browser/ui/views/tabs/tab_container_impl.cc
 * https://github.com/chromium/chromium/blob/main/ui/gfx/animation/tween.cc
 * Only tab creation/removal uses this; selection and page content remain instant.
 */
export const tabBoundsTransition: Transition = {
  type: 'tween',
  duration: 0.2,
  ease: (progress: number) => 1 - (1 - progress) ** 2,
};

export const surfaceMotionVariants: Variants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1 },
  exit: { opacity: 0 },
};

/**
 * Shared reveal contract for content that is conditionally inserted into an
 * existing surface. It deliberately keeps the same timing and easing as the
 * compact surface family while avoiding scale, which would make layout rows
 * look unstable as their height changes.
 */
export const contentRevealMotionVariants: Variants = {
  hidden: { opacity: 0, height: 0 },
  visible: { opacity: 1, height: 'auto' },
  exit: { opacity: 0, height: 0 },
};
