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
    directory: string;
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
}
export interface AgentSkill extends AgentSkillManifest {
    body: string;
}
export interface ComposeAgentSystemPromptOptions {
    baseSystem?: string;
    instructions?: AgentInstructions;
    skills?: AgentSkill[];
}
export declare class AgentFilesError extends Error {
    constructor(message: string);
}
export declare function loadAgentInstructions(options: LoadAgentInstructionsOptions): Promise<AgentInstructions>;
export declare function discoverSkills(options: DiscoverSkillsOptions): Promise<AgentSkillManifest[]>;
export declare function loadSkill(skillOrPath: AgentSkillManifest | string, options?: LoadSkillOptions): Promise<AgentSkill>;
export declare function composeAgentSystemPrompt(options: ComposeAgentSystemPromptOptions): string;
//# sourceMappingURL=agent-files.d.ts.map