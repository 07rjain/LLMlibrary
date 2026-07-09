import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LLMClient } from '../src/client.js';
import { InMemorySessionStore } from '../src/session-store.js';
import {
  AgentFilesError,
  composeAgentSystemPrompt,
  discoverSkills,
  loadAgentInstructions,
  loadSkill,
} from '../src/agent-files.js';
import { loadEnv } from './prompt_caching_test_droid/helpers.js';

import type { ConversationSnapshot } from '../src/conversation.js';

loadEnv();

describe('agent file helpers', () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'agent-files-'));
    await mkdir(join(workspace, '.git'));
  });

  afterEach(async () => {
    await rm(workspace, { force: true, recursive: true });
  });

  it('loads AGENTS files from root to cwd and lets override files win per directory', async () => {
    const serviceDir = join(workspace, 'services', 'api');
    await mkdir(serviceDir, { recursive: true });
    await writeFile(join(workspace, 'AGENTS.md'), 'Use pnpm.\n');
    await writeFile(join(workspace, 'services', 'AGENTS.md'), 'Base service instructions.\n');
    await writeFile(join(workspace, 'services', 'AGENTS.override.md'), 'Override service instructions.\n');
    await writeFile(join(serviceDir, 'AGENTS.md'), 'API instructions.\n');

    const instructions = await loadAgentInstructions({ cwd: serviceDir });

    expect(instructions.root).toBe(workspace);
    expect(instructions.files.map((file) => file.path)).toEqual([
      join(workspace, 'AGENTS.md'),
      join(workspace, 'services', 'AGENTS.override.md'),
      join(serviceDir, 'AGENTS.md'),
    ]);
    expect(instructions.content).toBe(
      'Use pnpm.\n\nOverride service instructions.\n\nAPI instructions.',
    );
  });

  it('loads lowercase agent.md aliases for agent builders', async () => {
    const agentDir = join(workspace, 'agents', 'support');
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(workspace, 'AGENTS.md'), 'Root instructions.');
    await writeFile(join(agentDir, 'agent.md'), 'Support agent instructions.');

    const instructions = await loadAgentInstructions({ cwd: agentDir });

    expect(instructions.files.map((file) => file.path)).toEqual([
      join(workspace, 'AGENTS.md'),
      join(agentDir, 'agent.md'),
    ]);
    expect(instructions.content).toBe(
      'Root instructions.\n\nSupport agent instructions.',
    );
  });

  it('lets callers restrict instruction filenames when they only want AGENTS.md', async () => {
    await writeFile(join(workspace, 'agent.md'), 'Ignored alias.');

    const instructions = await loadAgentInstructions({
      cwd: workspace,
      filenames: ['AGENTS.override.md', 'AGENTS.md'],
    });

    expect(instructions.files).toEqual([]);
  });

  it('returns empty instructions when no AGENTS files exist', async () => {
    const instructions = await loadAgentInstructions({ cwd: workspace });

    expect(instructions.files).toEqual([]);
    expect(instructions.content).toBe('');
  });

  it('enforces the AGENTS byte limit across loaded files', async () => {
    await writeFile(join(workspace, 'AGENTS.md'), '12345');

    await expect(loadAgentInstructions({ cwd: workspace, maxBytes: 4 })).rejects.toThrow(
      AgentFilesError,
    );
  });

  it('discovers skill metadata without loading references or scripts', async () => {
    const skillDir = join(workspace, '.agents', 'skills', 'release-npm');
    await mkdir(join(skillDir, 'references'), { recursive: true });
    await writeFile(
      join(skillDir, 'SKILL.md'),
      [
        '---',
        'name: release-npm',
        'description: Publish package releases.',
        '---',
        '',
        'Run release steps.',
      ].join('\n'),
    );
    await writeFile(join(skillDir, 'references', 'extra.md'), 'Not loaded.');

    const skills = await discoverSkills({ cwd: workspace });

    expect(skills).toEqual([
      {
        description: 'Publish package releases.',
        directory: skillDir,
        metadata: {
          description: 'Publish package releases.',
          name: 'release-npm',
        },
        name: 'release-npm',
        path: join(skillDir, 'SKILL.md'),
      },
    ]);
  });

  it('loads a selected skill body explicitly', async () => {
    const skillDir = join(workspace, '.agents', 'skills', 'security-review');
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, 'SKILL.md'),
      [
        '---',
        'name: security-review',
        'description: Review security-sensitive changes.',
        '---',
        '',
        'Check tenant isolation and SSRF controls.',
      ].join('\n'),
    );

    const [manifest] = await discoverSkills({ cwd: workspace });
    const skill = await loadSkill(manifest!);

    expect(skill).toMatchObject({
      body: 'Check tenant isolation and SSRF controls.',
      description: 'Review security-sensitive changes.',
      directory: skillDir,
      metadata: {
        description: 'Review security-sensitive changes.',
        name: 'security-review',
      },
      name: 'security-review',
      path: join(skillDir, 'SKILL.md'),
    });
  });

  it('preserves optional skill frontmatter metadata', async () => {
    const skillDir = join(workspace, '.agents', 'skills', 'grumpy-engineer');
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, 'SKILL.md'),
      [
        '---',
        'name: grumpy-engineer',
        'description: Blunt production code review.',
        'disable-model-invocation: true',
        'owner: platform',
        '---',
        '',
        'Review production risks with evidence.',
      ].join('\n'),
    );

    const [manifest] = await discoverSkills({ cwd: workspace });
    const skill = await loadSkill(manifest!);

    expect(manifest).toMatchObject({
      disableModelInvocation: true,
      metadata: {
        description: 'Blunt production code review.',
        'disable-model-invocation': 'true',
        name: 'grumpy-engineer',
        owner: 'platform',
      },
    });
    expect(skill).toMatchObject({
      body: 'Review production risks with evidence.',
      disableModelInvocation: true,
      metadata: {
        'disable-model-invocation': 'true',
        owner: 'platform',
      },
    });
  });

  it('parses false and preserves invalid disable-model-invocation metadata values', async () => {
    const falseSkillDir = join(workspace, '.agents', 'skills', 'model-enabled');
    const invalidSkillDir = join(workspace, '.agents', 'skills', 'invalid-toggle');
    await mkdir(falseSkillDir, { recursive: true });
    await mkdir(invalidSkillDir, { recursive: true });
    await writeFile(
      join(falseSkillDir, 'SKILL.md'),
      [
        '---',
        'name: model-enabled',
        'description: Allows model invocation.',
        'disable-model-invocation: false',
        '---',
        '',
        'Use the model normally.',
      ].join('\n'),
    );
    await writeFile(
      join(invalidSkillDir, 'SKILL.md'),
      [
        '---',
        'name: invalid-toggle',
        'description: Has a malformed toggle.',
        'disable-model-invocation: sometimes',
        '---',
        '',
        'Preserve the raw metadata.',
      ].join('\n'),
    );

    const skills = await discoverSkills({ cwd: workspace });
    const invalid = skills.find((skill) => skill.name === 'invalid-toggle');
    const modelEnabled = skills.find((skill) => skill.name === 'model-enabled');

    expect(modelEnabled).toMatchObject({
      disableModelInvocation: false,
      metadata: { 'disable-model-invocation': 'false' },
    });
    expect(invalid?.metadata['disable-model-invocation']).toBe('sometimes');
    expect(invalid).not.toHaveProperty('disableModelInvocation');
  });

  it('rejects skills missing required frontmatter fields', async () => {
    const skillDir = join(workspace, '.agents', 'skills', 'broken');
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, 'SKILL.md'),
      ['---', 'name: broken', '---', '', 'No description.'].join('\n'),
    );

    await expect(discoverSkills({ cwd: workspace })).rejects.toThrow(/description/);
  });

  it('returns duplicate skill names as separate manifests with distinct paths', async () => {
    const rootSkillDir = join(workspace, '.agents', 'skills', 'review');
    const nested = join(workspace, 'packages', 'api');
    const nestedSkillDir = join(nested, '.agents', 'skills', 'review');
    await mkdir(rootSkillDir, { recursive: true });
    await mkdir(nestedSkillDir, { recursive: true });
    await writeSkill(rootSkillDir, 'review', 'Root review workflow.');
    await writeSkill(nestedSkillDir, 'review', 'Nested review workflow.');

    const skills = await discoverSkills({ cwd: nested });

    expect(skills.map((skill) => [skill.name, skill.path])).toEqual([
      ['review', join(rootSkillDir, 'SKILL.md')],
      ['review', join(nestedSkillDir, 'SKILL.md')],
    ]);
  });

  it('ignores symlinked skill directories', async () => {
    const realSkillDir = join(workspace, 'external-skill');
    const skillsRoot = join(workspace, '.agents', 'skills');
    await mkdir(realSkillDir, { recursive: true });
    await mkdir(skillsRoot, { recursive: true });
    await writeSkill(realSkillDir, 'external', 'External skill.');

    await symlink(realSkillDir, join(skillsRoot, 'external'));

    await expect(discoverSkills({ cwd: workspace })).resolves.toEqual([]);
  });

  it('composes base system, AGENTS instructions, and explicitly loaded skills', async () => {
    await writeFile(join(workspace, 'AGENTS.md'), 'Use focused tests.');
    const skillDir = join(workspace, '.agents', 'skills', 'release');
    await mkdir(skillDir, { recursive: true });
    await writeSkill(skillDir, 'release', 'Release workflow.', 'Run ci before publish.');

    const instructions = await loadAgentInstructions({ cwd: workspace });
    const [manifest] = await discoverSkills({ cwd: workspace });
    const skill = await loadSkill(manifest!);

    expect(
      composeAgentSystemPrompt({
        baseSystem: 'You are an agent builder.',
        instructions,
        skills: [skill],
      }),
    ).toContain('# Repository Instructions');
    expect(
      composeAgentSystemPrompt({
        baseSystem: 'You are an agent builder.',
        instructions,
        skills: [skill],
      }),
    ).toContain('# Selected Skills');
  });

  it('builds a scratch agent from system prompt, agent.md, and selected skills', async () => {
    const agentDir = join(workspace, 'agents', 'triage');
    const rootSkillDir = join(workspace, '.agents', 'skills', 'shared-rules');
    const agentSkillDir = join(agentDir, '.agents', 'skills', 'triage-ticket');
    await mkdir(rootSkillDir, { recursive: true });
    await mkdir(agentSkillDir, { recursive: true });
    await mkdir(agentDir, { recursive: true });
    await writeFile(
      join(agentDir, 'agent.md'),
      'Always include the marker AGENT_RULE_APPLIED in replies.',
    );
    await writeSkill(
      rootSkillDir,
      'shared-rules',
      'Shared response rules.',
      'Mention SHARED_SKILL_APPLIED when this skill is selected.',
    );
    await writeSkill(
      agentSkillDir,
      'triage-ticket',
      'Triage support tickets.',
      'Mention TRIAGE_SKILL_APPLIED and classify the ticket.',
    );

    const instructions = await loadAgentInstructions({ cwd: agentDir });
    const skills = await discoverSkills({ cwd: agentDir });
    const selectedSkills = await Promise.all(
      skills.map((skill) => loadSkill(skill)),
    );
    const system = composeAgentSystemPrompt({
      baseSystem: 'You are a scratch-built support agent.',
      instructions,
      skills: selectedSkills,
    });
    const client = LLMClient.mock({
      defaultModel: 'mock-model',
      defaultProvider: 'mock',
      responses: [
        (request) => ({
          content: [{ text: request.system ?? '', type: 'text' }],
          finishReason: 'stop',
          model: request.model ?? 'mock-model',
          provider: 'mock',
          raw: {},
          text: request.system ?? '',
          toolCalls: [],
          usage: {
            cachedTokens: 0,
            cost: '$0.00',
            costUSD: 0,
            inputTokens: 1,
            outputTokens: 1,
          },
        }),
      ],
      sessionStore: new InMemorySessionStore<ConversationSnapshot>(),
    });
    const conversation = await client.conversation({
      sessionId: 'scratch-agent',
      system,
    });

    const response = await conversation.send('Triage this billing ticket.');

    expect(skills.map((skill) => skill.name)).toEqual([
      'shared-rules',
      'triage-ticket',
    ]);
    expect(response.text).toContain('You are a scratch-built support agent.');
    expect(response.text).toContain('AGENT_RULE_APPLIED');
    expect(response.text).toContain('SHARED_SKILL_APPLIED');
    expect(response.text).toContain('TRIAGE_SKILL_APPLIED');
    expect(conversation.toMessages()[0]).toMatchObject({
      content: system,
      pinned: true,
      role: 'system',
    });
  });
});

describe('loadSkill path containment', () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'load-skill-'));
    await mkdir(join(workspace, '.git'));
  });

  afterEach(async () => {
    await rm(workspace, { force: true, recursive: true });
  });

  it('rejects a string path without a trusted root', async () => {
    const skillsRoot = join(workspace, '.agents', 'skills', 'demo');
    await mkdir(skillsRoot, { recursive: true });
    await writeSkill(skillsRoot, 'demo', 'Demo skill.');

    await expect(loadSkill(join(skillsRoot, 'SKILL.md'))).rejects.toThrow(AgentFilesError);
  });

  it('loads a string path that stays inside the trusted root', async () => {
    const root = join(workspace, '.agents', 'skills');
    const skillDir = join(root, 'demo');
    await mkdir(skillDir, { recursive: true });
    await writeSkill(skillDir, 'demo', 'Demo skill.', 'Body here.');

    const skill = await loadSkill('demo/SKILL.md', { root });
    expect(skill.name).toBe('demo');
    expect(skill.body).toContain('Body here.');
  });

  it('rejects a traversal path that escapes the trusted root', async () => {
    const root = join(workspace, '.agents', 'skills');
    await mkdir(root, { recursive: true });
    await writeFile(join(workspace, 'secret.md'), '---\nname: x\ndescription: y\n---\nsecret');

    await expect(
      loadSkill('../../secret.md', { root }),
    ).rejects.toThrow(/outside root/);
  });

  it('rejects an absolute path outside the trusted root', async () => {
    const root = join(workspace, '.agents', 'skills');
    await mkdir(root, { recursive: true });

    await expect(
      loadSkill('/etc/passwd', { root }),
    ).rejects.toThrow(/outside root/);
  });

  it('still accepts manifests from discoverSkills without a root', async () => {
    const agentDir = join(workspace, 'agent');
    const skillDir = join(agentDir, '.agents', 'skills', 'demo');
    await mkdir(skillDir, { recursive: true });
    await writeSkill(skillDir, 'demo', 'Demo skill.', 'Manifest body.');

    const [manifest] = await discoverSkills({ cwd: agentDir });
    const skill = await loadSkill(manifest!);
    expect(skill.body).toContain('Manifest body.');
  });
});

const runLiveAgentSmoke =
  process.env.LIVE_TESTS === '1' && process.env.OPENAI_API_KEY ? it : it.skip;

describe('agent file helpers live smoke', () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'agent-files-live-'));
    await mkdir(join(workspace, '.git'));
  });

  afterEach(async () => {
    await rm(workspace, { force: true, recursive: true });
  });

  runLiveAgentSmoke(
    'runs a real scratch agent prompt through OpenAI',
    async () => {
      const agentDir = join(workspace, 'agents', 'live');
      const skillDir = join(agentDir, '.agents', 'skills', 'live-marker');
      await mkdir(skillDir, { recursive: true });
      await writeFile(
        join(agentDir, 'agent.md'),
        'Reply with the exact marker AGENT_FILE_LIVE_OK when asked for the marker.',
      );
      await writeSkill(
        skillDir,
        'live-marker',
        'Live marker response skill.',
        'When selected, include SKILL_FILE_LIVE_OK.',
      );

      const instructions = await loadAgentInstructions({ cwd: agentDir });
      const [manifest] = await discoverSkills({ cwd: agentDir });
      const skill = await loadSkill(manifest!);
      const client = LLMClient.fromEnv({
        defaultModel: 'gpt-4o-mini',
        sessionStore: new InMemorySessionStore<ConversationSnapshot>(),
      });
      const conversation = await client.conversation({
        model: 'gpt-4o-mini',
        provider: 'openai',
        system: composeAgentSystemPrompt({
          baseSystem:
            'You are a deterministic test agent. Return only requested markers.',
          instructions,
          skills: [skill],
        }),
      });

      const response = await conversation.send(
        'Return AGENT_FILE_LIVE_OK and SKILL_FILE_LIVE_OK, separated by one space.',
      );

      expect(response.provider).toBe('openai');
      expect(response.text).toContain('AGENT_FILE_LIVE_OK');
      expect(response.text).toContain('SKILL_FILE_LIVE_OK');
      expect(response.usage.inputTokens).toBeGreaterThan(0);
      expect(response.usage.outputTokens).toBeGreaterThan(0);
    },
    30_000,
  );
});

async function writeSkill(
  directory: string,
  name: string,
  description: string,
  body: string = 'Follow the workflow.',
): Promise<void> {
  await writeFile(
    join(directory, 'SKILL.md'),
    ['---', `name: ${name}`, `description: ${description}`, '---', '', body].join('\n'),
  );
}
