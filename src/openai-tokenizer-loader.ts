import type * as JsTiktoken from 'js-tiktoken';

type JsTiktokenModule = typeof JsTiktoken & {
  default?: Partial<typeof JsTiktoken>;
};

export async function loadOpenAITokenizer() {
  const module = (await import('js-tiktoken')) as JsTiktokenModule;
  return {
    encodingForModel: module.encodingForModel ?? module.default?.encodingForModel,
    getEncoding: module.getEncoding ?? module.default?.getEncoding,
  };
}
