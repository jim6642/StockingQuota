/**
 * dsh-stocking-quota-bridge (Client half — DSH Web ModuleLoader CJS factory).
 * Mounts an invisible zero-UI observer (`return null`) in `conversation.composer.dock` to subscribe to
 * DSH's official `@deepseek-ai/dsh-token-meter` `contextPressure` projection, active session,
 * and active model directory — matching DSH's native ContextMeter 1:1 on every turn, session
 * switch, and model switch.
 */
window.__ModuleLoader__.load({
  id: 'dsh-stocking-quota-bridge',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const React = require('react');
    const { memo, useCallback, useEffect, useMemo, useRef, useSyncExternalStore } = React;

    const EMPTY_DIR = { current: null, groups: [], status: 'idle' };

    function resolveModelName(dirState) {
      if (!dirState || !dirState.current) return '';
      const { provider, model } = dirState.current;
      if (Array.isArray(dirState.groups)) {
        for (const g of dirState.groups) {
          if (g && g.id === provider && Array.isArray(g.models)) {
            const found = g.models.find((m) => m && m.id === model);
            if (found && found.name) return String(found.name);
          }
        }
      }
      return model ? String(model) : '';
    }

    const ContextBridgeObserver = memo(function ContextBridgeObserver(props) {
      const { useSession, useProjection, sessionId: sessionIdProp, modelDirectory } = props;

      const sessionId = (typeof useSession === 'function' ? useSession((s) => s && s.sessionId) : undefined) ?? sessionIdProp ?? '';
      const pressure = typeof useProjection === 'function' ? useProjection('contextPressure') : undefined;

      const subscribe = useCallback(
        (fn) => (modelDirectory && typeof modelDirectory.subscribe === 'function' ? modelDirectory.subscribe(fn) : () => {}),
        [modelDirectory]
      );
      const getSnapshot = useCallback(
        () => (modelDirectory && typeof modelDirectory.getSnapshot === 'function' ? modelDirectory.getSnapshot() : EMPTY_DIR),
        [modelDirectory]
      );
      const dirState = useSyncExternalStore(subscribe, getSnapshot);
      const modelName = useMemo(() => resolveModelName(dirState), [dirState]);

      const projectedTokens =
        pressure && typeof pressure.projectedTokens === 'number' && Number.isFinite(pressure.projectedTokens)
          ? pressure.projectedTokens
          : null;
      const pressureTokens =
        pressure && typeof pressure.pressureTokens === 'number' && Number.isFinite(pressure.pressureTokens)
          ? pressure.pressureTokens
          : null;
      const contextWindow =
        pressure && typeof pressure.contextWindow === 'number' && Number.isFinite(pressure.contextWindow)
          ? pressure.contextWindow
          : null;

      const lastSigRef = useRef('');
      const timerRef = useRef(null);

      useEffect(() => {
        const sig = `${sessionId}|${modelName}|${projectedTokens}|${pressureTokens}|${contextWindow}`;
        if (sig === lastSigRef.current) return;
        lastSigRef.current = sig;

        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => {
          timerRef.current = null;
          fetch('/dsh-stocking-quota/context', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              sessionId,
              model: modelName,
              projectedTokens,
              pressureTokens,
              contextWindow,
            }),
          }).catch(() => {});
        }, 120);

        return () => {
          if (timerRef.current) {
            clearTimeout(timerRef.current);
            timerRef.current = null;
          }
        };
      }, [sessionId, modelName, projectedTokens, pressureTokens, contextWindow]);

      return null;
    });

    exports.inject = ['slots'];
    exports.apply = function apply(ctx) {
      ctx.effect(() => {
        const dispose = ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register(
            {
              name: 'conversation.composer.dock',
              id: 'stocking-quota-context-bridge',
              order: 999,
              inject: (currentSessionId) => {
                try {
                  const models = ctx.get('modelDirectories');
                  if (!models || typeof models.directoryFor !== 'function') return {};
                  const directory = models.directoryFor(currentSessionId);
                  if (directory?.store?.getSnapshot?.().status === 'idle') {
                    void directory.load?.().catch(() => {});
                  }
                  return { modelDirectory: directory?.store };
                } catch {
                  return {};
                }
              },
            },
            ContextBridgeObserver
          )
        );
        return dispose;
      }, 'dsh-stocking-quota-bridge: client observer');
    };

    return module.exports;
  },
});
