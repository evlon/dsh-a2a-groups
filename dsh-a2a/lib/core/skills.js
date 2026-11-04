/**
 * The skill registry the A2A server dispatches through.
 *
 * A skill is the A2A protocol's unit of capability: it is what the agent card
 * advertises, what a caller names in `message.metadata.skill`, and what the
 * server turns into work. Keeping registration separate from both the server
 * (which knows HTTP and JSON-RPC) and the implementations (which know groups and
 * sessions) means the server can be tested with fake skills and a skill can be
 * tested without a socket.
 *
 * @module dsh-a2a/skills
 */

/**
 * Build the registry.
 *
 * Registration is by id and duplicate ids throw: two skills claiming one id
 * would make a caller's `skill` field ambiguous and the card advertise a
 * capability that dispatches somewhere unpredictable.
 *
 * @returns {{
 *   register: (skill: object) => (() => boolean),
 *   get: (id: string) => any,
 *   list: () => any[],
 *   ids: () => string[],
 * }} the registry. The concrete signatures matter: a bare `Function` is not
 * assignable to a declared call signature, so callers that pass the registry
 * into `createServer()` would each report an error at their own call site.
 */
export function createSkillRegistry() {
  /** @type {Map<string, object>} */
  const skills = new Map();

  const register = (skill) => {
    if (!isPlainObject(skill)) throw new Error('a2a: a skill must be an object');
    const id = skill.id;
    if (typeof id !== 'string' || id === '') throw new Error('a2a: a skill needs a non-empty id');
    if (typeof skill.run !== 'function') throw new Error(`a2a: skill "${id}" needs a run function`);
    if (skills.has(id)) throw new Error(`a2a: skill "${id}" is registered twice`);
    skills.set(id, {
      id,
      name: typeof skill.name === 'string' && skill.name !== '' ? skill.name : id,
      description: typeof skill.description === 'string' ? skill.description : '',
      examples: Array.isArray(skill.examples) ? skill.examples.filter((item) => typeof item === 'string') : [],
      streaming: skill.streaming === true,
      run: skill.run,
    });
    return () => skills.delete(id);
  };

  const get = (id) => skills.get(id);

  /**
   * The card's `skills[]`, i.e. what a caller may name.
   *
   * Only metadata leaves this function — never `run` — because the card is
   * serialized into an HTTP response and a function there would either be
   * dropped silently or, worse, stringified into the wire.
   */
  const list = () => [...skills.values()].map((skill) => ({
    id: skill.id,
    name: skill.name,
    description: skill.description,
    tags: skill.streaming ? ['streaming'] : [],
    examples: skill.examples,
  }));

  const ids = () => [...skills.keys()];

  return { register, get, list, ids };
}

/** Whether a value is a plain JSON object (not an array, not null). */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
