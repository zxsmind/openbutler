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
