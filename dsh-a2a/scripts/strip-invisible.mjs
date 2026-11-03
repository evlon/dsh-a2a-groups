import { readFileSync, writeFileSync } from "node:fs";

const path = process.argv[2];
if (!path) {
	console.error("usage: node scripts/strip-invisible.mjs <file>");
	process.exit(2);
}

const bad = /[\u200B-\u200F\u2060\uFEFF\u00AD]/g;
const source = readFileSync(path, "utf8");
const before = (source.match(bad) || []).length;
const cleaned = source.replace(bad, "");
if (cleaned !== source) writeFileSync(path, cleaned, "utf8");
const after = (cleaned.match(bad) || []).length;
console.log(`invisible chars: ${String(before)} removed, ${String(after)} remaining`);

const idMatch = cleaned.match(/id:\s*"([^"]*)"/);
if (idMatch) {
	const id = idMatch[1];
	console.log(`id literal: ${JSON.stringify(id)} codepoints=${[...id].map((c) => c.codePointAt(0)).join(",")}`);
}
const requires = [...cleaned.matchAll(/require\("([^"]*)"\)/g)].map((m) => m[1]);
console.log(`requires: ${JSON.stringify(requires)}`);
const globals = [...cleaned.matchAll(/__[A-Z]+_[A-Z0-9_]+__/g)].map((m) => m[0]);
console.log(`globals seen: ${JSON.stringify([...new Set(globals)])}`);
const nonAscii = [...new Set(cleaned)].filter((c) => c.codePointAt(0) > 0x7f);
console.log(`non-ascii code points in file: ${nonAscii.map((c) => "U+" + c.codePointAt(0).toString(16).toUpperCase()).join(" ")}`);
