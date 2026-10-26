import type { ComponentProps, CSSProperties } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  AudioLines,
  Brain,
  ChartNoAxesCombined,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Cloud,
  Code,
  Copy,
  CornerDownRight,
  Cpu,
  Ellipsis,
  File,
  FileSearch,
  Folder,
  FolderOpen,
  FolderPlus,
  Globe,
  Hexagon,
  House,
  Image,
  Info,
  Laptop,
  ListEnd,
  Maximize,
  Maximize2,
  MessageCircle,
  MessageSquare,
  Mic,
  Minimize,
  Minimize2,
  Network,
  PanelLeft,
  PanelRight,
  PanelRightClose,
  PanelsTopLeft,
  Plus,
  RotateCcw,
  RotateCw,
  ScrollText,
  Search,
  Send,
  Settings,
  ShieldCheck,
  Square,
  SquareMinus,
  SquarePen,
  SquarePlus,
  SquareTerminal,
  Terminal,
  TextCursorInput,
  Trash2,
  X,
  Zap,
  type LucideIcon,
} from 'lucide-react';

/**
 * Static icon registry: every glyph the client renders ships inside the entry
 * chunk, so an icon never waits on a request of its own. That is what removes
 * both failure modes of the old `lucide-react/dynamic` path — the blank icon
 * while a per-icon chunk downloads, and the icon that stays blank forever when
 * that chunk 404s after a rebuild.
 *
 * To use another Lucide glyph, add its PascalCase export here under its
 * kebab-case name; `IconName` then picks it up and the type checker covers
 * every call site.
 */
const glyphs = {
  'arrow-left': ArrowLeft,
  'arrow-right': ArrowRight,
  'arrow-up': ArrowUp,
  'audio-lines': AudioLines,
  brain: Brain,
  'chart-no-axes-combined': ChartNoAxesCombined,
  check: Check,
  'chevron-down': ChevronDown,
  'chevron-left': ChevronLeft,
  'chevron-right': ChevronRight,
  cloud: Cloud,
  code: Code,
  copy: Copy,
  'corner-down-right': CornerDownRight,
  cpu: Cpu,
  ellipsis: Ellipsis,
  file: File,
  'file-search': FileSearch,
  folder: Folder,
  'folder-open': FolderOpen,
  'folder-plus': FolderPlus,
  globe: Globe,
  hexagon: Hexagon,
  house: House,
  image: Image,
  info: Info,
  laptop: Laptop,
  'list-end': ListEnd,
  maximize: Maximize,
  'maximize-2': Maximize2,
  'message-circle': MessageCircle,
  'message-square': MessageSquare,
  mic: Mic,
  minimize: Minimize,
  'minimize-2': Minimize2,
  network: Network,
  'panel-left': PanelLeft,
  'panel-right': PanelRight,
  'panel-right-close': PanelRightClose,
  'panels-top-left': PanelsTopLeft,
  plus: Plus,
  'rotate-ccw': RotateCcw,
  'rotate-cw': RotateCw,
  'scroll-text': ScrollText,
  search: Search,
  send: Send,
  settings: Settings,
  'shield-check': ShieldCheck,
  square: Square,
  'square-minus': SquareMinus,
  'square-pen': SquarePen,
  'square-plus': SquarePlus,
  'square-terminal': SquareTerminal,
  terminal: Terminal,
  'text-cursor-input': TextCursorInput,
  'trash-2': Trash2,
  x: X,
  zap: Zap,
} satisfies Record<string, LucideIcon>;

export type IconName = keyof typeof glyphs;
export type IconProps = Omit<ComponentProps<LucideIcon>, 'ref'> & { name: IconName };

/** Use any name from the registry; an unknown one renders the reserved blank
 *  box instead of going out to the network. */
export function Icon({ name, size = 18, strokeWidth = 1.6, className = '', style, ...props }: IconProps) {
  const iconClass = `icon ${className}`.trim();
  const iconStyle = { '--icon-size': typeof size === 'number' ? `${size}px` : size, ...style } as CSSProperties;
  const Glyph = (glyphs as Record<IconName, LucideIcon | undefined>)[name];
  if (!Glyph) return <span className={iconClass} style={iconStyle} aria-hidden="true" />;
  return (
    <Glyph
      size={size}
      strokeWidth={strokeWidth}
      aria-hidden={props['aria-label'] || props['aria-labelledby'] ? undefined : true}
      focusable={false}
      {...props}
      className={iconClass}
      style={iconStyle}
    />
  );
}
