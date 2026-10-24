// Skills on demand: with many installed skills, pi's prompt index (name + description of each) costs ~100k tokens a
// turn. Past SKILL_INDEX_LIMIT the index leaves the prompt and the model looks skills up with find_skill instead.
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const SKILL_INDEX_LIMIT = 30;

export interface SkillInfo {
  name: string;
  description: string;
  filePath: string;
  disableModelInvocation?: boolean;
}

/** Skills ranked by how many query words hit their name (weighted) or description. */
export function searchSkills(skills: SkillInfo[], query: string, limit = 8): SkillInfo[] {
  const words = query.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1);
  return skills
    .map((skill) => {
      const name = skill.name.toLowerCase();
      const description = skill.description.toLowerCase();
      const score = words.reduce((sum, w) => sum + (name.includes(w) ? 3 : 0) + (description.includes(w) ? 1 : 0), 0);
      return { skill, score };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((r) => r.skill);
}

export function registerSkillSearch(pi: ExtensionAPI): void {
  let hidden: SkillInfo[] = [];

  pi.registerTool(
    defineTool({
      name: "find_skill",
      label: "Find skill",
      description:
        "Search the installed skills (specialized instructions for kinds of tasks) by topic. Returns matching skills with the path of their SKILL.md; read that file to use one.",
      promptSnippet: "find_skill: look up installed skills for the task at hand",
      parameters: Type.Object({ query: Type.String({ description: "Task topic, e.g. 'pdf forms' or 'react native upgrade'" }) }),
      async execute(_id, p) {
        const found = searchSkills(hidden, p.query);
        const text = hidden.length === 0
          ? "All skills are already listed in the system prompt."
          : found.length === 0
            ? `No skill matches "${p.query}". Continue without one.`
            : found.map((s) => `${s.name}: ${s.description}\n  ${s.filePath}`).join("\n");
        return { content: [{ type: "text" as const, text }], details: undefined };
      },
    }),
  );

  pi.on("before_agent_start", (event) => {
    const options = event.systemPromptOptions;
    const visible = options.skills.filter((s) => !s.disableModelInvocation);
    if (visible.length <= SKILL_INDEX_LIMIT) {
      hidden = [];
      return;
    }
    hidden = visible;
    options.skills = [];
    options.sections.skills =
      `${visible.length} skills (specialized instructions) are installed but not listed here. When a task could use one ` +
      "(a framework, file format, workflow or service), call find_skill with its topic first, then read the SKILL.md it returns.";
  });
}
