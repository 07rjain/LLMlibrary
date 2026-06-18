import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentFilesError, composeAgentSystemPrompt, discoverSkills, loadAgentInstructions, loadSkill, } from '../src/agent-files.js';
describe('agent file helpers', () => {
    let workspace;
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
        expect(instructions.content).toBe('Use pnpm.\n\nOverride service instructions.\n\nAPI instructions.');
    });
    it('returns empty instructions when no AGENTS files exist', async () => {
        const instructions = await loadAgentInstructions({ cwd: workspace });
        expect(instructions.files).toEqual([]);
        expect(instructions.content).toBe('');
    });
    it('enforces the AGENTS byte limit across loaded files', async () => {
        await writeFile(join(workspace, 'AGENTS.md'), '12345');
        await expect(loadAgentInstructions({ cwd: workspace, maxBytes: 4 })).rejects.toThrow(AgentFilesError);
    });
    it('discovers skill metadata without loading references or scripts', async () => {
        const skillDir = join(workspace, '.agents', 'skills', 'release-npm');
        await mkdir(join(skillDir, 'references'), { recursive: true });
        await writeFile(join(skillDir, 'SKILL.md'), [
            '---',
            'name: release-npm',
            'description: Publish package releases.',
            '---',
            '',
            'Run release steps.',
        ].join('\n'));
        await writeFile(join(skillDir, 'references', 'extra.md'), 'Not loaded.');
        const skills = await discoverSkills({ cwd: workspace });
        expect(skills).toEqual([
            {
                description: 'Publish package releases.',
                directory: skillDir,
                name: 'release-npm',
                path: join(skillDir, 'SKILL.md'),
            },
        ]);
    });
    it('loads a selected skill body explicitly', async () => {
        const skillDir = join(workspace, '.agents', 'skills', 'security-review');
        await mkdir(skillDir, { recursive: true });
        await writeFile(join(skillDir, 'SKILL.md'), [
            '---',
            'name: security-review',
            'description: Review security-sensitive changes.',
            '---',
            '',
            'Check tenant isolation and SSRF controls.',
        ].join('\n'));
        const [manifest] = await discoverSkills({ cwd: workspace });
        const skill = await loadSkill(manifest);
        expect(skill).toMatchObject({
            body: 'Check tenant isolation and SSRF controls.',
            description: 'Review security-sensitive changes.',
            directory: skillDir,
            name: 'security-review',
            path: join(skillDir, 'SKILL.md'),
        });
    });
    it('rejects skills missing required frontmatter fields', async () => {
        const skillDir = join(workspace, '.agents', 'skills', 'broken');
        await mkdir(skillDir, { recursive: true });
        await writeFile(join(skillDir, 'SKILL.md'), ['---', 'name: broken', '---', '', 'No description.'].join('\n'));
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
        const skill = await loadSkill(manifest);
        expect(composeAgentSystemPrompt({
            baseSystem: 'You are an agent builder.',
            instructions,
            skills: [skill],
        })).toContain('# Repository Instructions');
        expect(composeAgentSystemPrompt({
            baseSystem: 'You are an agent builder.',
            instructions,
            skills: [skill],
        })).toContain('# Selected Skills');
    });
});
async function writeSkill(directory, name, description, body = 'Follow the workflow.') {
    await writeFile(join(directory, 'SKILL.md'), ['---', `name: ${name}`, `description: ${description}`, '---', '', body].join('\n'));
}
