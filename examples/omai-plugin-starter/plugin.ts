import type { Plugin, PluginContribution } from 'taskflowjs/core';

export interface OmaiOptions {
  uiTars?: { endpoint: string; apiKey?: string };
  recordVideo?: boolean;
  proofDir?: string;
}

export interface OmaiApi {
  captureScreen: (name: string) => Promise<string>;
  driveUiTars: (instruction: string) => Promise<{ ok: boolean; transcript?: string }>;
}

export function omaiTaskflow(opts: OmaiOptions = {}): Plugin {
  return (_api): PluginContribution => ({
    name: 'omai',
    events: {
      afterSpawn: async (ctx) => {
        if (opts.recordVideo) {
          ctx.logger.info('[omai] would start screen recording here (stub)');
        }
      },
      beforeToolCall: async (ctx) => {
        if (ctx.event && ctx.event.t === 'tool') {
          ctx.logger.debug('[omai] pre-action snapshot stub — tool: ' + ctx.event.name);
        }
      },
      afterTaskDone: async (ctx, { spec }) => {
        if (opts.recordVideo) {
          ctx.logger.info('[omai] would finalize recording + attach to proof for ' + spec.id);
        }
        await ctx.proof.captureJson('omai-summary', { leafId: spec.id, endpoint: opts.uiTars?.endpoint ?? null });
      },
    },
    ctx: (ctx): OmaiApi => ({
      captureScreen: async (name: string) => {
        return ctx.proof.captureJson(`screen-${name}`, {
          stub: true,
          message: 'OMAI starter: wire a real screen capture here (e.g. playwright.screenshot, scrcpy, xdotool)',
        });
      },
      driveUiTars: async (instruction: string) => {
        if (!opts.uiTars?.endpoint) {
          return { ok: false, transcript: 'OMAI starter: uiTars.endpoint not configured' };
        }
        return { ok: true, transcript: `OMAI starter: would POST to ${opts.uiTars.endpoint} with "${instruction}"` };
      },
    }),
  });
}

declare module 'taskflowjs/core' {
  interface PluginNamespaces {
    omai: OmaiApi;
  }
}
