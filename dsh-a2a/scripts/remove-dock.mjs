// Remove the composer strip: the members list now lives only in the right column.
//
// Both were rendering the same roster in the same conversation — a one-line strip above
// the composer and a column beside it — so a person saw "3 人 · 张工、李四、王五" twice.
// Two views of one fact is worse than one: it makes the page look like it has more
// information than it does, and it doubles the places a layout bug can appear.
//
// The column won because it is the shape the request asked for and the shape a chat app
// uses: tall, narrow, out of the way until summoned. The strip's only advantage was
// being always visible, and the composer button that opens the column is one click from
// exactly where the strip used to be.
import { readFileSync, writeFileSync } from 'node:fs';

const path = 'E:/dsh-a2a-bus/dsh-a2a/client.js';
let source = readFileSync(path, 'utf8');

if (!source.includes('function MembersDock')) {
  console.log('strip already removed');
  process.exit(0);
}

/** Remove a whole top-level function by name, including its doc comment. */
function removeFunction(name) {
  const marker = `\t\tfunction ${name}(props) {`;
  const at = source.indexOf(marker);
  if (at < 0) throw new Error(`${name} not found`);

  // Walk back over the doc comment that belongs to it.
  let start = at;
  const before = source.lastIndexOf('\t\t/**', at);
  if (before >= 0) {
    const between = source.slice(before, at);
    // Only claim the comment when nothing but whitespace and the comment sits between.
    if (/^\t\t\/\*\*[\s\S]*\*\/\n$/.test(between)) start = before;
  }

  // Find the closing brace at the same indent, respecting nested braces via depth count.
  let depth = 0;
  let index = at;
  let end = -1;
  let seenOpen = false;
  while (index < source.length) {
    const ch = source[index];
    if (ch === '{') {
      depth += 1;
      seenOpen = true;
    } else if (ch === '}') {
      depth -= 1;
      if (seenOpen && depth === 0) {
        end = index + 1;
        break;
      }
    }
    index += 1;
  }
  if (end < 0) throw new Error(`could not find the end of ${name}`);

  source = source.slice(0, start) + source.slice(end).replace(/^\n/, '');
  console.log(`removed ${name}`);
}

removeFunction('MembersDock');

// Its registration wrapper goes too.
const wrapperMarker = '\t\t\t/** Register the members strip above the composer. */';
const wrapperAt = source.indexOf(wrapperMarker);
if (wrapperAt >= 0) {
  const closeMarker = '\n\t\t\t};\n';
  const closeAt = source.indexOf(closeMarker, wrapperAt);
  if (closeAt > wrapperAt) {
    source = source.slice(0, wrapperAt) + source.slice(closeAt + closeMarker.length);
    console.log('removed membersDock registration');
  }
}

// And the injection, with the comment that justified it.
const injectBlock = [
  '\t\t\t// The members strip goes above the composer: it renders whenever a Session is',
  '\t\t\t// open, and it is where the person is when they are about to type a name.',
  '\t\t\t//',
  '\t\t\t// Deliberately NOT `sidebar.right.pane.tab`: that slot is dispatched by tab kind,',
  '\t\t\t// so a registration there stays inert unless something opens a tab of that kind —',
  '\t\t\t// which is a host decision this plugin cannot make.',
  '\t\t\ttry {',
  '\t\t\t\tslots.inject("conversation.input.dock", membersDock);',
  '\t\t\t} catch (error) {',
  '\t\t\t\treportUnavailable("conversation.input.dock inject", error);',
  '\t\t\t}',
].join('\n');

if (!source.includes(injectBlock)) {
  // Fall back to a looser match: the inject call on its own.
  const loose = '\t\t\tslots.inject("conversation.input.dock", membersDock);';
  if (!source.includes(loose)) throw new Error('dock inject not found');
  source = source.replace(loose, '\t\t\tvoid 0;');
  console.log('neutralised dock inject (loose)');
} else {
  source = source.replace(injectBlock, '\t\t\t// Members render in the right column only; see MembersPane.');
  console.log('removed dock inject');
}

// Drop the export.
source = source.replace(/^\t\texports\.MembersDock = MembersDock;\n/m, '');
source = source.replace(/^\t\texports\.MEMBERS_DOCK_ID = MEMBERS_DOCK_ID;\n/m, '');

writeFileSync(path, source, 'utf8');
console.log('strip removed');
