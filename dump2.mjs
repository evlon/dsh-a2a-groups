import { readFileSync } from "node:fs";
const raw = readFileSync("E:/dsh-a2a-bus/sess-unzip/session.v4.jsonl", "utf8");
const rows = [];
for (const line of raw.split("\n")) { const t = line.trim(); if (!t) continue; try { rows.push(JSON.parse(t)); } catch {} }
console.log("records: " + rows.length);
let calls = 0, fails = 0;
const pending = new Map();
for (const r of rows) {
  if (r.type === "tool/call") { calls++; pending.set(r.data.callId, { name: r.data.name, args: r.data.arguments }); continue; }
  if (r.type === "tool/result") {
    const msg = r.data?.message ?? {};
    const failed = msg.isError === true;
    const call = pending.get(msg.toolCallId);
    const label = call === undefined ? "(?)" : call.name;
    const text = (msg.content ?? []).map((c) => String(c.text ?? "")).join(" ").replace(/\n/g, " ").slice(0, 120);
    if (failed) fails++;
    if (failed || ["a2a_group_join","a2a_groups","a2a_group_info"].includes(label)) {
      console.log((failed ? "❌ " : "   ") + label + "  " + String(call?.args ?? "").slice(0, 70));
      console.log("      " + text);
    }
    continue;
  }
  if (r.type === "user/message") {
    for (const p of r.data?.content ?? []) {
      if (p.type === "text" && p.text && !p.text.startsWith("Time sampled") && !p.text.startsWith("Current runtime")) {
        console.log("USER> " + p.text.replace(/\n/g, " ").slice(0, 100));
      }
    }
  }
}
console.log("");
console.log("tool calls: " + calls + "  failures: " + fails);