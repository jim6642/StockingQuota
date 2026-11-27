/**
 * dsh-stocking-quota-bridge (Client half — DSH Web ModuleLoader CJS factory).
 * Mounts an invisible 0x0 observer in `conversation.composer.dock` to subscribe to:
 *   1. DSH's official `@deepseek-ai/dsh-token-meter` `contextPressure` projection, active session,
 *      and active model directory — matching DSH's native ContextMeter 1:1.
 *   2. The exact live DOM bounding box (`meterRect`) of the ContextMeter (`2%` ring) via ResizeObserver,
 *      so opening/closing DSH's right browser panel or left sidebar keeps the hover hotspot 100% locked!
 */
window.__ModuleLoader__.load({
  id: 'dsh-stocking-quota-bridge',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const React = require('react');
    const { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } = React;

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

    function findDockContainer(anchorEl) {
      if (!anchorEl) return null;
      let cur = anchorEl.parentElement;
      let best = cur;
      for (let i = 0; i < 4 && cur; i++) {
        const r = cur.getBoundingClientRect();
        if (r.width >= 160 && r.height >= 16 && r.height <= 96) {
          best = cur;
        }
        cur = cur.parentElement;
      }
      return best;
    }

    function measureContextMeterRect(anchorEl) {
      if (!anchorEl || typeof window === 'undefined') return null;
      const vw = Math.round(window.innerWidth || 0);
      const vh = Math.round(window.innerHeight || 0);
      if (vw < 100 || vh < 100) return null;

      const dock = findDockContainer(anchorEl);
      if (!dock) return null;

      let targetRect = null;
      try {
        const nodes = dock.querySelectorAll('button, [role="button"], span, div');
        // Pass 1: find exact compact `%` indicator (e.g. "2%") excluding cache-hit ("缓存命中") & cumulative tokens ("tok")
        for (let i = nodes.length - 1; i >= 0; i--) {
          const el = nodes[i];
          if (el === anchorEl) continue;
          const text = (el.textContent || '').trim();
          if (!text || text.length > 14) continue;
          if (/缓存|cache|tok/i.test(text)) continue;
          if (!/^\d{1,3}(\.\d+)?%$/.test(text)) continue;

          // Climb to its compact wrapper that contains the circular SVG + percentage label
          let box = el;
          let p = el.parentElement;
          for (let k = 0; k < 3 && p && p !== dock; k++) {
            const pr = p.getBoundingClientRect();
            const pt = (p.textContent || '').trim();
            if (pr.width >= 24 && pr.width <= 150 && pr.height >= 14 && pr.height <= 46 && !/缓存|cache|tok/i.test(pt)) {
              box = p;
              if (p.querySelector('svg')) break;
            }
            p = p.parentElement;
          }
          const r = box.getBoundingClientRect();
          if (r.width >= 16 && r.height >= 12 && r.bottom <= vh + 4 && r.top >= vh - 140) {
            targetRect = r;
            break;
          }
        }

        // Pass 2: fallback to rightmost visible icon/pill in dock row (e.g. brand-new chat before first turn)
        if (!targetRect) {
          const dockRect = dock.getBoundingClientRect();
          if (dockRect.width >= 120 && dockRect.height >= 14) {
            const w = 54;
            const h = Math.max(20, Math.min(34, dockRect.height));
            targetRect = {
              left: dockRect.right - w - 6,
              top: dockRect.top + (dockRect.height - h) * 0.5,
              width: w,
              height: h,
            };
          }
        }
      } catch {}

      if (!targetRect) return null;
      return {
        x: Math.round(targetRect.left),
        y: Math.round(targetRect.top),
        width: Math.max(24, Math.round(targetRect.width)),
        height: Math.max(18, Math.round(targetRect.height)),
        viewportW: vw,
        viewportH: vh,
      };
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

      const anchorRef = useRef(null);
      const [layoutTick, setLayoutTick] = useState(0);
      const lastSigRef = useRef('');
      const timerRef = useRef(null);

      // Watch window resize & right/left split-pane toggles via ResizeObserver so meterRect updates immediately!
      useEffect(() => {
        let rafId = null;
        const bump = () => {
          if (rafId !== null) return;
          rafId = requestAnimationFrame(() => {
            rafId = null;
            setLayoutTick((v) => (v + 1) % 1000000);
          });
        };

        const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(bump) : null;
        if (ro) {
          if (document.body) ro.observe(document.body);
          const dock = findDockContainer(anchorRef.current);
          if (dock) ro.observe(dock);
          if (dock && dock.parentElement) ro.observe(dock.parentElement);
        }
        window.addEventListener('resize', bump);
        const settleTimer = setTimeout(bump, 350);

        return () => {
          clearTimeout(settleTimer);
          if (rafId !== null) cancelAnimationFrame(rafId);
          window.removeEventListener('resize', bump);
          if (ro) ro.disconnect();
        };
      }, [sessionId]);

      useEffect(() => {
        const meterRect = measureContextMeterRect(anchorRef.current);
        const rectSig = meterRect
          ? `${meterRect.x},${meterRect.y},${meterRect.width},${meterRect.height},${meterRect.viewportW},${meterRect.viewportH}`
          : 'none';
        const sig = `${sessionId}|${modelName}|${projectedTokens}|${pressureTokens}|${contextWindow}|${rectSig}`;
        if (sig === lastSigRef.current) return;
        lastSigRef.current = sig;

        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => {
          timerRef.current = null;
          const freshRect = measureContextMeterRect(anchorRef.current) || meterRect;
          fetch('/dsh-stocking-quota/context', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              sessionId,
              model: modelName,
              projectedTokens,
              pressureTokens,
              contextWindow,
              meterRect: freshRect,
            }),
          }).catch(() => {});
        }, 90);

        return () => {
          if (timerRef.current) {
            clearTimeout(timerRef.current);
            timerRef.current = null;
          }
        };
      }, [sessionId, modelName, projectedTokens, pressureTokens, contextWindow, layoutTick]);

      return React.createElement('span', {
        ref: anchorRef,
        'aria-hidden': 'true',
        style: {
          position: 'absolute',
          width: 0,
          height: 0,
          overflow: 'hidden',
          pointerEvents: 'none',
        },
      });
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
