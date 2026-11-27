import './lab/styles.css';
import { LabUI } from './lab/LabUI';
import { StockingQuotaStage } from './engine/StockingQuotaStage';

declare global {
  interface Window {
    __stockingStage?: StockingQuotaStage;
  }
}

async function bootstrap() {
  const root = document.getElementById('app');
  if (!root) return;
  const ui = new LabUI(root);
  const stage = await ui.mount();
  window.__stockingStage = stage;
}

bootstrap().catch((err) => {
  console.error('[StockingQuota] Initialization failed:', err);
});
