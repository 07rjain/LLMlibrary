# Agent Instructions And Skills

`unified-llm-client/agent-files` helps agent-building apps load repo-local `agent.md` / `AGENTS.md` instructions and user-provided skills from disk, then compose them into the `system` prompt used by `LLMClient`.

This entry point is Node-only because it reads the filesystem. Do not import it from browser or edge-runtime code.

## File Layout

A typical agent folder can look like this:

```text
my-agent/
├── agent.md
└── .agents/
    └── skills/
        └── grumpy-engineer/
            └── SKILL.md
```

`agent.md` is the agent's main instruction file. Skills are stored under `.agents/skills/{skill-name}/SKILL.md`.

## Create `agent.md`

Use `agent.md` for durable instructions that should apply whenever this agent runs:

```md
# Senior Next.js Production Engineer Agent

You are a senior software engineer working on a Next.js application that serves millions of users.

Prioritize correctness, latency, reliability, security, accessibility, observability, and maintainability.

When reviewing code, lead with production risks and include the smallest practical fix.
```

By default, `loadAgentInstructions()` looks for these filenames in order:

1. `AGENTS.override.md`
2. `AGENTS.md`
3. `agent.md`
4. `Agent.md`

The loader walks from the resolved root to `cwd`, so a root `AGENTS.md` can provide shared repository policy while a nested `agent.md` provides agent-specific behavior.

## Create A Skill

Each skill needs a `SKILL.md` with YAML frontmatter:

```md
---
name: grumpy-engineer
description: Use for blunt senior software engineering code review of production applications.
disable-model-invocation: true
---

# Grumpy Software Engineer Code Review

Review code as if it is about to serve millions of users.

Start with showstoppers:

- The app cannot build, start, route, render, or deploy.
- Imports, exports, environment loading, or package boundaries are broken.
- User data, credentials, auth, tenant isolation, or server-only code can leak.
- Core flows are mocked, stubbed, TODO-driven, or inconsistent with docs.

For each finding, include severity, evidence, production impact, and the smallest practical fix.
```

Required frontmatter:

- `name`: stable skill id used by your app for selection.
- `description`: short text your app can show to users or use for matching.

Optional frontmatter:

- `disable-model-invocation: true`: metadata for your app. The library parses and exposes this as `disableModelInvocation`, but it does not enforce behavior by itself.
- Any other keys are preserved in the manifest `metadata` map.

## Load Instructions And Skills

```ts
import { LLMClient } from 'unified-llm-client';
import {
  composeAgentSystemPrompt,
  discoverSkills,
  loadAgentInstructions,
  loadSkill,
} from 'unified-llm-client/agent-files';

const cwd = '/path/to/my-agent';

const instructions = await loadAgentInstructions({ cwd });
const skillManifests = await discoverSkills({ cwd });

const selectedManifest = skillManifests.find(
  (skill) => skill.name === 'grumpy-engineer',
);

const selectedSkills = selectedManifest
  ? [await loadSkill(selectedManifest)]
  : [];

const system = composeAgentSystemPrompt({
  baseSystem: 'You are a focused coding agent.',
  instructions,
  skills: selectedSkills,
});

const client = LLMClient.fromEnv({ defaultModel: 'gpt-4o' });
const conversation = await client.conversation({ system });

const response = await conversation.send('Review this pull request.');
```

`discoverSkills()` reads only skill frontmatter. Full skill bodies are loaded only when your app calls `loadSkill()`.

## Select Skills In Your App

The library intentionally does not auto-select skills. Your application should decide which skills are active.

Common selection patterns:

- User chooses skills in an agent-builder UI.
- Agent config stores a list of allowed skill names.
- A router matches the user's task to a skill description.
- Workspace policy disables skills with unsafe metadata.

Example:

```ts
const allowedSkillNames = new Set(['grumpy-engineer', 'nextjs-release-review']);

const selectedSkills = await Promise.all(
  skillManifests
    .filter((skill) => allowedSkillNames.has(skill.name))
    .map((skill) => loadSkill(skill)),
);
```

## Use `disable-model-invocation`

`disable-model-invocation` is parsed as metadata:

```ts
for (const skill of skillManifests) {
  if (skill.disableModelInvocation) {
    console.log(`${skill.name} should not trigger a standalone model call`);
  }
}
```

This is useful when a skill should only contribute instructions to an already-running agent, not cause your app to call a model on its own. Enforcement belongs in your application because only your application knows when model calls are allowed.

## Isolate An Agent Root

By default, the loader searches upward until it finds `.git`, then walks from that root to `cwd`. If you want an agent folder to be isolated from repository-level instructions, pass `root`:

```ts
const agentRoot = '/path/to/my-agent';

const instructions = await loadAgentInstructions({
  cwd: agentRoot,
  root: agentRoot,
});

const skills = await discoverSkills({
  cwd: agentRoot,
  root: agentRoot,
});
```

Use this for hosted agent builders where every agent folder should be self-contained.

## Restrict Instruction Filenames

If your product only wants to support `agent.md`, pass `filenames`:

```ts
const instructions = await loadAgentInstructions({
  cwd,
  filenames: ['agent.md'],
});
```

If your product only wants repo-policy files, restrict to `AGENTS.override.md` and `AGENTS.md`.

## Safety Notes

- Treat `agent.md` and `SKILL.md` as untrusted user content unless your app controls the filesystem.
- The library does not execute scripts from skills.
- The library does not recursively load skill references or assets.
- The library does not call a model while discovering skills.
- Keep skill selection explicit and auditable.
- Do not include secrets in `agent.md` or `SKILL.md`.
- Keep filesystem loading on a trusted Node server, not in browser or edge code.

## Test A Fixture Locally

You can test a fixture by loading it and checking the composed prompt:

```ts
import {
  composeAgentSystemPrompt,
  discoverSkills,
  loadAgentInstructions,
  loadSkill,
} from 'unified-llm-client/agent-files';

const cwd = 'test/prompt_caching_test_droid/senior-nextjs-agent';

const instructions = await loadAgentInstructions({ cwd, root: cwd });
const skills = await Promise.all(
  (await discoverSkills({ cwd, root: cwd })).map((skill) => loadSkill(skill)),
);

const system = composeAgentSystemPrompt({
  baseSystem: 'Fixture verification.',
  instructions,
  skills,
});

console.log(system.includes('Senior Next.js Production Engineer Agent'));
console.log(system.includes('Grumpy Software Engineer Code Review'));
```
