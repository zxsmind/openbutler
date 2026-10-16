import { networkInterfaces } from 'node:os';

/** Tailscale assigns addresses from the shared CGNAT range. Anything else is not the tailnet. */
const TAILNET_V4_BASE = 0x64400000; // 100.64.0.0
const TAILNET_V4_MASK = 0xffc00000; // /10

/** Default port the hub listens on. High and unassigned; override with --port on init. */
export const TEAM_DEFAULT_PORT = 47821;

/** True for an IPv4 address inside 100.64.0.0/10. */
export function isTailnetAddress(value: string): boolean {
  const parts = value.split('.');
  if (parts.length !== 4) return false;
  const numbers = parts.map((part) => Number(part));
  if (numbers.some((number) => !Number.isInteger(number) || number < 0 || number > 255)) return false;
  const packed = ((numbers[0]! << 24) | (numbers[1]! << 16) | (numbers[2]! << 8) | numbers[3]!) >>> 0;
  return (packed & TAILNET_V4_MASK) === TAILNET_V4_BASE;
}

export type InterfaceLister = () => NodeJS.Dict<import('node:os').NetworkInterfaceInfo[]>;

/**
 * First non-internal IPv4 address in the tailnet range, or null when this
 * machine is not on a tailnet. The lister is injectable so tests never touch
 * the real interfaces.
 */
export function findTailnetAddress(lister: InterfaceLister = networkInterfaces): string | null {
  let interfaces: NodeJS.Dict<import('node:os').NetworkInterfaceInfo[]>;
  try {
    interfaces = lister();
  } catch {
    return null;
  }
  for (const addresses of Object.values(interfaces)) {
    if (!addresses) continue;
    for (const address of addresses) {
      if (address.family !== 'IPv4' || address.internal) continue;
      if (isTailnetAddress(address.address)) return address.address;
    }
  }
  return null;
}

export interface JoinTarget {
  host: string;
  port: number;
}

/**
 * Parses a join address: `100.64.0.1`, `100.64.0.1:47821`, or a MagicDNS name
 * like `server.tail-ahead.ts.net` with an optional port. Empty host, userinfo,
 * paths, and non-tailnet literals are refused; DNS names are resolved by the
 * OS at connect time (Tailscale answers MagicDNS itself).
 */
export function parseJoinTarget(raw: string): JoinTarget {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 512) throw new Error('Join address must be a tailnet host with an optional :port.');
  if (trimmed.includes('/') || trimmed.includes('?') || trimmed.includes('#') || trimmed.includes('@'))
    throw new Error('Join address must be a bare host with an optional :port, not a URL.');
  let host = trimmed;
  let port = TEAM_DEFAULT_PORT;
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(trimmed);
  const lastColon = trimmed.lastIndexOf(':');
  if (bracketed) {
    host = bracketed[1]!;
    if (bracketed[2] !== undefined) port = Number(bracketed[2]);
  } else if (lastColon > -1 && /^[0-9.]+$/.test(trimmed)) {
    // IPv4 literal with an optional port.
    const candidatePort = trimmed.slice(lastColon + 1);
    if (candidatePort.length > 0) {
      host = trimmed.slice(0, lastColon);
      port = Number(candidatePort);
    }
  } else if (lastColon > -1 && trimmed.indexOf(':') === lastColon) {
    host = trimmed.slice(0, lastColon);
    port = Number(trimmed.slice(lastColon + 1));
  }
  if (!host) throw new Error('Join address needs a host.');
  if (!/^[A-Za-z0-9]([A-Za-z0-9.-]{0,253}[A-Za-z0-9])?$/.test(host)) throw new Error(`"${host}" is not a valid host name or IP address.`);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Port "${port}" is out of range 1-65535.`);
  if (/^[0-9.]+$/.test(host) && !isTailnetAddress(host))
    throw new Error(`${host} is outside the tailnet range 100.64.0.0/10. Join over the tailnet only.`);
  return { host, port };
}
