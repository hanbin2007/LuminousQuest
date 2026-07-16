export interface LaunchOptions {
  lan: boolean;
  hostname: '127.0.0.1' | '0.0.0.0';
}

export interface NetworkAddressLike {
  address: string;
  family: string | number;
  internal: boolean;
}

export function parseLaunchOptions(args: readonly string[]): LaunchOptions {
  const unknown = args.filter((argument) => argument !== '--lan' && argument !== '--');
  if (unknown.length > 0) throw new Error(`Unknown argument: ${unknown[0]}`);
  const lan = args.includes('--lan');
  return { lan, hostname: lan ? '0.0.0.0' : '127.0.0.1' };
}

function privateIpv4(address: string) {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
    return false;
  }
  return octets[0] === 10
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168)
    || (octets[0] === 169 && octets[1] === 254);
}

export function lanAccessUrls(
  port: number,
  accessToken: string,
  addresses: readonly NetworkAddressLike[],
) {
  return [...new Set(addresses
    .filter((address) =>
      !address.internal
      && (address.family === 'IPv4' || address.family === 4)
      && privateIpv4(address.address))
    .map((address) =>
      `http://${address.address}:${port}/?access_token=${encodeURIComponent(accessToken)}`))];
}
