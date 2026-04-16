export async function loadOpenAITokenizer() {
  const module = await import('js-tiktoken');
  return {
    encodingForModel: module.encodingForModel ?? module.default?.encodingForModel,
    getEncoding: module.getEncoding ?? module.default?.getEncoding,
  };
}
