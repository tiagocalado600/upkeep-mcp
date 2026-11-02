import { isIP } from 'node:net';

/**
 * Deciding whether an address belongs to the public internet.
 *
 * A tool that fetches whatever URL it is handed is doing its job when the
 * person holding the keyboard asked for it. Exposed publicly it is something
 * else: an endpoint that will read `http://169.254.169.254/latest/meta-data/`
 * on a stranger's behalf, or map the ports of whatever network it runs in,
 * wearing this project's own `User-Agent`.
 *
 * The rule is therefore a property of the entrypoint rather than of the checks:
 * a local server keeps the operator's own authority over their own machine, and
 * a public one is restricted to targets that are, by definition, already public.
 *
 * @see https://www.rfc-editor.org/rfc/rfc5735 (IPv4 special-purpose addresses)
 * @see https://www.rfc-editor.org/rfc/rfc4193 (IPv6 unique local addresses)
 */

/** One IPv4 range that is not public unicast, as an address and a prefix length. */
interface Range {
  /** The network address, as four octets. */
  network: [number, number, number, number];
  /** How many leading bits are fixed. */
  bits: number;
  /** Why it is excluded, for the error a caller shows. */
  reason: string;
}

/**
 * IPv4 ranges that are not public unicast.
 *
 * Chosen for what they let an attacker reach rather than for completeness:
 * loopback and the private ranges are the internal network, and link-local is
 * where every cloud provider parks its instance metadata service.
 */
const IPV4_RANGES: Range[] = [
  { network: [0, 0, 0, 0], bits: 8, reason: 'the unspecified range' },
  { network: [10, 0, 0, 0], bits: 8, reason: 'a private network' },
  { network: [100, 64, 0, 0], bits: 10, reason: 'carrier-grade NAT space' },
  { network: [127, 0, 0, 0], bits: 8, reason: 'loopback' },
  { network: [169, 254, 0, 0], bits: 16, reason: 'link-local, where cloud metadata lives' },
  { network: [172, 16, 0, 0], bits: 12, reason: 'a private network' },
  { network: [192, 0, 0, 0], bits: 24, reason: 'IETF protocol assignments' },
  { network: [192, 168, 0, 0], bits: 16, reason: 'a private network' },
  { network: [198, 18, 0, 0], bits: 15, reason: 'benchmarking space' },
  { network: [224, 0, 0, 0], bits: 4, reason: 'multicast' },
  // 240.0.0.0/4 also covers 255.255.255.255, so the broadcast address needs no
  // rule of its own.
  { network: [240, 0, 0, 0], bits: 4, reason: 'reserved space' },
];

/** Why an address was rejected, or `null` when it is ordinary public space. */
export type AddressVerdict = string | null;

/**
 * Judges one IP address.
 *
 * @param address An IPv4 or IPv6 address, without brackets or a port.
 * @returns `null` when the address is public unicast, otherwise why it is not.
 *   An address that cannot be parsed is rejected: something unrecognised is not
 *   something to connect to.
 * @throws Never.
 */
export function rejectPrivateAddress(address: string): AddressVerdict {
  const family = isIP(address);
  if (family === 4) return rejectIpv4(address);
  if (family === 6) return rejectIpv6(address);
  return 'it is not a recognisable IP address';
}

/**
 * @param address A dotted-quad IPv4 address.
 * @returns Why it is not public, or `null`.
 * @throws Never.
 */
function rejectIpv4(address: string): AddressVerdict {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet))) {
    return 'it is not a recognisable IP address';
  }

  const value = octets.reduce((total, octet) => total * 256 + octet, 0);

  for (const range of IPV4_RANGES) {
    const base = range.network.reduce((total, octet) => total * 256 + octet, 0);
    // A prefix of n bits fixes the top n bits; shifting both sides down by the
    // remainder compares exactly those.
    const shift = 32 - range.bits;
    if (Math.floor(value / 2 ** shift) === Math.floor(base / 2 ** shift)) return range.reason;
  }

  return null;
}

/**
 * @param address An IPv6 address.
 * @returns Why it is not public, or `null`.
 * @throws Never.
 */
function rejectIpv6(address: string): AddressVerdict {
  const bytes = ipv6Bytes(address);
  if (bytes === null) return 'it is not a recognisable IP address';

  const startsWith = (...prefix: number[]): boolean =>
    prefix.every((byte, index) => bytes[index] === byte);
  const zeroUpTo = (end: number): boolean => bytes.slice(0, end).every((byte) => byte === 0);
  const embeddedIpv4 = (start: number): AddressVerdict =>
    rejectIpv4(bytes.slice(start, start + 4).join('.'));

  if (zeroUpTo(15) && bytes[15] === 0) return 'the unspecified address';
  if (zeroUpTo(15) && bytes[15] === 1) return 'loopback';

  // These forms all reach an IPv4 destination, so they are judged as one:
  // mapped (::ffff:0:0/96), the deprecated compatible form (::/96), translated
  // (::ffff:0:0:0/96), NAT64 (64:ff9b::/96) and 6to4 (2002::/16).
  if (zeroUpTo(10) && bytes[10] === 0xff && bytes[11] === 0xff) return embeddedIpv4(12);
  if (zeroUpTo(12)) return embeddedIpv4(12);
  if (zeroUpTo(8) && bytes[8] === 0xff && bytes[9] === 0xff && bytes[10] === 0 && bytes[11] === 0) {
    return embeddedIpv4(12);
  }
  if (startsWith(0x00, 0x64, 0xff, 0x9b) && bytes.slice(4, 12).every((byte) => byte === 0)) {
    return embeddedIpv4(12);
  }
  if (startsWith(0x20, 0x02)) return embeddedIpv4(2);

  // Local-use NAT64 (64:ff9b:1::/48) and Teredo (2001::/32) are translators
  // whose destination cannot be judged from here, so neither is treated as public.
  if (startsWith(0x00, 0x64, 0xff, 0x9b, 0x00, 0x01)) return 'a local translation prefix';
  if (startsWith(0x20, 0x01, 0x00, 0x00)) return 'a tunnelling prefix';

  const first = bytes[0] ?? 0;
  const second = bytes[1] ?? 0;
  // fc00::/7 unique local, fe80::/10 link-local, ff00::/8 multicast.
  if ((first & 0xfe) === 0xfc) return 'a unique local address';
  if (first === 0xfe && (second & 0xc0) === 0x80) return 'link-local';
  if (first === 0xff) return 'multicast';

  return null;
}

/**
 * Expands an IPv6 address to its sixteen bytes.
 *
 * Comparing text is what let this guard be bypassed: `::1`, `0:0:0:0:0:0:0:1`
 * and `::0001` are one address, and the URL parser rewrites a dotted suffix to
 * hexadecimal before anything here sees it.
 *
 * @param address An address `net.isIP` already accepted as IPv6, zone allowed.
 * @returns The bytes, or `null` when the address does not expand to sixteen.
 * @throws Never.
 */
function ipv6Bytes(address: string): number[] | null {
  const plain = address.toLowerCase().split('%')[0] ?? '';

  const lastColon = plain.lastIndexOf(':');
  const tail = plain.slice(lastColon + 1);
  let text = plain;
  if (tail.includes('.')) {
    const octets = tail.split('.').map(Number);
    const [a = 0, b = 0, c = 0, d = 0] = octets;
    text = `${plain.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }

  const [headText = '', tailText] = text.split('::');
  const groupsOf = (part: string): string[] => (part === '' ? [] : part.split(':'));
  const head = groupsOf(headText);
  const rest = tailText === undefined ? [] : groupsOf(tailText);
  const missing = 8 - head.length - rest.length;
  if (missing < 0 || (tailText === undefined && missing !== 0)) return null;

  const groups = [...head, ...Array.from({ length: missing }, () => '0'), ...rest];
  return groups.flatMap((group) => {
    const value = Number.parseInt(group, 16);
    return [value >> 8, value & 0xff];
  });
}
