import type { HookCtx, HookHandler, HookHandlers, HookName, ResolvedConfig } from './hooks';

export interface PluginInitApi {
  config: ResolvedConfig;
}

export interface PluginContribution {
  name: string;
  events?: Partial<HookHandlers>;
  ctx?: (ctx: HookCtx) => Record<string, unknown>;
  config?: Partial<ResolvedConfig>;
}

export type Plugin = (api: PluginInitApi) => PluginContribution | Promise<PluginContribution>;

export interface ComposedPluginCtxBuilder {
  name: string;
  build: (ctx: HookCtx) => Record<string, unknown>;
}

export interface ComposedPlugins {
  events: Partial<HookHandlers>;
  ctxBuilders: ComposedPluginCtxBuilder[];
  configFragments: Array<Partial<ResolvedConfig>>;
  names: string[];
}

type AnyHandler = HookHandler<HookName>;
type EventsAccumulator = { [K in HookName]?: AnyHandler[] };

function pushHandler(acc: EventsAccumulator, name: HookName, handler: AnyHandler): void {
  const list = acc[name] ?? [];
  list.push(handler);
  acc[name] = list;
}

function chainHandlers(handlers: AnyHandler[]): AnyHandler {
  return async (ctx, payload) => {
    let last: unknown = undefined;
    for (const h of handlers) {
      const ret = await h(ctx, payload);
      if (ret !== undefined) last = ret;
    }
    return last as never;
  };
}

export async function composePlugins(
  plugins: Plugin[],
  api: PluginInitApi,
): Promise<ComposedPlugins> {
  const eventsAcc: EventsAccumulator = {};
  const ctxBuilders: ComposedPluginCtxBuilder[] = [];
  const configFragments: Array<Partial<ResolvedConfig>> = [];
  const names: string[] = [];
  const seen = new Set<string>();

  for (const plugin of plugins) {
    const contrib = await plugin(api);
    if (seen.has(contrib.name)) {
      throw new Error(`composePlugins: duplicate plugin name "${contrib.name}"`);
    }
    seen.add(contrib.name);
    names.push(contrib.name);

    if (contrib.events) {
      for (const key of Object.keys(contrib.events) as HookName[]) {
        const handler = contrib.events[key];
        if (handler) pushHandler(eventsAcc, key, handler as unknown as AnyHandler);
      }
    }
    if (contrib.ctx) {
      ctxBuilders.push({ name: contrib.name, build: contrib.ctx });
    }
    if (contrib.config) {
      configFragments.push(contrib.config);
    }
  }

  const events: Partial<HookHandlers> = {};
  for (const key of Object.keys(eventsAcc) as HookName[]) {
    const list = eventsAcc[key];
    if (!list || list.length === 0) continue;
    const composed = list.length === 1 ? list[0] : chainHandlers(list);
    (events as Record<HookName, AnyHandler>)[key] = composed;
  }

  return { events, ctxBuilders, configFragments, names };
}

export function applyPluginCtx(ctx: HookCtx, builders: ComposedPluginCtxBuilder[]): void {
  const merged: Record<string, unknown> = { ...(ctx.plugins as Record<string, unknown>) };
  for (const b of builders) {
    merged[b.name] = b.build(ctx);
  }
  (ctx as unknown as { plugins: Record<string, unknown> }).plugins = merged;
}
