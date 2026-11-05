import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { checksum, decodeString, keccak256, lookalike, pngProblem, readTokens, svgProblem } from "./check.mjs";

const svg = (inner, open = 'xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"') => Buffer.from(`<svg ${open}>${inner}</svg>`);
const GOOD_SVG = svg('<circle cx="16" cy="16" r="16" fill="#000"/>');

function png(width, height) {
  const bytes = Buffer.alloc(40);
  Buffer.from("89504e470d0a1a0a", "hex").copy(bytes);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "latin1");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

describe("addresses", () => {
  it("keccak256 is keccak, not sha3", () => {
    assert.equal(Buffer.from(keccak256(Buffer.alloc(0))).toString("hex"), "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
    assert.equal(Buffer.from(keccak256(Buffer.from("abc"))).toString("hex"), "4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45");
    assert.equal(Buffer.from(keccak256(Buffer.alloc(136, 1))).length, 32);
  });

  it("checksums as EIP-55 does", () => {
    for (const address of ["0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed", "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359", "0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB"]) {
      assert.equal(checksum(address.toLowerCase()), address);
    }
  });
});

describe("svg logos", () => {
  it("passes a plain drawing", () => {
    assert.equal(svgProblem(GOOD_SVG), null);
    assert.equal(svgProblem(svg('<defs><linearGradient id="a"><stop offset="0"/></linearGradient></defs><path fill="url(#a)" d="M0 0"/>')), null);
    assert.equal(svgProblem(Buffer.from(`<?xml version="1.0"?>${GOOD_SVG}`)), null);
  });

  const hostile = [
    ["a script", svg("<script>alert(1)</script>")],
    ["a script in upper case", svg("<SCRIPT>alert(1)</SCRIPT>")],
    ["a namespaced script", svg('<x:script xmlns:x="http://www.w3.org/2000/svg">alert(1)</x:script>')],
    ["an event handler", svg('<circle onload="alert(1)"/>')],
    ["an event handler on the root", svg("", 'viewBox="0 0 32 32" onload="alert(1)"')],
    ["an event handler in upper case", svg('<circle ONCLICK="alert(1)"/>')],
    ["an event handler in single quotes", svg("<circle onload='alert(1)'/>")],
    ["foreign content", svg('<foreignObject><iframe src="https://evil.example"/></foreignObject>')],
    ["an image", svg('<image href="https://evil.example/x.png"/>')],
    ["a link", svg('<a href="https://evil.example"><circle/></a>')],
    ["a use of another file", svg('<use href="https://evil.example/x.svg#a"/>')],
    ["an xlink", svg('<path xlink:href="https://evil.example/"/>')],
    ["a style sheet", svg("<style>@import url(https://evil.example/x.css);</style>")],
    ["a style attribute", svg('<circle style="fill:url(https://evil.example/)"/>')],
    ["an outside fill", svg('<circle fill="url(https://evil.example/x)"/>')],
    ["a javascript value", svg('<circle fill="javascript:alert(1)"/>')],
    ["an entity", Buffer.from('<!DOCTYPE svg [<!ENTITY x "y">]><svg viewBox="0 0 32 32">&x;</svg>')],
    ["an encoded handler", svg('<circle fill="&#106;avascript:alert(1)"/>')],
    ["a comment hiding markup", svg("<!-- --><script>alert(1)</script><!-- -->")],
    ["a CDATA section", svg("<![CDATA[<script>alert(1)</script>]]>")],
    ["a processing instruction", svg('<?xml-stylesheet href="https://evil.example/x.css"?>')],
    ["html instead", Buffer.from("<html><script>alert(1)</script></html>")],
    ["not UTF-8", Buffer.from([0xff, 0xfe, 0x3c, 0x00])],
    ["no viewBox", svg("", 'xmlns="http://www.w3.org/2000/svg"')],
    ["a viewBox that is not square", svg("", 'viewBox="0 0 32 16"')],
  ];
  for (const [what, bytes] of hostile) {
    it(`refuses ${what}`, () => assert.notEqual(svgProblem(bytes), null));
  }
});

describe("png logos", () => {
  it("passes a square of at least 256", () => {
    assert.equal(pngProblem(png(256, 256)), null);
    assert.equal(pngProblem(png(512, 512)), null);
  });
  it("refuses anything else", () => {
    assert.match(pngProblem(png(255, 255)), /under 256/);
    assert.match(pngProblem(png(256, 300)), /not square/);
    assert.match(pngProblem(Buffer.from("<svg>not a png at all, but long enough to read</svg>")), /not a PNG/);
  });
});

describe("the list", () => {
  const roots = [];
  after(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));
  const USDC = "0xD19d2Ffb1c284668b7AFe72cddae1BAF3Bc03925";
  const WDOGE = "0xF6BDB158A5ddF77F1B83bC9074F6a472c58D78aE";
  const info = (overrides = {}) => ({ address: USDC, name: "USD Coin", symbol: "USDC", decimals: 18, logoSource: "Circle, used with permission", ...overrides });

  function list(tokens) {
    const root = mkdtempSync(join(tmpdir(), "token-list-"));
    roots.push(root);
    mkdirSync(join(root, "tokens/dogeos-testnet"), { recursive: true });
    for (const token of tokens) {
      const dir = join(root, "tokens/dogeos-testnet", token.folder ?? token.info.address.toLowerCase());
      mkdirSync(dir);
      writeFileSync(join(dir, "info.json"), token.raw ?? JSON.stringify(token.info));
      for (const [file, bytes] of Object.entries(token.files ?? { "logo.svg": GOOD_SVG })) writeFileSync(join(dir, file), bytes);
    }
    return root;
  }
  const problems = (tokens) => readTokens(list(tokens), "dogeos-testnet").problems.join("\n");

  it("passes a good token", () => {
    assert.equal(problems([{ info: info() }]), "");
  });

  const wrong = [
    ["an address that is not checksummed", { address: USDC.toLowerCase() }, /checksummed/],
    ["a name with lookalike letters", { name: "USD Соin" }, /name must/],
    ["a name that could break out of the generated file", { name: 'x"\nlogo = "../../etc' }, /name must/],
    ["a symbol with a path in it", { symbol: "../USDC" }, /symbol must/],
    ["silly decimals", { decimals: 99 }, /decimals/],
    ["no logo source", { logoSource: undefined }, /logoSource is missing/],
    ["a tag that is not known", { tags: ["verified"] }, /tags can only/],
    ["an unknown field", { badge: true }, /unknown field/],
    ["a website that is not https", { website: "javascript:alert(1)" }, /website must/],
  ];
  for (const [what, fields, reason] of wrong) {
    it(`refuses ${what}`, () => assert.match(problems([{ folder: USDC.toLowerCase(), info: info(fields) }]), reason));
  }

  it("refuses a folder that is not the address", () => {
    assert.match(problems([{ folder: "usdc", info: info() }]), /address in lower case/);
    assert.match(problems([{ folder: WDOGE.toLowerCase(), info: info() }]), /not the folder's/);
  });

  it("refuses extra files, two logos, and none", () => {
    assert.match(problems([{ info: info(), files: { "logo.svg": GOOD_SVG, "run.sh": "x" } }]), /unexpected file run.sh/);
    assert.match(problems([{ info: info(), files: { "logo.svg": GOOD_SVG, "logo.png": png(256, 256) } }]), /exactly one logo/);
    assert.match(problems([{ info: info(), files: {} }]), /exactly one logo/);
  });

  it("refuses a logo over the size limit, and a bad one", () => {
    assert.match(problems([{ info: info(), files: { "logo.png": Buffer.concat([png(256, 256), Buffer.alloc(101 * 1024)]) } }]), /over 100 KB/);
    assert.match(problems([{ info: info(), files: { "logo.svg": svg("<script>1</script>") } }]), /cannot be used/);
  });

  it("refuses a link in place of a file", () => {
    const root = list([{ info: info(), files: {} }]);
    symlinkSync("/etc/passwd", join(root, "tokens/dogeos-testnet", USDC.toLowerCase(), "logo.png"));
    assert.match(readTokens(root, "dogeos-testnet").problems.join("\n"), /not a plain file/);
  });

  it("refuses broken JSON", () => {
    assert.match(problems([{ folder: USDC.toLowerCase(), raw: "{", info: info() }]), /not JSON/);
  });

  const other = (overrides) => ({ info: info({ address: WDOGE, name: "Wrapped Doge", symbol: "WDOGE", ...overrides }), files: { "logo.svg": svg('<rect width="1"/>') } });

  it("refuses a copycat's symbol, name or logo", () => {
    assert.equal(problems([{ info: info() }, other()]), "");
    assert.match(problems([{ info: info() }, other({ symbol: "usdc" })]), /symbol usdc/);
    assert.match(problems([{ info: info() }, other({ symbol: "U.S.D.C" })]), /symbol U.S.D.C/);
    assert.match(problems([{ info: info() }, other({ name: "usd coin" })]), /name usd coin/);
    assert.match(problems([{ info: info() }, { ...other(), files: { "logo.svg": GOOD_SVG } }]), /this logo/);
  });

  it("reads lookalike symbols as one", () => {
    assert.equal(lookalike("WD0GE"), lookalike("WDOGE"));
    assert.equal(lookalike("USD1"), lookalike("USDl"));
    assert.notEqual(lookalike("USDC"), lookalike("USDT"));
  });
});

describe("chain answers", () => {
  it("decodes a string, and refuses nonsense instead of crashing", () => {
    const encoded = `0x${"20".padStart(64, "0")}${"4".padStart(64, "0")}${Buffer.from("USDC").toString("hex").padEnd(64, "0")}`;
    assert.equal(decodeString(encoded), "USDC");
    assert.equal(decodeString("0x"), null);
    assert.equal(decodeString(`0x${"ff".repeat(32)}${"00".repeat(32)}`), null);
  });
});
