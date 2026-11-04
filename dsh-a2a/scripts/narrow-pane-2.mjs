// Rewrite MembersPane's two render paths onto membersLayout.
//
// The old markup repeated a 12-property inline style per row and used `S.header` /
// `S.chip` from the main panel, which were sized for a full-width page. Rows also
// lacked `minWidth: 0`, so a long name pushed the row wider than the column instead of
// truncating — the actual reason the pane looked too wide.
import { readFileSync, writeFileSync } from 'node:fs';

const path = 'E:/dsh-a2a-bus/dsh-a2a/client.js';
const lines = readFileSync(path, 'utf8').split('\n');

const startAt = lines.findIndex((line) => line.includes('function MembersPane(props) {'));
if (startAt < 0) throw new Error('MembersPane not found');

// Walk forward counting braces from the opening brace of the function.
let depth = 0;
let seenOpen = false;
let endAt = -1;
for (let index = startAt; index < lines.length; index += 1) {
  for (const ch of lines[index]) {
    if (ch === '{') {
      depth += 1;
      seenOpen = true;
    } else if (ch === '}') {
      depth -= 1;
      if (seenOpen && depth === 0) {
        endAt = index;
        break;
      }
    }
  }
  if (endAt >= 0) break;
}
if (endAt < 0) throw new Error('MembersPane end not found');

const body = `		function MembersPane(props) {
			const snapshot = useSnapshot();
			const sessionId = props !== null && props !== undefined ? pickString(props.sessionId) : "";

			// Which group this Session belongs to. A Session can hold several; the pane shows
			// the one with the most recent activity, because that is the one being worked in.
			const candidates = snapshot.groups.filter(function (group) {
				if (group.discovered === true) return false;
				if (sessionId === "") return true;
				return group.sessionId === "" || group.sessionId === sessionId;
			});
			candidates.sort(function (left, right) {
				return (right.lastTime || 0) - (left.lastTime || 0);
			});
			const group = candidates[0];

			/** Insert \`@name \` into the composer through the owner's two-step API. */
			function address(member) {
				insertMention(props !== null && props !== undefined ? props.inputActions : undefined, member.name);
			}

			if (group === undefined) {
				return h(
					"div",
					{ style: membersLayout.root },
					h(
						"div",
						{ style: membersLayout.header },
						h("span", { style: S.sectionLabel }, "群成员")
					),
					h("p", { style: S.emptyBody }, "这个会话还没有加入协作群。")
				);
			}

			const members = group.members;
			const countLine = String(group.memberCount || members.length) + " 人"
				+ (group.onlineCount > 0 ? " · " + String(group.onlineCount) + " 在线" : "")
				+ (members.length === 0 ? "（名单需在会话里查一次）" : "");

			return h(
				"div",
				{ style: membersLayout.root },
				h(
					"div",
					{ style: membersLayout.header },
					h("span", { style: S.sectionLabel }, "群成员"),
					h("span", { style: membersLayout.role }, countLine)
				),
				h(
					"p",
					{ style: { margin: "0 0 4px", fontSize: "11px", opacity: 0.7, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
					group.name
				),
				members.length === 0
					? null
					: h(
							"div",
							{ style: { display: "flex", flexDirection: "column" } },
							members.map(function (member) {
								return h(
									"button",
									{
										key: member.id,
										type: "button",
										title: "点击在输入框里 @ " + member.name,
										style: membersLayout.row,
										onClick: function () {
											address(member);
										}
									},
									h("span", {
										style: Object.assign({}, membersLayout.dot, {
											background: member.online
												? "var(--dsh-color-success, #3fb950)"
												: "var(--dsh-color-border, #555)"
										})
									}),
									h("span", { style: membersLayout.name }, member.name),
									member.role === "owner" ? h("span", { style: membersLayout.role }, "群主") : null
								);
							})
						),
				h(
					"div",
					{ style: membersLayout.footer },
					h(
						"button",
						{
							type: "button",
							title: "点击 @ 所有人",
							style: Object.assign({}, membersLayout.row, {
								justifyContent: "center",
								border: "1px dashed var(--dsh-color-border, #444)"
							}),
							onClick: function () {
								address({ name: "所有人" });
							}
						},
						"@ 所有人"
					)
				)
			);
		}`;

lines.splice(startAt, endAt - startAt + 1, ...body.split('\n'));
writeFileSync(path, lines.join('\n'), 'utf8');
console.log('MembersPane rewritten on membersLayout');
