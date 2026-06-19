import { lstat, readdir, readFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
const DEFAULT_INSTRUCTION_MAX_BYTES = 32_768;
const DEFAULT_SKILL_MAX_BYTES = 65_536;
const DEFAULT_INSTRUCTION_FILENAMES = [
    'AGENTS.override.md',
    'AGENTS.md',
    'agent.md',
    'Agent.md',
];
export class AgentFilesError extends Error {
    constructor(message) {
        super(message);
        this.name = 'AgentFilesError';
    }
}
export async function loadAgentInstructions(options) {
    const root = await resolveAgentRoot(options.cwd, options.root);
    const cwd = resolve(options.cwd);
    assertWithinRoot(cwd, root);
    const maxBytes = options.maxBytes ?? DEFAULT_INSTRUCTION_MAX_BYTES;
    const filenames = options.filenames ?? DEFAULT_INSTRUCTION_FILENAMES;
    const files = [];
    let totalBytes = 0;
    for (const directory of directoriesFromRoot(root, cwd)) {
        const file = await findInstructionFile(directory, filenames);
        if (!file) {
            continue;
        }
        const content = await readUtf8FileWithLimit(file, maxBytes);
        totalBytes += utf8Bytes(content);
        if (totalBytes > maxBytes) {
            throw new AgentFilesError(`Agent instructions exceed the ${maxBytes} byte limit.`);
        }
        files.push({ content, path: file });
    }
    return {
        content: files.map((file) => file.content.trimEnd()).join('\n\n'),
        files,
        root,
    };
}
export async function discoverSkills(options) {
    const root = await resolveAgentRoot(options.cwd, options.root);
    const cwd = resolve(options.cwd);
    assertWithinRoot(cwd, root);
    const maxBytes = options.maxBytes ?? DEFAULT_SKILL_MAX_BYTES;
    const manifests = [];
    for (const directory of directoriesFromRoot(root, cwd)) {
        const skillsRoot = resolve(directory, '.agents', 'skills');
        for (const skillDirectory of await listSkillDirectories(skillsRoot)) {
            const skillPath = resolve(skillDirectory, 'SKILL.md');
            const content = await readUtf8FileWithLimit(skillPath, maxBytes);
            const parsed = parseSkillMarkdown(content, skillPath);
            const manifest = {
                description: parsed.description,
                directory: skillDirectory,
                metadata: parsed.metadata,
                name: parsed.name,
                path: skillPath,
            };
            if (parsed.disableModelInvocation !== undefined) {
                manifest.disableModelInvocation = parsed.disableModelInvocation;
            }
            manifests.push(manifest);
        }
    }
    return manifests;
}
export async function loadSkill(skillOrPath, options = {}) {
    const skillPath = typeof skillOrPath === 'string' ? resolve(skillOrPath) : skillOrPath.path;
    const content = await readUtf8FileWithLimit(skillPath, options.maxBytes ?? DEFAULT_SKILL_MAX_BYTES);
    const parsed = parseSkillMarkdown(content, skillPath);
    const skill = {
        body: parsed.body,
        description: parsed.description,
        directory: dirname(skillPath),
        metadata: parsed.metadata,
        name: parsed.name,
        path: skillPath,
    };
    if (parsed.disableModelInvocation !== undefined) {
        skill.disableModelInvocation = parsed.disableModelInvocation;
    }
    return skill;
}
export function composeAgentSystemPrompt(options) {
    const sections = [];
    if (options.baseSystem?.trim()) {
        sections.push(options.baseSystem.trim());
    }
    if (options.instructions && options.instructions.files.length > 0) {
        sections.push([
            '# Repository Instructions',
            ...options.instructions.files.map((file) => [`## ${file.path}`, file.content.trim()].join('\n\n')),
        ].join('\n\n'));
    }
    if (options.skills && options.skills.length > 0) {
        sections.push([
            '# Selected Skills',
            ...options.skills.map((skill) => [
                `## ${skill.name}`,
                `Description: ${skill.description}`,
                skill.body.trim(),
            ].join('\n\n')),
        ].join('\n\n'));
    }
    return sections.join('\n\n');
}
async function resolveAgentRoot(cwd, explicitRoot) {
    if (explicitRoot) {
        return resolve(explicitRoot);
    }
    let current = resolve(cwd);
    for (;;) {
        if (await pathExists(resolve(current, '.git'))) {
            return current;
        }
        const parent = dirname(current);
        if (parent === current) {
            return resolve(cwd);
        }
        current = parent;
    }
}
function assertWithinRoot(cwd, root) {
    const relativePath = relative(root, cwd);
    if (relativePath === '') {
        return;
    }
    if (relativePath === '..' || relativePath.startsWith('../') || relativePath.startsWith('..\\')) {
        throw new AgentFilesError(`cwd "${cwd}" is outside root "${root}".`);
    }
}
function directoriesFromRoot(root, cwd) {
    const relativePath = relative(root, cwd);
    if (!relativePath) {
        return [root];
    }
    const directories = [root];
    const segments = relativePath.split(/[\\/]/).filter(Boolean);
    let current = root;
    for (const segment of segments) {
        current = resolve(current, segment);
        directories.push(current);
    }
    return directories;
}
async function findInstructionFile(directory, filenames) {
    for (const filename of filenames) {
        const path = resolve(directory, filename);
        if (await isRegularFile(path)) {
            return path;
        }
    }
    return undefined;
}
async function listSkillDirectories(skillsRoot) {
    let entries;
    try {
        entries = await readdir(skillsRoot, { withFileTypes: true });
    }
    catch (error) {
        if (isNodeError(error, 'ENOENT') || isNodeError(error, 'ENOTDIR')) {
            return [];
        }
        throw error;
    }
    const directories = [];
    for (const entry of entries) {
        if (!entry.isDirectory()) {
            continue;
        }
        const directory = resolve(skillsRoot, entry.name);
        const stats = await lstat(directory);
        if (stats.isSymbolicLink()) {
            continue;
        }
        if (await isRegularFile(resolve(directory, 'SKILL.md'))) {
            directories.push(directory);
        }
    }
    return directories.sort();
}
async function readUtf8FileWithLimit(path, maxBytes) {
    const buffer = await readFile(path);
    if (buffer.byteLength > maxBytes) {
        throw new AgentFilesError(`File "${path}" exceeds the ${maxBytes} byte limit.`);
    }
    return buffer.toString('utf8');
}
function parseSkillMarkdown(content, path) {
    if (!content.startsWith('---\n')) {
        throw new AgentFilesError(`Skill "${path}" must start with YAML frontmatter.`);
    }
    const end = content.indexOf('\n---', 4);
    if (end === -1) {
        throw new AgentFilesError(`Skill "${path}" is missing closing YAML frontmatter.`);
    }
    const frontmatter = content.slice(4, end);
    const bodyStart = content.startsWith('\n', end + 4) ? end + 5 : end + 4;
    const body = content.slice(bodyStart).replace(/^\r?\n/, '');
    const fields = parseSimpleFrontmatter(frontmatter);
    const name = fields.get('name');
    const description = fields.get('description');
    if (!name) {
        throw new AgentFilesError(`Skill "${path}" is missing required frontmatter field "name".`);
    }
    if (!description) {
        throw new AgentFilesError(`Skill "${path}" is missing required frontmatter field "description".`);
    }
    const parsedSkill = {
        body,
        description,
        metadata: Object.fromEntries(fields),
        name,
    };
    const disableModelInvocation = parseOptionalBoolean(fields.get('disable-model-invocation'));
    if (disableModelInvocation !== undefined) {
        parsedSkill.disableModelInvocation = disableModelInvocation;
    }
    return parsedSkill;
}
function parseOptionalBoolean(value) {
    if (value === undefined) {
        return undefined;
    }
    if (/^true$/i.test(value)) {
        return true;
    }
    if (/^false$/i.test(value)) {
        return false;
    }
    return undefined;
}
function parseSimpleFrontmatter(frontmatter) {
    const fields = new Map();
    for (const line of frontmatter.split(/\r?\n/)) {
        const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
        if (!match) {
            continue;
        }
        fields.set(match[1], stripYamlQuotes(match[2].trim()));
    }
    return fields;
}
function stripYamlQuotes(value) {
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
        return value.slice(1, -1);
    }
    return value;
}
async function isRegularFile(path) {
    try {
        return (await lstat(path)).isFile();
    }
    catch (error) {
        if (isNodeError(error, 'ENOENT') || isNodeError(error, 'ENOTDIR')) {
            return false;
        }
        throw error;
    }
}
async function pathExists(path) {
    try {
        await lstat(path);
        return true;
    }
    catch (error) {
        if (isNodeError(error, 'ENOENT') || isNodeError(error, 'ENOTDIR')) {
            return false;
        }
        throw error;
    }
}
function utf8Bytes(value) {
    return new TextEncoder().encode(value).byteLength;
}
function isNodeError(error, code) {
    return error instanceof Error && 'code' in error && error.code === code;
}
