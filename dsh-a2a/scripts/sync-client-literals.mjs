/**
 * Keep the documented literals in `lib/types/client.d.ts` byte-identical to the
 * ones `client.js` actually uses. Written as a script because these strings are
 * easy to mistype and a single stray character silently breaks the Host seam.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLIENT = join(ROOT, "client.js");
const TYPES = join(ROOT, "lib", "types", "client.d.ts");

const source = readFileSync(CLIENT, "utf8");

function literal(name) {
	const match = source.match(new RegExp(`const ${name} = "([^"]*)"`));
	if (match === null) throw new Error(`client.js does not define ${name}`);
	return match[1];
}

const PANEL_ID = literal("PANEL_ID");
const GLOBAL_KEY = literal("GLOBAL_KEY");
const CHANGE_EVENT = literal("CHANGE_EVENT");

let types = readFileSync(TYPES, "utf8");
const replacements = [
	[/export declare const PANEL_ID: "[^"]*";/, `export declare const PANEL_ID: ${JSON.stringify(PANEL_ID)};`],
	[/export declare const GLOBAL_KEY: "[^"]*";/, `export declare const GLOBAL_KEY: ${JSON.stringify(GLOBAL_KEY)};`],
	[/export declare const CHANGE_EVENT: "[^"]*";/, `export declare const CHANGE_EVENT: ${JSON.stringify(CHANGE_EVENT)};`],
];
for (const [pattern, replacement] of replacements) {
	if (!pattern.test(types)) throw new Error(`client.d.ts is missing ${String(pattern)}`);
	types = types.replace(pattern, replacement);
}
writeFileSync(TYPES, types, "utf8");

for (const [name, value] of [
	["PANEL_ID", PANEL_ID],
	["GLOBAL_KEY", GLOBAL_KEY],
	["CHANGE_EVENT", CHANGE_EVENT],
]) {
	console.log(`${name} = ${JSON.stringify(value)} codepoints=${[...value].map((char) => char.codePointAt(0)).join(",")}`);
}
console.log("client.d.ts literals synchronized with client.js");
