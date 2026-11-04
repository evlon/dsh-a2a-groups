// Give the members pane its own narrow layout instead of reusing the main panel's.
//
// The main panel fills the central column, so `S.root` (padding 16, gap 10, width 100%)
// is right there. In the right column the same style produced a 280px band with 16px of
// padding on each side — roughly 12% of the readable width spent on margin, and member
// rows stretched across a container far wider than their content.
//
// A chat roster wants the opposite shape: tight horizontal padding, a fixed row height,
// and text that truncates rather than wraps. So the pane gets its own style object and a
// max width, which also keeps it from looking stretched on a very wide screen.
import { readFileSync, writeFileSync } from 'node:fs';

const path = 'E:/dsh-a2a-bus/dsh-a2a/client.js';
let source = readFileSync(path, 'utf8');

if (source.includes('membersRoot')) {
  console.log('pane style already applied');
  process.exit(0);
}

function replaceOnce(from, to, label) {
  const at = source.indexOf(from);
  if (at < 0) throw new Error(`anchor missing: ${label}`);
  if (source.indexOf(from, at + 1) >= 0) throw new Error(`anchor not unique: ${label}`);
  source = source.slice(0, at) + to + source.slice(at + from.length);
}

// --- 1. the style block, next to the other styles ----------------------
const styles = [
  '',
  '\t\t/**',
  '\t\t * Layout for the right-column members pane.',
  '\t\t *',
  '\t\t * Deliberately not `S.root`: that one belongs to the central panel, where 16px of',
  '\t\t * padding and full width are correct. In a 280px column the same numbers waste a',
  '\t\t * tenth of the width and let a name wrap onto two lines.',
  '\t\t *',
  '\t\t * `maxWidth` bounds it on a very wide screen: a roster 900px wide would be all',
  '\t\t * whitespace between a name and its role chip.',
  '\t\t */',
  '\t\tconst membersLayout = {',
  '\t\t\troot: {',
  '\t\t\t\tdisplay: "flex",',
  '\t\t\t\tflexDirection: "column",',
  '\t\t\t\tgap: "2px",',
  '\t\t\t\tpadding: "10px 8px",',
  '\t\t\t\theight: "100%",',
  '\t\t\t\tminHeight: "0",',
  '\t\t\t\tmaxWidth: "300px",',
  '\t\t\t\toverflowY: "auto",',
  '\t\t\t\tboxSizing: "border-box",',
  '\t\t\t\tfontSize: "12px"',
  '\t\t\t},',
  '\t\t\theader: {',
  '\t\t\t\tdisplay: "flex",',
  '\t\t\t\talignItems: "baseline",',
  '\t\t\t\tjustifyContent: "space-between",',
  '\t\t\t\tgap: "6px",',
  '\t\t\t\tpaddingBottom: "6px",',
  '\t\t\t\tmarginBottom: "2px",',
  '\t\t\t\tborderBottom: "1px solid var(--dsh-color-border, #2a2f3a)"',
  '\t\t\t},',
  '\t\t\t/* One row: dot, name, role. `minWidth: 0` lets the name truncate instead of',
  '\t\t\t   forcing the row wider than the column. */',
  '\t\t\trow: {',
  '\t\t\t\tdisplay: "flex",',
  '\t\t\t\talignItems: "center",',
  '\t\t\t\tgap: "6px",',
  '\t\t\t\twidth: "100%",',
  '\t\t\t\tminWidth: "0",',
  '\t\t\t\tpadding: "4px 6px",',
  '\t\t\t\tborder: "none",',
  '\t\t\t\tborderRadius: "4px",',
  '\t\t\t\tbackground: "transparent",',
  '\t\t\t\tcolor: "inherit",',
  '\t\t\t\tfont: "inherit",',
  '\t\t\t\tfontSize: "12px",',
  '\t\t\t\ttextAlign: "left",',
  '\t\t\t\tcursor: "pointer"',
  '\t\t\t},',
  '\t\t\t/* The name is the only flexible cell, so it absorbs the shrinkage. */',
  '\t\t\tname: {',
  '\t\t\t\tflex: "1 1 auto",',
  '\t\t\t\tminWidth: "0",',
  '\t\t\t\toverflow: "hidden",',
  '\t\t\t\ttextOverflow: "ellipsis",',
  '\t\t\t\twhiteSpace: "nowrap"',
  '\t\t\t},',
  '\t\t\trole: {',
  '\t\t\t\tflex: "0 0 auto",',
  '\t\t\t\tfontSize: "11px",',
  '\t\t\t\topacity: 0.6',
  '\t\t\t},',
  '\t\t\tdot: {',
  '\t\t\t\twidth: "6px",',
  '\t\t\t\theight: "6px",',
  '\t\t\t\tborderRadius: "50%",',
  '\t\t\t\tflex: "0 0 auto"',
  '\t\t\t},',
  '\t\t\tfooter: {',
  '\t\t\t\tmarginTop: "auto",',
  '\t\t\t\tpaddingTop: "8px",',
  '\t\t\t\tborderTop: "1px solid var(--dsh-color-border, #2a2f3a)"',
  '\t\t\t}',
  '\t\t};',
  '',
].join('\n');

replaceOnce('\t\t/**\n\t\t * Members of the group the current Session belongs to', styles + '\t\t/**\n\t\t * Members of the group the current Session belongs to', 'style block');

writeFileSync(path, source, 'utf8');
console.log('membersLayout added');
