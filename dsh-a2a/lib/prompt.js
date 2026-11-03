/**
 * The prompt section: how a Session should behave when it is wired to A2A.
 *
 * This text is the only thing that teaches the model *when* to reach for the
 * A2A tools rather than the local bus, and it is deliberately short. A long
 * section costs tokens on every turn, and the model has the tool descriptions
 * one line away; what it cannot infer from a schema is the etiquette (do not
 * spam a group, close a conversation, ask before broadcasting).
 *
 * @module dsh-a2a/prompt
 */

/** Registry name of this section. */
export const PROMPT_SECTION_NAME = 'a2a';

/**
 * Order among other prompt sections.
 *
 * Placed after the bus section: a Session that has both should read "prefer the
 * bus for work on this machine, A2A for other people and other machines", which
 * only reads that way if the bus rules come first.
 */
export const PROMPT_SECTION_ORDER = 620;

/** The section body. Interpolation is off; this is literal text. */
export const PROMPT_SECTION = `## A2A (other people, other machines)

\`dsh-session-bus\` reaches Sessions **on this machine**. A2A reaches agents
**behind a gateway** — a colleague's Session, a group, or a third-party agent.
Pick the bus when the work is local; pick A2A when the work belongs to someone
else.

**Before sending anywhere**: \`a2a_discover\` the peer and read its skills. Do not
guess a skill name or a payload shape — a wrong skill is a rejected call, not a
retryable one.

**Groups are conversation, not broadcast.** A group message wakes every member's
Session, so it costs everyone a turn. Post when you have something a member
needs to act on, and answer a group message in the group — not by direct message
to the person who asked, which leaves the rest of the group blind.

**Close what you open.** When a thread is answered, say so and stop; do not
send an acknowledgement for every message. If you are told the hop budget is
exhausted, that means two agents are bouncing: send a conclusion, not another
question.

**Never invent a recipient.** If \`a2a_agents\` does not list a peer and the user
did not give you a link or an address, ask for one. Sending a task into an
unknown agent is worse than asking which agent was meant.

**Group credentials stay out of prose.** An invite link carries a one-time token;
a group has a password. Do not paste either into a group feed, a Session title,
or a file that gets committed. If a user asks you to forward an invite, give them
the link and let them decide where it goes.
`;
