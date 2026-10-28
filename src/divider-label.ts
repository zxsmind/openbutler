/**
 * The one label rule for stored dividers, shared by the terminal and the web so
 * a boundary reads the same everywhere. Day dividers store only their moment;
 * the label is derived from it at read time, because "Today" has to become
 * "Yesterday" without anyone rewriting history. Statement dividers (settings
 * changes) carry their own words and pass through untouched.
 */
export function dividerLabel(entry: { at?: number | undefined; text?: string | undefined }, now: Date = new Date()): string {
  if (entry.text !== undefined) return entry.text;
  if (entry.at === undefined) return '';
  const at = new Date(entry.at);
  const day = (value: Date): number => Math.floor(Date.UTC(value.getFullYear(), value.getMonth(), value.getDate()) / 86_400_000);
  const diff = day(now) - day(at);
  const pad = (value: number): string => String(value).padStart(2, '0');
  const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  if (diff <= 0) return `Today ${time}`;
  if (diff === 1) return 'Yesterday';
  if (diff < 7) return WEEKDAYS[at.getDay()];
  return `${MONTHS[at.getMonth()]} ${at.getDate()}`;
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
