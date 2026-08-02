import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, win32 } from 'node:path';

const DEFAULT_INSTRUCTION_MAX_BYTES = 32_768;
const DEFAULT_SKILL_MAX_BYTES = 65_536;
const DEFAULT_INSTRUCTION_FILENAMES = [
  'AGENTS.override.md',
  'AGENTS.md',
  'agent.md',
  'Agent.md',
] as const;

export interface AgentInstructionFile {
  content: string;
  path: string;
}

export interface AgentInstructions {
  content: string;
  files: AgentInstructionFile[];
  root: string;
}

export interface LoadAgentInstructionsOptions {
  cwd: string;
  filenames?: readonly string[];
  maxBytes?: number;
  root?: string;
}

export interface AgentSkillManifest {
  description: string;
  disableModelInvocation?: boolean;
  directory: string;
  metadata: Record<string, string>;
  name: string;
  path: string;
}

export interface DiscoverSkillsOptions {
  cwd: string;
  maxBytes?: number;
  root?: string;
}

export interface LoadSkillOptions {
  maxBytes?: number;
  /**
   * Trusted root that a string `skillOrPath` must resolve inside. Required when
   * loading by raw path so untrusted input cannot escape the skills directory.
   * Structurally supplied or deserialized manifests also require this option;
   * manifests returned directly by {@link discoverSkills} carry private
   * provenance and can be loaded without repeating the root.
   */
  root?: string;
}

export interface AgentSkill extends AgentSkillManifest {
  body: string;
}

export interface ComposeAgentSystemPromptOptions {
  baseSystem?: string;
  instructions?: AgentInstructions;
  skills?: AgentSkill[];
}

export class AgentFilesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentFilesError';
  }
}

interface TrustedRoot {
  displayPath: string;
  canonicalPath: string;
}

interface SkillProvenance {
  canonicalPath: string;
  directory: string;
  path: string;
  root: TrustedRoot;
}

const skillProvenance = new WeakMap<object, SkillProvenance>();

export async function loadAgentInstructions(
  options: LoadAgentInstructionsOptions,
): Promise<AgentInstructions> {
  const root = await getTrustedRoot(
    await resolveAgentRoot(options.cwd, options.root),
  );
  const cwd = resolve(options.cwd);
  await assertDirectoryWithinRoot(cwd, root);

  const maxBytes = options.maxBytes ?? DEFAULT_INSTRUCTION_MAX_BYTES;
  const filenames = options.filenames ?? DEFAULT_INSTRUCTION_FILENAMES;
  const files: AgentInstructionFile[] = [];
  let totalBytes = 0;

  for (const directory of directoriesFromRoot(root.displayPath, cwd)) {
    const file = await findInstructionFile(directory, filenames);
    if (!file) {
      continue;
    }

    const { content } = await readUtf8FileWithLimit(
      file,
      maxBytes,
      root.canonicalPath,
    );
    totalBytes += utf8Bytes(content);
    if (totalBytes > maxBytes) {
      throw new AgentFilesError(
        `Agent instructions exceed the ${maxBytes} byte limit.`,
      );
    }
    files.push({ content, path: file });
  }

  return {
    content: files.map((file) => file.content.trimEnd()).join('\n\n'),
    files,
    root: root.displayPath,
  };
}

export async function discoverSkills(
  options: DiscoverSkillsOptions,
): Promise<AgentSkillManifest[]> {
  const root = await getTrustedRoot(
    await resolveAgentRoot(options.cwd, options.root),
  );
  const cwd = resolve(options.cwd);
  await assertDirectoryWithinRoot(cwd, root);

  const maxBytes = options.maxBytes ?? DEFAULT_SKILL_MAX_BYTES;
  const manifests: AgentSkillManifest[] = [];

  for (const directory of directoriesFromRoot(root.displayPath, cwd)) {
    const skillsRoot = resolve(directory, '.agents', 'skills');
    for (const skillDirectory of await listSkillDirectories(
      skillsRoot,
      root.canonicalPath,
    )) {
      const skillPath = resolve(skillDirectory, 'SKILL.md');
      const { content, canonicalPath } = await readUtf8FileWithLimit(
        skillPath,
        maxBytes,
        root.canonicalPath,
      );
      const parsed = parseSkillMarkdown(content, skillPath);
      const manifest: AgentSkillManifest = {
        description: parsed.description,
        directory: skillDirectory,
        metadata: parsed.metadata,
        name: parsed.name,
        path: skillPath,
      };
      if (parsed.disableModelInvocation !== undefined) {
        manifest.disableModelInvocation = parsed.disableModelInvocation;
      }
      skillProvenance.set(manifest, {
        canonicalPath,
        directory: skillDirectory,
        path: skillPath,
        root,
      });
      manifests.push(manifest);
    }
  }

  return manifests;
}

export async function loadSkill(
  skillOrPath: AgentSkillManifest | string,
  options: LoadSkillOptions = {},
): Promise<AgentSkill> {
  let skillPath: string;
  let root: TrustedRoot;
  let expectedCanonicalPath: string | undefined;
  if (typeof skillOrPath === 'string') {
    if (options.root === undefined) {
      throw new AgentFilesError(
        'loadSkill() requires a trusted "root" option when given a string path. ' +
          'Pass a manifest from discoverSkills() or set options.root.',
      );
    }
    root = await getTrustedRoot(options.root);
    validateRawSkillPath(skillOrPath);
    skillPath = resolve(root.displayPath, skillOrPath);
    assertLexicalPathWithinRoot(skillPath, root.displayPath);
  } else {
    const provenance = skillProvenance.get(skillOrPath);
    if (provenance) {
      if (
        skillOrPath.path !== provenance.path ||
        skillOrPath.directory !== provenance.directory
      ) {
        throw new AgentFilesError('Skill manifest provenance was modified.');
      }
      root = await getTrustedRoot(provenance.root.displayPath);
      if (root.canonicalPath !== provenance.root.canonicalPath) {
        throw new AgentFilesError(
          'Trusted skill root changed after discovery.',
        );
      }
      skillPath = provenance.path;
      expectedCanonicalPath = provenance.canonicalPath;
    } else {
      if (options.root === undefined) {
        throw new AgentFilesError(
          'loadSkill() requires a trusted "root" option for an untrusted manifest.',
        );
      }
      if (!skillOrPath || typeof skillOrPath.path !== 'string') {
        throw new AgentFilesError('Skill manifest has an invalid path.');
      }
      root = await getTrustedRoot(options.root);
      skillPath = resolve(root.displayPath, skillOrPath.path);
      assertLexicalPathWithinRoot(skillPath, root.displayPath);
    }
  }
  const { content, canonicalPath } = await readUtf8FileWithLimit(
    skillPath,
    options.maxBytes ?? DEFAULT_SKILL_MAX_BYTES,
    root.canonicalPath,
  );
  if (expectedCanonicalPath && canonicalPath !== expectedCanonicalPath) {
    throw new AgentFilesError('Skill path changed after discovery.');
  }
  const parsed = parseSkillMarkdown(content, skillPath);

  const skill: AgentSkill = {
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

export function composeAgentSystemPrompt(
  options: ComposeAgentSystemPromptOptions,
): string {
  const sections: string[] = [];

  if (options.baseSystem?.trim()) {
    sections.push(options.baseSystem.trim());
  }

  if (options.instructions && options.instructions.files.length > 0) {
    sections.push(
      [
        '# Repository Instructions',
        ...options.instructions.files.map((file) =>
          [`## ${file.path}`, file.content.trim()].join('\n\n'),
        ),
      ].join('\n\n'),
    );
  }

  if (options.skills && options.skills.length > 0) {
    sections.push(
      [
        '# Selected Skills',
        ...options.skills.map((skill) =>
          [
            `## ${skill.name}`,
            `Description: ${skill.description}`,
            skill.body.trim(),
          ].join('\n\n'),
        ),
      ].join('\n\n'),
    );
  }

  return sections.join('\n\n');
}

async function resolveAgentRoot(
  cwd: string,
  explicitRoot: string | undefined,
): Promise<string> {
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

function assertLexicalPathWithinRoot(target: string, root: string): void {
  const relativePath = relative(root, target);
  if (relativePath === '') {
    return;
  }
  if (
    relativePath === '..' ||
    relativePath.startsWith('../') ||
    relativePath.startsWith('..\\')
  ) {
    throw new AgentFilesError('Path is outside the trusted agent root.');
  }
}

function assertCanonicalPathWithinRoot(target: string, root: string): void {
  const relativePath = relative(root, target);
  if (
    relativePath === '..' ||
    relativePath.startsWith('../') ||
    relativePath.startsWith('..\\') ||
    resolve(root, relativePath) !== target
  ) {
    throw new AgentFilesError('Path is outside the trusted agent root.');
  }
}

async function getTrustedRoot(path: string): Promise<TrustedRoot> {
  const displayPath = resolve(path);
  let stats;
  try {
    stats = await lstat(displayPath);
  } catch {
    throw new AgentFilesError('Trusted agent root does not exist.');
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new AgentFilesError('Trusted agent root must be a real directory.');
  }
  let canonicalPath: string;
  try {
    canonicalPath = await realpath(displayPath);
  } catch {
    throw new AgentFilesError('Trusted agent root could not be canonicalized.');
  }
  return { canonicalPath, displayPath };
}

async function assertDirectoryWithinRoot(
  path: string,
  root: TrustedRoot,
): Promise<void> {
  const displayPath = resolve(path);
  assertLexicalPathWithinRoot(displayPath, root.displayPath);
  const canonicalPath = await canonicalizePath(
    displayPath,
    'Agent working directory',
  );
  assertCanonicalPathWithinRoot(canonicalPath, root.canonicalPath);
  let stats;
  try {
    stats = await lstat(canonicalPath);
  } catch {
    throw new AgentFilesError('Agent working directory does not exist.');
  }
  if (!stats.isDirectory()) {
    throw new AgentFilesError('Agent working directory must be a directory.');
  }
}

async function canonicalizePath(path: string, label: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    throw new AgentFilesError(`${label} could not be canonicalized.`);
  }
}

function validateRawSkillPath(path: string): void {
  if (!path || path.trim().length === 0 || path.includes('\0')) {
    throw new AgentFilesError('Skill path must be a non-empty relative path.');
  }
  if (
    isAbsolute(path) ||
    win32.isAbsolute(path) ||
    /^[A-Za-z]:/.test(path) ||
    /^[/\\]{2}/.test(path)
  ) {
    throw new AgentFilesError('Skill path must be a non-empty relative path.');
  }
  if (path.split(/[\\/]/).some((segment) => segment === '..')) {
    throw new AgentFilesError(
      'Skill path must not contain traversal segments.',
    );
  }
}

function directoriesFromRoot(root: string, cwd: string): string[] {
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

async function findInstructionFile(
  directory: string,
  filenames: readonly string[],
): Promise<string | undefined> {
  for (const filename of filenames) {
    const path = resolve(directory, filename);
    if (await isRegularFile(path)) {
      return path;
    }
  }
  return undefined;
}

async function listSkillDirectories(
  skillsRoot: string,
  canonicalRoot: string,
): Promise<string[]> {
  const canonicalSkillsRoot = await canonicalizeOptionalPath(skillsRoot);
  if (!canonicalSkillsRoot) {
    return [];
  }
  assertCanonicalPathWithinRoot(canonicalSkillsRoot, canonicalRoot);
  let entries;
  try {
    entries = await readdir(skillsRoot, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error, 'ENOENT') || isNodeError(error, 'ENOTDIR')) {
      return [];
    }
    throw error;
  }

  const directories: string[] = [];
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
      const canonicalDirectory = await canonicalizePath(
        directory,
        'Skill directory',
      );
      assertCanonicalPathWithinRoot(canonicalDirectory, canonicalRoot);
      directories.push(directory);
    }
  }
  return directories.sort();
}

async function readUtf8FileWithLimit(
  path: string,
  maxBytes: number,
  canonicalRoot: string,
): Promise<{ canonicalPath: string; content: string }> {
  const canonicalPath = await canonicalizePath(path, 'Skill file');
  assertCanonicalPathWithinRoot(canonicalPath, canonicalRoot);
  let stats;
  try {
    stats = await lstat(canonicalPath);
  } catch {
    throw new AgentFilesError('Skill file does not exist.');
  }
  if (!stats.isFile()) {
    throw new AgentFilesError('Skill file must be a regular file.');
  }
  const buffer = await readFile(canonicalPath);
  if (buffer.byteLength > maxBytes) {
    throw new AgentFilesError(`Agent file exceeds the ${maxBytes} byte limit.`);
  }
  return { canonicalPath, content: buffer.toString('utf8') };
}

async function canonicalizeOptionalPath(
  path: string,
): Promise<string | undefined> {
  try {
    return await realpath(path);
  } catch (error) {
    if (isNodeError(error, 'ENOENT') || isNodeError(error, 'ENOTDIR')) {
      return undefined;
    }
    throw new AgentFilesError(
      'Agent skill directory could not be canonicalized.',
    );
  }
}

function parseSkillMarkdown(
  content: string,
  path: string,
): {
  body: string;
  description: string;
  disableModelInvocation?: boolean;
  metadata: Record<string, string>;
  name: string;
} {
  if (!content.startsWith('---\n')) {
    throw new AgentFilesError(
      `Skill "${path}" must start with YAML frontmatter.`,
    );
  }

  const end = content.indexOf('\n---', 4);
  if (end === -1) {
    throw new AgentFilesError(
      `Skill "${path}" is missing closing YAML frontmatter.`,
    );
  }

  const frontmatter = content.slice(4, end);
  const bodyStart = content.startsWith('\n', end + 4) ? end + 5 : end + 4;
  const body = content.slice(bodyStart).replace(/^\r?\n/, '');
  const fields = parseSimpleFrontmatter(frontmatter);
  const name = fields.get('name');
  const description = fields.get('description');

  if (!name) {
    throw new AgentFilesError(
      `Skill "${path}" is missing required frontmatter field "name".`,
    );
  }
  if (!description) {
    throw new AgentFilesError(
      `Skill "${path}" is missing required frontmatter field "description".`,
    );
  }

  const parsedSkill: {
    body: string;
    description: string;
    disableModelInvocation?: boolean;
    metadata: Record<string, string>;
    name: string;
  } = {
    body,
    description,
    metadata: Object.fromEntries(fields),
    name,
  };
  const disableModelInvocation = parseOptionalBoolean(
    fields.get('disable-model-invocation'),
  );
  if (disableModelInvocation !== undefined) {
    parsedSkill.disableModelInvocation = disableModelInvocation;
  }
  return parsedSkill;
}

function parseOptionalBoolean(value: string | undefined): boolean | undefined {
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

function parseSimpleFrontmatter(frontmatter: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const line of frontmatter.split(/\r?\n/)) {
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!match) {
      continue;
    }

    fields.set(match[1]!, stripYamlQuotes(match[2]!.trim()));
  }
  return fields;
}

function stripYamlQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

async function isRegularFile(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isFile();
  } catch (error) {
    if (isNodeError(error, 'ENOENT') || isNodeError(error, 'ENOTDIR')) {
      return false;
    }
    throw error;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isNodeError(error, 'ENOENT') || isNodeError(error, 'ENOTDIR')) {
      return false;
    }
    throw error;
  }
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isNodeError(
  error: unknown,
  code: string,
): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}
