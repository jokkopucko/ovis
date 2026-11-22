/**
 * A name is never guessed. Only an id that matches one of the patterns below WHOLE gets one,
 * and each pattern is the vendor's own regular id-to-name rule:
 * - Anthropic: `claude-<family>-<major>[-<minor>]` is "Claude <Family> <major>[.<minor>]"
 *   (claude-opus-5-5 is Claude Opus 5.5, claude-sonnet-5 is Claude Sonnet 5, claude-haiku-4-5 is
 *   Claude Haiku 4.5). The pill draws it as Claude Code's own status line does, without the
 *   vendor word ("Opus 5.5"): the agent mark beside it and the agent's read name say whose it is.
 *   The same id behind the vendor's own provider prefix (`anthropic/claude-opus-5-5`, as pi and
 *   omo record it) is the same model.
 * - OpenAI: `gpt-<version>` is "GPT-<version>" (gpt-5.6 is GPT-5.6), and `gpt-<version>-sol` is
 *   "GPT-<version>-Sol", written as Codex's own status line writes it (the "GPT-6-Sol" captured
 *   in server/prompt.test.ts). No other tier word has a source here, so none is named.
 * - Z.ai: `glm-<version>` is "GLM-<version>" (glm-5.3 is GLM-5.3).
 *
 * The patterns follow the vendor's id SYNTAX, not a list of released versions. That was chosen
 * so a new model needs no change here, and its cost is accepted: an id of the right shape for a
 * version that does not exist (claude-opus-9-9, gpt-10) is named too.
 *
 * In return the syntax is read strictly: an id that is not in the vendor's canonical form is not
 * named. A version part is one or two digits with no leading zero (claude-sonnet-5-05, gpt-05.6
 * and glm-5.03 stay ids), a major is never 0, and a minor of 0 is canonical only where the
 * vendor writes one: Anthropic does (claude-opus-4-0), OpenAI and Z.ai write the bare major
 * (gpt-5, not gpt-5.0). The id is lowercase, with nothing before, between or after its parts.
 */
export interface ModelLabel {
  text: string;
  named: boolean;
}

const NUMBER = "[1-9]\\d?";
const CLAUDE = new RegExp(`^(?:anthropic/)?claude-(opus|sonnet|haiku|fable|mythos)-(${NUMBER})(?:-(0|${NUMBER}))?$`, "u");
const GPT = new RegExp(`^gpt-(${NUMBER}(?:\\.${NUMBER})?)(-sol)?$`, "u");
const GLM = new RegExp(`^glm-(${NUMBER}(?:\\.${NUMBER})?)$`, "u");

export function modelLabel(id: string): ModelLabel {
  const claude = CLAUDE.exec(id);
  if (claude) {
    const family = claude[1]!;
    return { text: `${family.charAt(0).toUpperCase()}${family.slice(1)} ${claude[2]}${claude[3] === undefined ? "" : `.${claude[3]}`}`, named: true };
  }
  const gpt = GPT.exec(id);
  if (gpt) return { text: `GPT-${gpt[1]}${gpt[2] === undefined ? "" : "-Sol"}`, named: true };
  const glm = GLM.exec(id);
  if (glm) return { text: `GLM-${glm[1]}`, named: true };
  return { text: id, named: false };
}
