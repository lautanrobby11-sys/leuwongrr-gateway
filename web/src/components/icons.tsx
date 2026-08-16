import { motion, useReducedMotion } from 'motion/react';
import {
  Activity,
  ArrowUp,
  BadgeCheck,
  BookOpen,
  Bot,
  ChevronDown,
  CircleAlert,
  Copy,
  CreditCard,
  ExternalLink,
  Eye,
  EyeOff,
  Gauge,
  KeyRound,
  LayoutDashboard,
  Loader2,
  LogOut,
  Mail,
  MessageSquare,
  Plus,
  Send,
  Settings2,
  ShieldCheck,
  Sparkles,
  Terminal,
  Trash2,
  TrendingUp,
  Users,
  Wallet,
  X,
  Zap,
  type LucideIcon
} from 'lucide-react';

/**
 * The animate-ui icon set is Lucide driven by Motion. Rather than copying a
 * component per glyph, every icon is declared once in this registry and
 * animated by one shared wrapper. Adding a glyph is a single line here, and a
 * duplicate import is impossible because screens never import lucide directly.
 */
export const ICONS = {
  activity: Activity,
  alert: CircleAlert,
  arrowUp: ArrowUp,
  book: BookOpen,
  bot: Bot,
  card: CreditCard,
  check: BadgeCheck,
  chevron: ChevronDown,
  close: X,
  copy: Copy,
  dashboard: LayoutDashboard,
  external: ExternalLink,
  eye: Eye,
  eyeOff: EyeOff,
  gauge: Gauge,
  key: KeyRound,
  logout: LogOut,
  mail: Mail,
  message: MessageSquare,
  plus: Plus,
  send: Send,
  settings: Settings2,
  shield: ShieldCheck,
  spinner: Loader2,
  sparkles: Sparkles,
  terminal: Terminal,
  trash: Trash2,
  trend: TrendingUp,
  users: Users,
  wallet: Wallet,
  zap: Zap
} as const satisfies Record<string, LucideIcon>;

export type IconName = keyof typeof ICONS;

interface IconProps {
  name: IconName;
  className?: string;
  size?: number;
  /** Play the entrance animation. Off inside dense tables and long lists. */
  animate?: boolean;
  spin?: boolean;
}

export function Icon({ name, className, size = 18, animate = false, spin = false }: IconProps) {
  const Glyph = ICONS[name];
  const reduced = useReducedMotion();

  if (spin) {
    return <Glyph size={size} className={`animate-spin ${className ?? ''}`} aria-hidden />;
  }
  if (!animate || reduced) {
    return <Glyph size={size} className={className} aria-hidden />;
  }
  return (
    <motion.span
      initial={{ scale: 0.85, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      whileHover={{ scale: 1.08 }}
      transition={{ type: 'spring', stiffness: 420, damping: 26 }}
      className="inline-flex"
    >
      <Glyph size={size} className={className} aria-hidden />
    </motion.span>
  );
}
