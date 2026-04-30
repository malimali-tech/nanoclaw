import {
  Channel,
  ChatDiscovery,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface ChannelOpts {
  onMessage: OnInboundMessage;
  registeredGroups: () => Record<string, RegisteredGroup>;
  /**
   * Channels call this when they observe a chat the bot can talk in.
   * Idempotent on the host side — channels don't need to dedup. Optional
   * because not every channel can detect "bot was added"; channels that
   * don't implement it just rely on the host treating each first inbound
   * message as discovery.
   */
  onChatDiscovered?: (discovery: ChatDiscovery) => void;
}

export type ChannelFactory = (opts: ChannelOpts) => Channel | null;

const registry = new Map<string, ChannelFactory>();

export function registerChannel(name: string, factory: ChannelFactory): void {
  registry.set(name, factory);
}

export function getChannelFactory(name: string): ChannelFactory | undefined {
  return registry.get(name);
}

export function getRegisteredChannelNames(): string[] {
  return [...registry.keys()];
}
