import { verifyKey } from 'discord-interactions';

import { parseDiscordInteraction } from './inputs.js';
import type { DiscordInteraction } from './types.js';

export type DiscordSignatureInput = {
  rawBody: Uint8Array | string;
  signature: string | null | undefined;
  timestamp: string | null | undefined;
  publicKey: string;
};

export async function verifyDiscordSignature(input: DiscordSignatureInput) {
  if (!input.signature?.trim() || !input.timestamp?.trim() || !input.publicKey.trim()) {
    return false;
  }

  try {
    return await verifyKey(
      input.rawBody,
      input.signature.trim(),
      input.timestamp.trim(),
      input.publicKey.trim(),
    );
  } catch {
    return false;
  }
}

export async function verifyAndParseDiscordInteraction(
  input: DiscordSignatureInput,
): Promise<DiscordInteraction | null> {
  if (!(await verifyDiscordSignature(input))) {
    return null;
  }

  const text =
    typeof input.rawBody === 'string'
      ? input.rawBody
      : new TextDecoder('utf-8', { fatal: true }).decode(input.rawBody);
  return parseDiscordInteraction(JSON.parse(text) as unknown);
}
