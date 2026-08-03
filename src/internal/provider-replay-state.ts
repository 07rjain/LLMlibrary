import { InvalidConversationSnapshotError } from 'unified-llm-client/errors';

import type { CanonicalMessage, JsonObject } from '../types.js';

export const PROVIDER_REPLAY_STATE_VERSION = 1;
export const MAX_PROVIDER_REPLAY_ENTRIES = 64;
export const MAX_PROVIDER_REPLAY_PARTS = 256;
export const MAX_PROVIDER_REPLAY_TOOL_CALLS = 128;
export const MAX_PROVIDER_REPLAY_SIGNATURE_BYTES = 8 * 1024;
export const MAX_PROVIDER_REPLAY_SNAPSHOT_BYTES = 256 * 1024;

export interface GoogleReplayToolCall {
  args: JsonObject;
  canonicalId: string;
  name: string;
  nativeId?: string;
  partIndex: number;
}

export interface GoogleProviderReplayState {
  calls: GoogleReplayToolCall[];
  model: string;
  parts: JsonObject[];
  provider: 'google';
  version: 1;
}

interface ProviderReplaySnapshotEntry extends GoogleProviderReplayState {
  messageIndex: number;
}

interface ProviderReplaySnapshotEnvelope {
  entries: ProviderReplaySnapshotEntry[];
  version: 1;
}

const replayState = new WeakMap<object, GoogleProviderReplayState>();
// Gemini signatures are opaque. Accept both standard and URL-safe base64
// alphabets without decoding or otherwise inspecting the signature bytes.
const BASE64_VALUE = /^[\w+/-]+={0,2}$/;
const ENVELOPE_KEYS = ['entries', 'version'] as const;
const ENTRY_KEYS = [
  'calls',
  'messageIndex',
  'model',
  'parts',
  'provider',
  'version',
] as const;
const CALL_KEYS = [
  'args',
  'canonicalId',
  'name',
  'nativeId',
  'partIndex',
] as const;
const PART_KEYS = [
  'functionCall',
  'text',
  'thought',
  'thoughtSignature',
  'thought_signature',
] as const;
const FUNCTION_CALL_KEYS = ['args', 'id', 'name'] as const;

export function attachGoogleReplayState(
  target: object,
  state: GoogleProviderReplayState,
): void {
  replayState.set(target, state);
}

export function copyGoogleReplayState(source: object, target: object): void {
  const state = replayState.get(source);
  if (state) {
    replayState.set(target, state);
  }
}

export function getGoogleReplayStateForMessage(
  message: CanonicalMessage,
  model: string,
): GoogleProviderReplayState | undefined {
  const state = replayState.get(message);
  if (!state || state.provider !== 'google' || state.model !== model) {
    return undefined;
  }
  return state;
}

export function cloneMessagesWithGoogleReplayState(
  messages: CanonicalMessage[],
): CanonicalMessage[] {
  const cloned = cloneJson(messages);
  for (const [index, message] of messages.entries()) {
    const target = cloned[index];
    if (target) {
      copyGoogleReplayState(message, target);
    }
  }
  return cloned;
}

export function copyGoogleReplayStatesByMessage(
  source: CanonicalMessage[],
  target: CanonicalMessage[],
): void {
  let sourceIndex = 0;
  for (const targetMessage of target) {
    const targetFingerprint = stableStringify(targetMessage);
    for (; sourceIndex < source.length; sourceIndex += 1) {
      const sourceMessage = source[sourceIndex]!;
      if (stableStringify(sourceMessage) !== targetFingerprint) {
        continue;
      }
      copyGoogleReplayState(sourceMessage, targetMessage);
      sourceIndex += 1;
      break;
    }
  }
}

export function serializeGoogleReplayState(
  messages: CanonicalMessage[],
): JsonObject | undefined {
  const entries: ProviderReplaySnapshotEntry[] = [];
  for (const [messageIndex, message] of messages.entries()) {
    const state = replayState.get(message);
    if (!state || !stateMatchesMessage(state, message)) {
      continue;
    }
    entries.push({ ...cloneJson(state), messageIndex });
  }
  if (entries.length === 0) {
    return undefined;
  }
  const envelope: ProviderReplaySnapshotEnvelope = {
    entries,
    version: PROVIDER_REPLAY_STATE_VERSION,
  };
  assertSerializedSize(envelope);
  return envelope as unknown as JsonObject;
}

export function validateAndCloneGoogleReplaySnapshot(
  value: unknown,
  messages: CanonicalMessage[],
): JsonObject | undefined {
  if (value === undefined) {
    return undefined;
  }
  const envelope = inspectEnvelope(value, messages);
  return cloneJson(envelope) as unknown as JsonObject;
}

export function restoreGoogleReplayState(
  messages: CanonicalMessage[],
  value: JsonObject | undefined,
): void {
  if (!value) {
    return;
  }
  const envelope = value as unknown as ProviderReplaySnapshotEnvelope;
  for (const entry of envelope.entries) {
    const message = messages[entry.messageIndex];
    if (!message) {
      continue;
    }
    replayState.set(
      message,
      cloneJson({
        calls: entry.calls,
        model: entry.model,
        parts: entry.parts,
        provider: entry.provider,
        version: entry.version,
      }),
    );
  }
}

export function reindexGoogleReplaySnapshot(
  value: JsonObject | undefined,
  sourceMessages: CanonicalMessage[],
  targetMessages: CanonicalMessage[],
): JsonObject | undefined {
  if (!value) {
    return undefined;
  }
  const validated = validateAndCloneGoogleReplaySnapshot(value, sourceMessages);
  if (!validated) {
    return undefined;
  }
  const source = cloneJson(sourceMessages);
  restoreGoogleReplayState(source, validated);
  copyGoogleReplayStatesByMessage(source, targetMessages);
  return serializeGoogleReplayState(targetMessages);
}

function inspectEnvelope(
  value: unknown,
  messages: CanonicalMessage[],
): ProviderReplaySnapshotEnvelope {
  assertSerializedSize(value);
  const envelope = plainObject(value, 'snapshot.providerReplayState');
  assertKeys(envelope, ENVELOPE_KEYS, 'snapshot.providerReplayState');
  if (envelope.version !== PROVIDER_REPLAY_STATE_VERSION) {
    fail('snapshot.providerReplayState.version', 'supported_version');
  }
  if (!Array.isArray(envelope.entries)) {
    fail('snapshot.providerReplayState.entries', 'array');
  }
  if (envelope.entries.length > MAX_PROVIDER_REPLAY_ENTRIES) {
    fail('snapshot.providerReplayState.entries', 'bounded_entry_count');
  }

  const entries = envelope.entries.map((rawEntry, entryIndex) => {
    const path = `snapshot.providerReplayState.entries[${entryIndex}]`;
    const entry = plainObject(rawEntry, path);
    assertKeys(entry, ENTRY_KEYS, path);
    if (
      entry.version !== PROVIDER_REPLAY_STATE_VERSION ||
      entry.provider !== 'google'
    ) {
      fail(path, 'google_v1_replay_state');
    }
    if (typeof entry.model !== 'string' || entry.model.length === 0) {
      fail(`${path}.model`, 'non_empty_string');
    }
    if (
      !Number.isSafeInteger(entry.messageIndex) ||
      (entry.messageIndex as number) < 0
    ) {
      fail(`${path}.messageIndex`, 'non_negative_safe_integer');
    }
    const messageIndex = entry.messageIndex as number;
    const message = messages[messageIndex];
    if (!message || message.role !== 'assistant') {
      fail(`${path}.messageIndex`, 'existing_assistant_message');
    }
    if (
      !Array.isArray(entry.parts) ||
      entry.parts.length > MAX_PROVIDER_REPLAY_PARTS
    ) {
      fail(`${path}.parts`, 'bounded_array');
    }
    const parts = entry.parts.map((part, partIndex) =>
      inspectReplayPart(part, `${path}.parts[${partIndex}]`),
    );
    if (
      !Array.isArray(entry.calls) ||
      entry.calls.length > MAX_PROVIDER_REPLAY_TOOL_CALLS
    ) {
      fail(`${path}.calls`, 'bounded_array');
    }
    const calls = entry.calls.map((call, callIndex) =>
      inspectReplayCall(call, `${path}.calls[${callIndex}]`),
    );
    const state: GoogleProviderReplayState = {
      calls,
      model: entry.model,
      parts,
      provider: 'google',
      version: PROVIDER_REPLAY_STATE_VERSION,
    };
    if (!parts.some(hasThoughtSignature)) {
      fail(`${path}.parts`, 'contains_thought_signature');
    }
    if (!stateMatchesMessage(state, message)) {
      fail(path, 'matching_assistant_tool_call_fingerprint');
    }
    return { ...state, messageIndex };
  });

  return { entries, version: PROVIDER_REPLAY_STATE_VERSION };
}

function inspectReplayPart(value: unknown, path: string): JsonObject {
  const part = plainObject(value, path);
  assertKeys(part, PART_KEYS, path);
  const signature = part.thoughtSignature ?? part.thought_signature;
  if (signature !== undefined) {
    if (
      typeof signature !== 'string' ||
      signature.length === 0 ||
      signature.length > MAX_PROVIDER_REPLAY_SIGNATURE_BYTES ||
      !BASE64_VALUE.test(signature)
    ) {
      fail(`${path}.thoughtSignature`, 'bounded_base64_string');
    }
  }
  if (part.functionCall !== undefined) {
    const functionCall = plainObject(part.functionCall, `${path}.functionCall`);
    assertKeys(functionCall, FUNCTION_CALL_KEYS, `${path}.functionCall`);
  }
  return cloneJson(part) as JsonObject;
}

function inspectReplayCall(value: unknown, path: string): GoogleReplayToolCall {
  const call = plainObject(value, path);
  assertKeys(call, CALL_KEYS, path);
  if (typeof call.canonicalId !== 'string' || call.canonicalId.length === 0) {
    fail(`${path}.canonicalId`, 'non_empty_string');
  }
  if (typeof call.name !== 'string' || call.name.length === 0) {
    fail(`${path}.name`, 'non_empty_string');
  }
  if (!Number.isSafeInteger(call.partIndex) || (call.partIndex as number) < 0) {
    fail(`${path}.partIndex`, 'non_negative_safe_integer');
  }
  if (call.nativeId !== undefined && typeof call.nativeId !== 'string') {
    fail(`${path}.nativeId`, 'string');
  }
  const args = plainObject(call.args, `${path}.args`) as JsonObject;
  return {
    args: cloneJson(args),
    canonicalId: call.canonicalId,
    name: call.name,
    ...(call.nativeId !== undefined ? { nativeId: call.nativeId } : {}),
    partIndex: call.partIndex as number,
  };
}

function stateMatchesMessage(
  state: GoogleProviderReplayState,
  message: CanonicalMessage,
): boolean {
  if (
    message.role !== 'assistant' ||
    !Array.isArray(message.content) ||
    state.parts.length > MAX_PROVIDER_REPLAY_PARTS ||
    state.calls.length > MAX_PROVIDER_REPLAY_TOOL_CALLS
  ) {
    return false;
  }
  const canonicalCalls = new Map(
    message.content
      .filter((part) => part.type === 'tool_call')
      .map((part) => [part.id, part] as const),
  );
  if (canonicalCalls.size !== state.calls.length) {
    return false;
  }
  let previousPartIndex = -1;
  const seenIds = new Set<string>();
  for (const call of state.calls) {
    if (
      call.partIndex <= previousPartIndex ||
      call.partIndex >= state.parts.length ||
      seenIds.has(call.canonicalId)
    ) {
      return false;
    }
    previousPartIndex = call.partIndex;
    seenIds.add(call.canonicalId);
    const canonical = canonicalCalls.get(call.canonicalId);
    const rawPart = state.parts[call.partIndex];
    const rawFunctionCall = isPlainObject(rawPart?.functionCall)
      ? rawPart.functionCall
      : undefined;
    if (
      !canonical ||
      !rawFunctionCall ||
      canonical.name !== call.name ||
      stableStringify(canonical.args) !== stableStringify(call.args) ||
      rawFunctionCall.name !== call.name ||
      stableStringify(rawFunctionCall.args) !== stableStringify(call.args) ||
      (call.nativeId !== undefined && rawFunctionCall.id !== call.nativeId)
    ) {
      return false;
    }
  }
  return true;
}

function plainObject(value: unknown, path: string): Record<string, unknown> {
  if (!isPlainObject(value)) {
    fail(path, 'plain_object');
  }
  return value;
}

function assertKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    fail(path, 'recognized_keys_only');
  }
}

function hasThoughtSignature(part: JsonObject): boolean {
  return (
    typeof part.thoughtSignature === 'string' ||
    typeof part.thought_signature === 'string'
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertSerializedSize(value: unknown): void {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    fail('snapshot.providerReplayState', 'serializable_json');
  }
  if (
    new TextEncoder().encode(serialized).length >
    MAX_PROVIDER_REPLAY_SNAPSHOT_BYTES
  ) {
    fail('snapshot.providerReplayState', 'bounded_serialized_size');
  }
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function fail(path: string, constraint: string): never {
  throw new InvalidConversationSnapshotError(path, constraint);
}
