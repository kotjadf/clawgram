import { RuntimeMap } from './types';
import { createChannelPlugin } from './channel';
import { getTelegramUserbotCliDescriptors, registerTelegramUserbotCli } from './cli';
import { registerFoldersGatewayMethod } from './folders-gateway';

const plugin = {
  id: 'clawgram',
  name: 'Clawgram',
  description: "Connect your personal Telegram account to OpenClaw via MTProto. Your AI assistant responds as you.",

  register(api: any): void {
    const runtimes: RuntimeMap = new Map();

    api.registerCli(({ program, config }: { program: any; config: any }) => {
      registerTelegramUserbotCli(program, config);
    }, {
      commands: getTelegramUserbotCliDescriptors().map((entry) => entry.name),
      descriptors: getTelegramUserbotCliDescriptors()
    });

    // api.runtime carries the media-understanding pipeline; without it an
    // inbound voice note has nothing to be turned into words with.
    const channel = createChannelPlugin(runtimes, api?.runtime);
    api.registerChannel({ plugin: channel });

    // The folder picker's read. `message.action` refuses actions core has no
    // name for, so `folders` gets a gateway method of its own — operator RPC,
    // never a tool the agent is offered.
    registerFoldersGatewayMethod(api, {
      runtimes,
      handleAction: (input) => channel.actions.handleAction(input),
      currentConfig: () => api?.runtime?.config?.current?.() ?? api?.config,
    });
  }
};

export default plugin;
