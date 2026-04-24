export interface TextChunk {
    endOffset: number;
    index: number;
    startOffset: number;
    text: string;
}
export interface ChunkTextOptions {
    chunkSize?: number;
    minChunkSize?: number;
    overlap?: number;
}
export declare function cleanText(input: string): string;
export declare function stripHtml(input: string): string;
export declare function chunkText(input: string, options?: ChunkTextOptions): TextChunk[];
//# sourceMappingURL=chunking.d.ts.map