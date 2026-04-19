import React, { useEffect, useState } from 'react';
import { Box, render, useApp, useInput } from 'ink';
import type { EventBus } from '../core/events';
import { createTuiStore, type TuiState } from './store';
import { TreeView } from './TreeView';
import { DetailView } from './DetailView';

export type AppProps = {
  bus: EventBus;
  onSteer?: (leafId: string, text: string) => void;
  onAbortLeaf?: (leafId: string) => void;
  onQuit?: () => void;
};

type AppInnerProps = AppProps & {
  store: ReturnType<typeof createTuiStore>;
};

function App(props: AppInnerProps): React.ReactElement {
  const { store, onSteer, onAbortLeaf, onQuit } = props;
  const state = store();
  const { exit } = useApp();
  const [steerBuffer, setSteerBuffer] = useState('');
  // Live tick: drives the running-status spinner and the elapsed clock so the
  // UI updates between incoming events. 10 FPS is smooth enough for a spinner
  // without being wasteful.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 100);
    return () => clearInterval(id);
  }, []);

  useInput((input, key) => {
    if (state.focusedLeafId) {
      if (key.escape) {
        state.setFocus(undefined);
        setSteerBuffer('');
        return;
      }
      if (key.return) {
        if (steerBuffer && onSteer) {
          onSteer(state.focusedLeafId, steerBuffer);
        }
        setSteerBuffer('');
        return;
      }
      if (key.backspace || key.delete) {
        setSteerBuffer(b => b.slice(0, -1));
        return;
      }
      // Accumulate printable input.
      if (input && !key.ctrl && !key.meta) {
        setSteerBuffer(b => b + input);
      }
      return;
    }

    // Tree mode.
    if (key.upArrow) {
      state.moveSelection(-1);
      return;
    }
    if (key.downArrow) {
      state.moveSelection(1);
      return;
    }
    if (key.return) {
      const id = state.selectedNodeId();
      if (id) {
        const n = state.nodes[id];
        if (n?.kind === 'leaf') state.setFocus(id);
        else if (n?.kind === 'stage') state.toggleCollapsed(id);
      }
      return;
    }
    if (input === 'a') {
      const id = state.selectedNodeId();
      if (id && state.nodes[id]?.kind === 'leaf' && onAbortLeaf) {
        onAbortLeaf(id);
      }
      return;
    }
    if (input === 'q') {
      if (onQuit) onQuit();
      exit();
    }
  });

  if (state.focusedLeafId) {
    return (
      <Box flexDirection="column">
        <DetailView
          state={state}
          leafId={state.focusedLeafId}
          steerBuffer={steerBuffer}
          onSteer={text =>
            state.focusedLeafId && onSteer?.(state.focusedLeafId, text)
          }
          onAbort={() =>
            state.focusedLeafId && onAbortLeaf?.(state.focusedLeafId)
          }
          onBack={() => state.setFocus(undefined)}
        />
      </Box>
    );
  }

  return <TreeView state={state} tick={tick} />;
}

export function mountTui(
  bus: EventBus,
  handlers?: Pick<AppProps, 'onSteer' | 'onAbortLeaf' | 'onQuit'>,
): () => void {
  const store = createTuiStore(bus);
  // Rendering inline (not in the terminal's alt-screen buffer) so native
  // mouse-wheel scrolling, selection, copy, etc. continue to work. The
  // trade-off is that switching between TreeView and DetailView may leave
  // short-lived scrollback, which is a reasonable price to keep the
  // terminal feeling native.
  const { unmount } = render(
    <App
      bus={bus}
      store={store}
      onSteer={handlers?.onSteer}
      onAbortLeaf={handlers?.onAbortLeaf}
      onQuit={handlers?.onQuit}
    />,
  );
  return () => unmount();
}

export function streamHeadless(bus: EventBus): () => void {
  const unsub = bus.subscribe(ev => {
    console.log(JSON.stringify(ev));
  });
  return unsub;
}

// Test-only helper so the test file can render with a pre-seeded store and
// simulate stdin input. Exported but intentionally undocumented.
export { App as __App };
export { createTuiStore };
export type { TuiState };
