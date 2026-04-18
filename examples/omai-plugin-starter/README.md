# OMAI Taskflow Plugin — Starter

Scaffold for an opinionated downstream plugin that layers proof capture and UI-TARS-driven vision testing onto `taskflow-sdk`. This starter ships stubs; the real plugin implements screen capture and UI-TARS orchestration.

## What the final plugin will do

- Record screen/video for every session the harness runs.
- Snap pre-action frames on every `beforeToolCall`.
- Drive [UI-TARS](https://github.com/bytedance/UI-TARS) from `ctx.plugins.omai.driveUiTars("click submit")` — OS-agnostic, vision-based UI automation.
- Attach all captured artifacts to the session's `proof.json` so `npm run plan`, CI, and downstream consumers see the evidence trail.

## What this starter is

A compilable skeleton you copy into your own repo, rename, and fill in:

```ts
import { taskflow } from 'taskflow-sdk';
import { defineConfig } from 'taskflow-sdk/config';
import { omaiTaskflow } from './examples/omai-plugin-starter/plugin';

export default defineConfig({
  plugins: [
    omaiTaskflow({
      uiTars: { endpoint: 'https://your-uitars.example.com', apiKey: process.env.UITARS_KEY },
      recordVideo: true,
      proofDir: 'data/omai-proof',
    }),
  ],
});
```

Inside any hook:

```ts
afterTaskDone: async (ctx, { spec }) => {
  await ctx.plugins.omai.captureScreen('final-state');
  const verdict = await ctx.plugins.omai.driveUiTars('verify the submit button is visible');
  if (!verdict.ok) throw new Error('UI-TARS verify failed for ' + spec.id);
}
```

## Plugin shape

See [`plugin.ts`](./plugin.ts). The factory returns a `PluginContribution` with:

- `name: 'omai'` — keys `ctx.plugins.omai` at runtime.
- `events`: `afterSpawn`, `beforeToolCall`, `afterTaskDone` stubs.
- `ctx`: builds the `ctx.plugins.omai` namespace with `captureScreen` and `driveUiTars`.
- `declare module 'taskflow-sdk/core'` augmentation so TypeScript knows about `ctx.plugins.omai`.

## Replace the stubs

| Stub | What it should become |
|---|---|
| `captureScreen` | Real screen grab: playwright / scrcpy / xdotool / AppleScript `screencapture`. |
| `driveUiTars` | HTTP call to your UI-TARS endpoint; stream the transcript back. |
| `afterSpawn` recording start | Spawn `ffmpeg` or a platform recorder; store the handle on `ctx.state` keyed by leaf id. |
| `afterTaskDone` finalize | Kill the recorder, write the video into `ctx.proof.captureFile(...)`, update `proof.json`. |

## Why it lives in the taskflow-sdk repo as an example

This is a scaffold, not a published package. When you're ready to ship, copy it to a new repo `omai-taskflow` and publish as a separate npm package that depends on `taskflow-sdk`.

## License

MIT.
