import { defineConfig } from '../../../../core/config';

export default defineConfig({
  events: {
    afterSession: async (_ctx, payload) => {
      (globalThis as unknown as { __taskflow_test_afterSession?: string }).__taskflow_test_afterSession =
        payload.spec.id;
    },
  },
  todos: { maxRetries: 5 },
});
