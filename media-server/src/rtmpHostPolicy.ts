import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { RtmpRelayDestination } from '@studio/shared';

/**
 * RTMP destinations must be public ingest servers (YouTube, Facebook, Twitch,
 * a custom public RTMP host). FFmpeg connects wherever the studio says, so a
 * destination on a private, loopback, link-local or carrier-grade NAT address
 * would let a studio reach services inside the media server's network. The
 * hostname is resolved first so a public-looking name that points inward is
 * refused too. RTMP_ALLOW_PRIVATE_HOSTS=true lifts this for local development
 * (for example an nginx-rtmp test server on localhost).
 */

export type HostLookup = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

const defaultLookup: HostLookup = (hostname) => dnsLookup(hostname, { all: true, verbatim: true });

function parseIpv4(address: string): number[] | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : NaN));
  return octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255) ? octets : null;
}

function isNonPublicIpv4(octets: number[]): boolean {
  const [a, b] = octets;
  return (
    a === 0 || // "this" network
    a === 10 || // RFC 1918
    a === 127 || // loopback
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT (RFC 6598)
    (a === 169 && b === 254) || // link-local, including cloud metadata endpoints
    (a === 172 && b >= 16 && b <= 31) || // RFC 1918
    (a === 192 && b === 168) || // RFC 1918
    (a === 192 && b === 0 && octets[2] === 0) || // IETF protocol assignments
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    a >= 224 // multicast and reserved
  );
}

function expandIpv6(address: string): number[] | null {
  let value = address.toLowerCase();
  const zone = value.indexOf('%');
  if (zone >= 0) value = value.slice(0, zone);
  // An embedded IPv4 tail (::ffff:10.0.0.1) becomes two hextets.
  const lastColon = value.lastIndexOf(':');
  const tail = value.slice(lastColon + 1);
  if (tail.includes('.')) {
    const octets = parseIpv4(tail);
    if (!octets) return null;
    value = `${value.slice(0, lastColon + 1)}${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }
  const halves = value.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? head.length !== 8 : missing < 1) return null;
  const groups = [...head, ...(halves.length === 2 ? Array(missing).fill('0') : []), ...rest];
  const hextets = groups.map((group) => (/^[0-9a-f]{1,4}$/.test(group) ? parseInt(group, 16) : NaN));
  return hextets.length === 8 && hextets.every((h) => Number.isInteger(h)) ? hextets : null;
}

/** Whether an IP address is anything other than a public unicast address. */
export function isNonPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const octets = parseIpv4(address);
    return !octets || isNonPublicIpv4(octets);
  }
  if (family !== 6) return true;
  const hextets = expandIpv6(address);
  if (!hextets) return true;
  if (hextets.every((h) => h === 0)) return true; // unspecified
  if (hextets.slice(0, 7).every((h) => h === 0) && hextets[7] === 1) return true; // loopback
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d) addresses follow the IPv4 rules.
  if (hextets.slice(0, 5).every((h) => h === 0) && (hextets[5] === 0xffff || hextets[5] === 0)) {
    return isNonPublicIpv4([hextets[6] >> 8, hextets[6] & 0xff, hextets[7] >> 8, hextets[7] & 0xff]);
  }
  const first = hextets[0];
  return (
    (first & 0xfe00) === 0xfc00 || // unique local fc00::/7
    (first & 0xffc0) === 0xfe80 || // link-local fe80::/10
    (first & 0xffc0) === 0xfec0 || // deprecated site-local
    (first & 0xff00) === 0xff00 || // multicast
    (first === 0x64 && hextets[1] === 0xff9b) || // NAT64 can reach IPv4-internal hosts
    (first === 0x2001 && hextets[1] === 0x0db8) // documentation
  );
}

export function allowsPrivateRtmpHosts(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.RTMP_ALLOW_PRIVATE_HOSTS === 'true';
}

function hostnameOf(rtmpUrl: string): string | null {
  try {
    const host = new URL(rtmpUrl.trim()).hostname;
    // URL keeps IPv6 literals bracketed.
    return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host || null;
  } catch {
    return null;
  }
}

/**
 * Resolve every destination host and refuse any that is not public. Returns a
 * user-facing issue, or null when every destination may be relayed to.
 */
export async function checkRtmpDestinationHosts(
  destinations: RtmpRelayDestination[],
  options: { env?: NodeJS.ProcessEnv; lookup?: HostLookup } = {}
): Promise<string | null> {
  if (allowsPrivateRtmpHosts(options.env || process.env)) return null;
  const lookup = options.lookup || defaultLookup;
  const resolved = new Map<string, string | null>();
  for (const destination of destinations) {
    const name = destination?.name || 'Destination';
    const host = hostnameOf(destination?.rtmpUrl || '');
    if (!host) return `${name}: Invalid RTMP server URL`;
    const key = host.toLowerCase();
    if (!resolved.has(key)) {
      let issue: string | null = null;
      if (key === 'localhost' || key.endsWith('.localhost') || key.endsWith('.internal') || key.endsWith('.local')) {
        issue = 'RTMP server must be a public internet host';
      } else if (isIP(host)) {
        issue = isNonPublicAddress(host) ? 'RTMP server must be a public internet host' : null;
      } else {
        try {
          const addresses = await lookup(host);
          if (addresses.length === 0) issue = 'RTMP server host could not be found';
          else if (addresses.some((entry) => isNonPublicAddress(entry.address))) {
            issue = 'RTMP server must be a public internet host';
          }
        } catch {
          issue = 'RTMP server host could not be found';
        }
      }
      resolved.set(key, issue);
    }
    const issue = resolved.get(key);
    if (issue) return `${name}: ${issue}`;
  }
  return null;
}
