#!/usr/bin/env node
// Checks the token list: every file in it is untrusted input, read as data and never run.
// No dependencies, so there is nothing to install.
//
//   node scripts/check.mjs                       every token, against the chain
//   node scripts/check.mjs --base origin/main    also the rules for a request against that ref
//   node scripts/check.mjs --offline             skips the chain

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const NETWORKS = { "dogeos-testnet": "https://dogeos-testnet-public.unifra.io/" };

const MAX_LOGO_BYTES = 100 * 1024;
const MIN_PNG_SIZE = 256;
const TAGS = new Set(["native", "wrapped", "stablecoin"]);
const REQUIRED = ["address", "name", "symbol", "decimals", "logoSource"];
const REQUEST_ONLY = ["website", "x", "proof"];
const KNOWN = new Set([...REQUIRED, ...REQUEST_ONLY, "tags"]);
const SVG_ELEMENTS = new Set([
  "svg", "g", "path", "circle", "ellipse", "rect", "line", "polygon", "polyline",
  "defs", "lineargradient", "radialgradient", "stop", "clippath", "mask", "title", "desc",
]);

// ---------------------------------------------------------------- addresses

const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
const ROTATIONS = [1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 2, 14, 27, 41, 56, 8, 25, 43, 62, 18, 39, 61, 20, 44];
const LANES = [10, 7, 11, 17, 18, 3, 5, 16, 8, 21, 24, 4, 15, 23, 19, 13, 12, 2, 20, 14, 22, 9, 6, 1];
const MASK = (1n << 64n) - 1n;
const rotl = (x, n) => ((x << BigInt(n)) | (x >> BigInt(64 - n))) & MASK;

/** Keccak-256, which node:crypto does not have (its sha3-256 pads differently). */
export function keccak256(bytes) {
  const rate = 136;
  const padded = new Uint8Array((Math.floor(bytes.length / rate) + 1) * rate);
  padded.set(bytes);
  padded[bytes.length] ^= 0x01;
  padded[padded.length - 1] ^= 0x80;
  const s = new Array(25).fill(0n);
  for (let offset = 0; offset < padded.length; offset += rate) {
    for (let i = 0; i < rate / 8; i++) {
      let lane = 0n;
      for (let b = 7; b >= 0; b--) lane = (lane << 8n) | BigInt(padded[offset + i * 8 + b]);
      s[i] ^= lane;
    }
    for (const rc of RC) {
      const c = [0, 1, 2, 3, 4].map((x) => s[x] ^ s[x + 5] ^ s[x + 10] ^ s[x + 15] ^ s[x + 20]);
      for (let x = 0; x < 5; x++) {
        const d = c[(x + 4) % 5] ^ rotl(c[(x + 1) % 5], 1);
        for (let y = 0; y < 25; y += 5) s[x + y] ^= d;
      }
      let last = s[1];
      for (let i = 0; i < 24; i++) {
        const next = s[LANES[i]];
        s[LANES[i]] = rotl(last, ROTATIONS[i]);
        last = next;
      }
      for (let y = 0; y < 25; y += 5) {
        const row = s.slice(y, y + 5);
        for (let x = 0; x < 5; x++) s[y + x] = row[x] ^ (~row[(x + 1) % 5] & MASK & row[(x + 2) % 5]);
      }
      s[0] ^= rc;
    }
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = Number((s[Math.floor(i / 8)] >> BigInt((i % 8) * 8)) & 0xffn);
  return out;
}

/** The EIP-55 spelling of a 0x address. */
export function checksum(address) {
  const lower = address.slice(2).toLowerCase();
  const hash = Buffer.from(keccak256(Buffer.from(lower))).toString("hex");
  return `0x${[...lower].map((c, i) => (parseInt(hash[i], 16) >= 8 ? c.toUpperCase() : c)).join("")}`;
}

// ---------------------------------------------------------------- logos

/** Why an SVG cannot be served, or null. Only known drawing elements pass, not "no known bad ones". */
export function svgProblem(bytes) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return "it is not UTF-8";
  }
  if (!/^\s*<(\?xml [^>]*\?>\s*)?<?svg[\s>]/i.test(text)) return "it does not start with an <svg> element";
  if (/<!/.test(text)) return "it has a DOCTYPE, entity, comment or CDATA section";
  if (/<\?(?!xml )/i.test(text) || (text.match(/<\?/g) ?? []).length > 1) return "it has a processing instruction";
  if (/&#|&[a-z]+;/i.test(text.replace(/&(amp|lt|gt|quot|apos);/g, ""))) return "it has an encoded character";
  for (const [, name] of text.matchAll(/<\/?\s*([^\s/>]+)/g)) {
    if (name.startsWith("?")) continue;
    if (!SVG_ELEMENTS.has(name.toLowerCase())) return `it has a <${name}> element`;
  }
  for (const [, name, , double, single] of text.matchAll(/([^\s<>=/"']+)\s*=\s*("([^"]*)"|'([^']*)')/g)) {
    const attribute = name.toLowerCase();
    const value = (double ?? single ?? "").toLowerCase();
    if (attribute.startsWith("on")) return `it has an event handler (${name})`;
    if (attribute === "style") return "it has a style attribute";
    if (attribute === "href" || attribute.endsWith(":href")) return `it has a link (${name})`;
    if (attribute === "xmlns" || attribute.startsWith("xmlns:")) continue;
    if (/url\(\s*(?!["']?#)/.test(value) || /(javascript|data|https?):/.test(value)) return `${name} refers to something outside the file`;
  }
  const viewBox = /viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)\s*["']/i.exec(text);
  if (!viewBox) return "it needs a viewBox";
  if (Number(viewBox[1]) !== Number(viewBox[2]) || Number(viewBox[1]) <= 0) return "it is not square";
  return null;
}

/** Why a PNG cannot be served, or null. */
export function pngProblem(bytes) {
  const signature = "89504e470d0a1a0a";
  if (bytes.length < 33 || bytes.subarray(0, 8).toString("hex") !== signature) return "it is not a PNG";
  if (bytes.subarray(12, 16).toString("latin1") !== "IHDR") return "it is not a PNG";
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width !== height) return `it is not square (${width}x${height})`;
  if (width < MIN_PNG_SIZE) return `it is ${width}x${height}, under ${MIN_PNG_SIZE}x${MIN_PNG_SIZE}`;
  return null;
}

// ---------------------------------------------------------------- the list

/** Two symbols that read alike count as the same one: refused as a copycat. */
export function lookalike(symbol) {
  return symbol.toLowerCase().replace(/[^a-z0-9]/g, "").replace(/0/g, "o").replace(/[1i]/g, "l");
}

const httpsUrl = (value) => {
  if (typeof value !== "string" || value.length > 200 || /\s/.test(value)) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
};

/** Reads one network's tokens. Everything wrong goes in `problems`: a request sees all of it at once. */
export function readTokens(root, network) {
  const problems = [];
  const tokens = [];
  const dir = join(root, "tokens", network);
  if (!existsSync(dir)) return { tokens, problems: [`tokens/${network} does not exist`] };
  if (lstatSync(join(root, "tokens")).isSymbolicLink() || lstatSync(dir).isSymbolicLink()) {
    return { tokens, problems: [`tokens/${network} must be a real folder`] };
  }
  for (const folder of readdirSync(dir).sort()) {
    const where = `tokens/${network}/${folder}`;
    const say = (message) => problems.push(`${where}: ${message}`);
    const path = join(dir, folder);
    // A link could point anywhere on the machine that reads it.
    if (!lstatSync(path).isDirectory()) {
      say("only token folders belong here");
      continue;
    }
    if (!/^0x[0-9a-f]{40}$/.test(folder)) {
      say("the folder must be the token's address in lower case");
      continue;
    }
    const files = readdirSync(path);
    const logos = files.filter((f) => f === "logo.svg" || f === "logo.png");
    for (const file of files) {
      if (file !== "info.json" && !logos.includes(file)) say(`unexpected file ${file}`);
      if (!lstatSync(join(path, file)).isFile()) say(`${file} is not a plain file`);
    }
    if (logos.length !== 1) say("it needs exactly one logo: logo.svg or logo.png");
    if (!files.includes("info.json") || !lstatSync(join(path, "info.json")).isFile()) {
      say("it needs an info.json");
      continue;
    }

    let info;
    try {
      info = JSON.parse(readFileSync(join(path, "info.json"), "utf8"));
    } catch (error) {
      say(`info.json is not JSON: ${error.message}`);
      continue;
    }
    if (typeof info !== "object" || info === null || Array.isArray(info)) {
      say("info.json must be an object");
      continue;
    }
    for (const key of Object.keys(info)) if (!KNOWN.has(key)) say(`unknown field ${key}`);
    for (const key of REQUIRED) if (info[key] === undefined) say(`${key} is missing`);

    const { address, name, symbol, decimals, tags, logoSource } = info;
    if (typeof address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
      say("address is not an address");
    } else {
      if (address.toLowerCase() !== folder) say("address is not the folder's");
      if (address !== checksum(address)) say(`address must be checksummed: ${checksum(address)}`);
    }
    // ASCII only: no lookalike letters and nothing that needs escaping downstream.
    if (typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9 .,()&_-]{0,63}$/.test(name)) say("name must be 1-64 plain letters, digits and .,()&_- ");
    if (typeof symbol !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,19}$/.test(symbol)) say("symbol must be 1-20 plain letters, digits and ._-");
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) say("decimals must be a whole number from 0 to 36");
    if (typeof logoSource !== "string" || logoSource.trim().length < 3 || logoSource.length > 300 || /[\r\n]/.test(logoSource)) {
      say("logoSource must say whose logo it is, and that it may be used here");
    }
    if (tags !== undefined && (!Array.isArray(tags) || tags.some((tag) => !TAGS.has(tag)))) {
      say(`tags can only be ${[...TAGS].join(", ")}`);
    }
    for (const key of REQUEST_ONLY) if (info[key] !== undefined && !httpsUrl(info[key])) say(`${key} must be an https link`);

    let logoHash = null;
    if (logos.length === 1 && lstatSync(join(path, logos[0])).isFile()) {
      const bytes = readFileSync(join(path, logos[0]));
      if (bytes.length > MAX_LOGO_BYTES) say(`the logo is over ${MAX_LOGO_BYTES / 1024} KB`);
      const problem = logos[0] === "logo.svg" ? svgProblem(bytes) : pngProblem(bytes);
      if (problem) say(`the logo cannot be used: ${problem}`);
      logoHash = createHash("sha256").update(bytes).digest("hex");
    }
    tokens.push({ folder, where, info, logo: logos[0] ?? null, logoHash });
  }

  const seen = { symbol: new Map(), name: new Map(), logo: new Map() };
  const once = (kind, key, token, label) => {
    if (seen[kind].has(key)) problems.push(`${token.where}: ${label} is already used by ${seen[kind].get(key)}`);
    else seen[kind].set(key, token.folder);
  };
  for (const token of tokens) {
    if (typeof token.info.symbol === "string") once("symbol", lookalike(token.info.symbol), token, `the symbol ${token.info.symbol}, or one that reads like it,`);
    if (typeof token.info.name === "string") once("name", token.info.name.toLowerCase(), token, `the name ${token.info.name}`);
    if (token.logoHash) once("logo", token.logoHash, token, "this logo");
  }
  return { tokens, problems };
}

// ---------------------------------------------------------------- the chain

async function rpc(url, method, params) {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(15_000),
      });
      const body = await response.json();
      if (body.error) return { error: body.error.message ?? "the call failed" };
      if (typeof body.result === "string") return { result: body.result };
      throw new Error("no result");
    } catch (error) {
      if (attempt >= 3) throw new Error(`the RPC cannot be reached: ${error.message}`);
      await new Promise((done) => setTimeout(done, 500 * 2 ** attempt));
    }
  }
}

/** A Solidity `string` return value. */
export function decodeString(hex) {
  const data = Buffer.from(hex.slice(2), "hex");
  if (data.length < 64) return null;
  const offset = Number(data.readBigUInt64BE(24));
  if (offset + 32 > data.length) return null;
  const length = Number(data.readBigUInt64BE(offset + 24));
  if (offset + 32 + length > data.length || length > 256) return null;
  return data.subarray(offset + 32, offset + 32 + length).toString("utf8");
}

const SELECTORS = { name: "0x06fdde03", symbol: "0x95d89b41", decimals: "0x313ce567" };

/** What is wrong with `token` by the chain. `isNew`: the name must match too. */
export async function chainProblems(token, url, isNew) {
  const { address, name, symbol, decimals } = token.info;
  const problems = [];
  const code = await rpc(url, "eth_getCode", [address, "latest"]);
  if (code.error || !code.result || code.result === "0x") return [`${token.where}: there is no contract at ${address}`];
  const call = async (what) => {
    const { result } = await rpc(url, "eth_call", [{ to: address, data: SELECTORS[what] }, "latest"]);
    return result && result !== "0x" ? result : null;
  };
  const chainSymbol = await call("symbol");
  const readSymbol = chainSymbol && decodeString(chainSymbol);
  if (readSymbol !== symbol) problems.push(`${token.where}: the chain says the symbol is ${JSON.stringify(readSymbol)}, not ${symbol}`);
  const chainDecimals = await call("decimals");
  const readDecimals = chainDecimals ? Number(BigInt(chainDecimals)) : null;
  if (readDecimals !== decimals) problems.push(`${token.where}: the chain says decimals are ${readDecimals}, not ${decimals}`);
  if (isNew) {
    const chainName = await call("name");
    const readName = chainName && decodeString(chainName);
    if (readName !== name) problems.push(`${token.where}: the chain says the name is ${JSON.stringify(readName)}, not ${name}`);
  }
  return problems;
}

// ---------------------------------------------------------------- a request

const git = (root, ...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });

/** Tokens added since `base`, and what is wrong with the change as a request. */
export function requestProblems(root, network, base, tokens) {
  const prefix = `tokens/${network}/`;
  const changed = git(root, "diff", "--name-only", "--no-renames", `${base}...HEAD`).split("\n").filter(Boolean);
  const inBase = new Set(
    git(root, "ls-tree", "--name-only", `${base}:`).includes("tokens")
      ? git(root, "ls-tree", "-r", "--name-only", base, "--", prefix).split("\n").filter(Boolean).map((p) => p.slice(prefix.length).split("/")[0])
      : [],
  );
  const added = new Set(tokens.filter((t) => !inBase.has(t.folder)).map((t) => t.folder));
  // The first tokens ever are the team's own: no request to judge.
  if (inBase.size === 0) return { added: new Set(), problems: [] };

  const problems = [];
  const touched = new Set(changed.filter((p) => p.startsWith(prefix)).map((p) => p.slice(prefix.length).split("/")[0]));
  if (touched.size > 1) problems.push(`one request is one token, and this changes ${touched.size}`);
  const outside = changed.filter((p) => !p.startsWith("tokens/"));
  if (touched.size > 0 && outside.length > 0) problems.push(`a request changes only its token's folder, not ${outside.join(", ")}`);
  for (const token of tokens) {
    if (!added.has(token.folder)) continue;
    for (const key of REQUEST_ONLY) if (token.info[key] === undefined) problems.push(`${token.where}: ${key} is missing`);
  }
  return { added, problems };
}

// ---------------------------------------------------------------- run

async function main() {
  const args = process.argv.slice(2);
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const baseAt = args.indexOf("--base");
  const base = baseAt === -1 ? null : args[baseAt + 1];
  const offline = args.includes("--offline");

  const all = [];
  let count = 0;
  for (const [network, url] of Object.entries(NETWORKS)) {
    const { tokens, problems } = readTokens(root, network);
    all.push(...problems);
    count += tokens.length;
    let added = new Set();
    if (base) {
      const request = requestProblems(root, network, base, tokens);
      added = request.added;
      all.push(...request.problems);
    }
    if (offline) continue;
    for (const token of tokens) {
      if (problems.some((p) => p.startsWith(`${token.where}: `))) continue;
      all.push(...(await chainProblems(token, process.env.TOKEN_LIST_RPC ?? url, added.has(token.folder))));
    }
  }

  const lines = all.length === 0 ? [`All ${count} tokens pass.`] : ["The token list has problems:", "", ...all.map((p) => `- ${p}`)];
  console.log(lines.join("\n"));
  if (process.env.GITHUB_STEP_SUMMARY) {
    const { appendFileSync } = await import("node:fs");
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n`);
  }
  process.exit(all.length === 0 ? 0 : 1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(2);
  });
}
