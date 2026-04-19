import { taskflow } from 'taskflowjs';

async function main(): Promise<void> {
  await taskflow('example-hello').run(async ({ phase, session }) => {
    const greeting = await phase('greet', () =>
      session('hello', {
        with: 'claude-code:sonnet',
        task: 'Say hello and return a short friendly greeting string.',
        timeoutMs: 60_000,
      }),
    );
    console.log(`[example-hello] ${String(greeting).trim()}`);
  });
}

void main();
