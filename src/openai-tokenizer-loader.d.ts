export function loadOpenAITokenizer(): Promise<{
  encodingForModel: (model: string) => { encode: (text: string) => number[] };
  getEncoding: (encoding: 'o200k_base') => { encode: (text: string) => number[] };
}>;
