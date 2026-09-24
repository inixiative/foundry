// Ported from the template's cliVersion.ts and fetchVersion.ts: the version callbacks that
// stamp a cassette with what it was recorded against.
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

const DEFAULT_SEMVER = /(\d+\.\d+\.\d+(?:-[\w.]+)?)/;

type CliVersionOptions = {
  command?: string;
  regex?: RegExp;
};

/** Resolved on the PATH the live run uses (`FOUNDRY_VCR_PATH`), which is the daemon's resolution. */
export const cliVersion = async (cmd: string, opts: CliVersionOptions = {}): Promise<string> => {
  const command = opts.command ?? "--version";
  const regex = opts.regex ?? DEFAULT_SEMVER;
  const env = { ...process.env, ...(process.env.FOUNDRY_VCR_PATH ? { PATH: process.env.FOUNDRY_VCR_PATH } : {}) };
  const { stdout, stderr } = await execAsync(`${cmd} ${command}`, { env });
  const output = `${stdout}\n${stderr}`;
  const match = output.match(regex);
  if (!match) throw new Error(`cliVersion("${cmd} ${command}"): no version match in "${output.trim()}"`);
  return match[1]!;
};

// Resolve a version string by fetching a URL, for services that ship no CLI to stamp:
//   - extract(res): custom callback
//   - header:       a response header (etag, last-modified, x-api-version)
//   - default:      GET body, sha256, first 12 hex chars (an OpenAPI document is ideal)
type FetchVersionOptions = {
  init?: RequestInit;
  header?: string;
  extract?: (res: Response) => string | Promise<string>;
};

export const fetchVersion = async (url: string, opts: FetchVersionOptions = {}): Promise<string> => {
  const res = await fetch(url, { redirect: "follow", ...opts.init });
  if (!res.ok) throw new Error(`fetchVersion(${url}): ${res.status} ${res.statusText}`);

  if (opts.extract) return opts.extract(res);

  if (opts.header) {
    const value = res.headers.get(opts.header);
    if (!value) throw new Error(`fetchVersion(${url}): header "${opts.header}" missing`);
    return value.replace(/"/g, "");
  }

  const text = await res.text();
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(text);
  return hasher.digest("hex").slice(0, 12);
};

/** Numeric semver comparison; missing parts count as zero. */
export const compareVersions = (a: string, b: string): number => {
  const parse = (value: string) => (value.match(/\d+(?:\.\d+)*/)?.[0] ?? "0").split(".").map(Number);
  const left = parse(a), right = parse(b);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff) return Math.sign(diff);
  }
  return 0;
};
