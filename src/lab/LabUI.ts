import { StockingQuotaStage } from '../engine/StockingQuotaStage';
import {
  DEFAULT_PHYSICS_CONFIG,
  DEFAULT_VISUAL_CONFIG,
  PhysicsConfig,
  StageTelemetry,
  STOCKING_PRESETS,
  StockingVisualConfig,
} from '../engine/types';

interface SliderDef {
  id: string;
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  format?: (v: number) => string;
  onChange: (v: number) => void;
}

export class LabUI {
  private readonly root: HTMLElement;
  private stage!: StockingQuotaStage;

  private hudFpsEl!: HTMLElement;
  private hudQuotaEl!: HTMLElement;
  private telemetryLeftEl!: HTMLElement;
  private telemetryRightEl!: HTMLElement;
  private stageFrameEl!: HTMLElement;

  private sliderRefs = new Map<string, { input: HTMLInputElement; valEl: HTMLElement; format: (v: number) => string }>();
  private colorBaseInput!: HTMLInputElement;
  private colorHiInput!: HTMLInputElement;
  private laceToggleInput!: HTMLInputElement;
  private presetButtons = new Map<string, HTMLButtonElement>();

  constructor(root: HTMLElement) {
    this.root = root;
  }

  public async mount(): Promise<StockingQuotaStage> {
    this.root.innerHTML = `
      <main class="stage-workspace">
        <header class="stage-header">
          <div class="brand-title">
            <h1>StockingQuota Lab</h1>
            <span class="brand-badge">V0.1 丝袜物理与交互实验室</span>
          </div>
          <div class="toolbar-row">
            <div class="seg-group" id="bg-switcher" title="预览背景">
              <button class="seg-btn active" data-bg="bg-checker">透明网格</button>
              <button class="seg-btn" data-bg="bg-dark">暗色</button>
              <button class="seg-btn" data-bg="bg-light">亮色</button>
              <button class="seg-btn" data-bg="bg-desktop">模拟桌面</button>
            </div>
            <div class="seg-group" id="size-switcher" title="桌面组件尺寸">
              <button class="seg-btn active" data-size="size-lab">Lab 大屏</button>
              <button class="seg-btn" data-size="size-popup">悬停中窗</button>
              <button class="seg-btn" data-size="size-mini">迷你挂件</button>
            </div>
          </div>
        </header>

        <div class="stage-viewport-wrap">
          <div class="stage-frame size-lab bg-checker" id="stage-frame">
            <div class="hud-overlay">
              <div class="hud-pill" id="hud-quota">左腿 <strong>82%</strong> · 右腿 <strong>58%</strong></div>
              <div class="hud-pill" id="hud-fps"><strong>60</strong> FPS</div>
            </div>
            <div class="canvas-host" id="canvas-host"></div>
            <div class="hud-hint">直接用鼠标抓住任意一侧袜口向下拖拽，感受弹性阻力、布料褶皱与双手反向拉扯</div>
          </div>
        </div>

        <footer class="stage-footer">
          <div class="action-row">
            <button class="action-btn primary" id="btn-demo-left">试拉左腿袜口</button>
            <button class="action-btn primary" id="btn-demo-right">试拉右腿袜口</button>
            <button class="action-btn" id="btn-demo-edge">边缘局部斜拉</button>
            <button class="action-btn" id="btn-demo-yank">脚背半卷(8%)一把扯下</button>
            <button class="action-btn" id="btn-reset">重置默认参数</button>
          </div>
          <div class="telemetry-strip">
            <span id="tel-left">左腿 Δ0px · 拉力 0%</span>
            <span id="tel-right">右腿 Δ0px · 拉力 0%</span>
          </div>
        </footer>
      </main>

      <aside class="control-panel" id="control-panel"></aside>
    `;

    this.stageFrameEl = this.root.querySelector('#stage-frame')!;
    this.hudFpsEl = this.root.querySelector('#hud-fps')!;
    this.hudQuotaEl = this.root.querySelector('#hud-quota')!;
    this.telemetryLeftEl = this.root.querySelector('#tel-left')!;
    this.telemetryRightEl = this.root.querySelector('#tel-right')!;

    const canvasHost = this.root.querySelector('#canvas-host') as HTMLElement;
    this.stage = new StockingQuotaStage({
      container: canvasHost,
      initialLeftQuota: 82,
      initialRightQuota: 58,
      onTelemetry: (t) => this.updateTelemetry(t),
    });

    this.buildControlPanel();
    this.bindStageToolbar();

    await this.stage.init();
    return this.stage;
  }

  private bindStageToolbar(): void {
    const bgGroup = this.root.querySelector('#bg-switcher')!;
    bgGroup.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('button[data-bg]') as HTMLButtonElement | null;
      if (!btn) return;
      bgGroup.querySelectorAll('.seg-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      this.stageFrameEl.classList.remove('bg-checker', 'bg-dark', 'bg-light', 'bg-desktop');
      this.stageFrameEl.classList.add(btn.dataset.bg!);
    });

    const sizeGroup = this.root.querySelector('#size-switcher')!;
    sizeGroup.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('button[data-size]') as HTMLButtonElement | null;
      if (!btn) return;
      sizeGroup.querySelectorAll('.seg-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      this.stageFrameEl.classList.remove('size-lab', 'size-popup', 'size-mini');
      this.stageFrameEl.classList.add(btn.dataset.size!);
    });

    this.root.querySelector('#btn-demo-left')!.addEventListener('click', () => {
      this.stage.triggerDemoPull('left', 240, 0.45, 920);
    });
    this.root.querySelector('#btn-demo-right')!.addEventListener('click', () => {
      this.stage.triggerDemoPull('right', 220, 0.55, 920);
    });
    this.root.querySelector('#btn-demo-edge')!.addEventListener('click', () => {
      this.stage.triggerDemoPull('left', 260, 0.14, 980);
    });
    this.root.querySelector('#btn-demo-yank')!.addEventListener('click', () => {
      this.stage.setQuota('right', 8);
      this.setSliderValue('quota-right', 8);
      setTimeout(() => {
        this.stage.triggerDemoPull('right', 135, 0.5, 1100);
      }, 420);
    });
    this.root.querySelector('#btn-reset')!.addEventListener('click', () => {
      this.resetDefaults();
    });
  }

  private buildControlPanel(): void {
    const panel = this.root.querySelector('#control-panel') as HTMLElement;

    // 1. Quota section
    const quotaSec = this.createSection('模拟额度控制 (Quota %)', '独立驱动');
    this.addSlider(quotaSec, {
      id: 'quota-left',
      label: '左腿额度（短周期）',
      min: 0,
      max: 100,
      step: 1,
      value: 82,
      format: (v) => `${Math.round(v)}%`,
      onChange: (v) => this.stage.setQuota('left', v),
    });
    this.addSlider(quotaSec, {
      id: 'quota-right',
      label: '右腿额度（周额度）',
      min: 0,
      max: 100,
      step: 1,
      value: 58,
      format: (v) => `${Math.round(v)}%`,
      onChange: (v) => this.stage.setQuota('right', v),
    });
    panel.appendChild(quotaSec);

    // 2. Material & Shader section
    const matSec = this.createSection('丝袜材质与光影', 'Shader');

    const presetGrid = document.createElement('div');
    presetGrid.className = 'preset-grid';
    STOCKING_PRESETS.forEach((preset, idx) => {
      const btn = document.createElement('button');
      btn.className = `preset-btn${idx === 0 ? ' active' : ''}`;
      btn.innerHTML = `
        <span class="swatch" style="background:${preset.visual.color}"></span>
        <span class="preset-meta">
          <span class="preset-name">${preset.name}</span>
          <span class="preset-sub">${preset.agentHint}</span>
        </span>
      `;
      btn.addEventListener('click', () => this.applyPreset(preset.id));
      presetGrid.appendChild(btn);
      this.presetButtons.set(preset.id, btn);
    });
    matSec.appendChild(presetGrid);

    const colorRow = document.createElement('div');
    colorRow.className = 'color-row';
    colorRow.innerHTML = `
      <label class="color-field"><span>织物主色</span><input type="color" id="col-base" value="${DEFAULT_VISUAL_CONFIG.color}"></label>
      <label class="color-field"><span>柔雾提亮</span><input type="color" id="col-hi" value="${DEFAULT_VISUAL_CONFIG.highlightColor}"></label>
    `;
    matSec.appendChild(colorRow);

    const laceRow = document.createElement('label');
    laceRow.className = 'color-field';
    laceRow.style.cursor = 'pointer';
    laceRow.innerHTML = `<span>复古蕾丝花边袜口 (Lace Cuff)</span><input type="checkbox" id="chk-lace" ${DEFAULT_VISUAL_CONFIG.laceCuff ? 'checked' : ''} style="accent-color:#a78bfa;width:16px;height:16px;cursor:pointer;">`;
    matSec.appendChild(laceRow);

    this.colorBaseInput = colorRow.querySelector('#col-base')!;
    this.colorHiInput = colorRow.querySelector('#col-hi')!;
    this.laceToggleInput = laceRow.querySelector('#chk-lace')!;
    this.colorBaseInput.addEventListener('input', () => {
      this.stage.setVisualConfig({ color: this.colorBaseInput.value });
      this.clearActivePreset();
    });
    this.colorHiInput.addEventListener('input', () => {
      this.stage.setVisualConfig({ highlightColor: this.colorHiInput.value });
      this.clearActivePreset();
    });
    this.laceToggleInput.addEventListener('change', () => {
      this.stage.setVisualConfig({ laceCuff: this.laceToggleInput.checked });
    });

    const visualSliders: SliderDef[] = [
      {
        id: 'vis-denier',
        label: '丹尼尔厚度 (Denier)',
        min: 15,
        max: 85,
        step: 1,
        value: DEFAULT_VISUAL_CONFIG.denier,
        format: (v) => `${Math.round(v)}D`,
        onChange: (v) => this.stage.setVisualConfig({ denier: v }),
      },
      {
        id: 'vis-sheen',
        label: '微丝柔光 (0=纯哑光)',
        min: 0,
        max: 1.5,
        step: 0.02,
        value: DEFAULT_VISUAL_CONFIG.sheen,
        format: (v) => v.toFixed(2),
        onChange: (v) => this.stage.setVisualConfig({ sheen: v }),
      },
      {
        id: 'vis-fresnel',
        label: '天鹅绒边缘暗度 (Fresnel)',
        min: 0.4,
        max: 1.8,
        step: 0.05,
        value: DEFAULT_VISUAL_CONFIG.fresnel,
        format: (v) => v.toFixed(2),
        onChange: (v) => this.stage.setVisualConfig({ fresnel: v }),
      },
      {
        id: 'vis-wrinkle',
        label: '山峰褶皱与两侧突起 (#6)',
        min: 0,
        max: 2,
        step: 0.05,
        value: DEFAULT_VISUAL_CONFIG.wrinkleStrength,
        format: (v) => v.toFixed(2),
        onChange: (v) => this.stage.setVisualConfig({ wrinkleStrength: v }),
      },
      {
        id: 'vis-weave',
        label: '哑光微颗粒 (Velvet Grain)',
        min: 0,
        max: 2,
        step: 0.05,
        value: DEFAULT_VISUAL_CONFIG.weaveIntensity,
        format: (v) => v.toFixed(2),
        onChange: (v) => this.stage.setVisualConfig({ weaveIntensity: v }),
      },
      {
        id: 'vis-cuffh',
        label: '袜口加厚带宽 (Cuff Band)',
        min: 12,
        max: 44,
        step: 1,
        value: DEFAULT_VISUAL_CONFIG.cuffHeight,
        format: (v) => `${Math.round(v)}px`,
        onChange: (v) => this.stage.setVisualConfig({ cuffHeight: v }),
      },
      {
        id: 'vis-pinch',
        label: '袜口微勒肉阴影 (Cuff Hug)',
        min: 0,
        max: 1.8,
        step: 0.05,
        value: DEFAULT_VISUAL_CONFIG.cuffPinch,
        format: (v) => v.toFixed(2),
        onChange: (v) => this.stage.setVisualConfig({ cuffPinch: v }),
      },
    ];
    visualSliders.forEach((s) => this.addSlider(matSec, s));
    panel.appendChild(matSec);

    // 3. Physics & Tactile Feel section
    const physSec = this.createSection('弹性物理与拖拽手感', '240Hz 求解');
    const physSliders: SliderDef[] = [
      {
        id: 'phy-stiff',
        label: '回弹刚度 (Stiffness)',
        min: 80,
        max: 360,
        step: 5,
        value: DEFAULT_PHYSICS_CONFIG.stiffness,
        format: (v) => `${Math.round(v)}`,
        onChange: (v) => this.stage.setPhysicsConfig({ stiffness: v }),
      },
      {
        id: 'phy-nonlin',
        label: '非线性阻力递增 (Resistance)',
        min: 0.2,
        max: 6.0,
        step: 0.1,
        value: DEFAULT_PHYSICS_CONFIG.nonLinearResistance,
        format: (v) => `${v.toFixed(1)}×`,
        onChange: (v) => this.stage.setPhysicsConfig({ nonLinearResistance: v }),
      },
      {
        id: 'phy-damp',
        label: '回弹阻尼比 (Damping ζ)',
        min: 0.22,
        max: 0.95,
        step: 0.02,
        value: DEFAULT_PHYSICS_CONFIG.damping,
        format: (v) => v.toFixed(2),
        onChange: (v) => this.stage.setPhysicsConfig({ damping: v }),
      },
      {
        id: 'phy-couple',
        label: '鼠标牵引比 (Drag Coupling)',
        min: 0.6,
        max: 2.8,
        step: 0.05,
        value: DEFAULT_PHYSICS_CONFIG.dragCoupling,
        format: (v) => v.toFixed(2),
        onChange: (v) => this.stage.setPhysicsConfig({ dragCoupling: v }),
      },
      {
        id: 'phy-cuffel',
        label: '袜口横向绷紧度 (Flat ↔ Curved)',
        min: 0.1,
        max: 1.0,
        step: 0.02,
        value: DEFAULT_PHYSICS_CONFIG.cuffElasticity,
        format: (v) => v.toFixed(2),
        onChange: (v) => this.stage.setPhysicsConfig({ cuffElasticity: v }),
      },
      {
        id: 'phy-hand',
        label: '双手反向拉扯阻力 (Hand Pull)',
        min: 0,
        max: 0.9,
        step: 0.02,
        value: DEFAULT_PHYSICS_CONFIG.handCounterStrength,
        format: (v) => v.toFixed(2),
        onChange: (v) => this.stage.setPhysicsConfig({ handCounterStrength: v }),
      },
    ];
    physSliders.forEach((s) => this.addSlider(physSec, s));
    panel.appendChild(physSec);
  }

  private createSection(title: string, tag: string): HTMLElement {
    const sec = document.createElement('section');
    sec.className = 'panel-section';
    sec.innerHTML = `<h2 class="section-title"><span>${title}</span><span style="opacity:.65;font-weight:500">${tag}</span></h2>`;
    return sec;
  }

  private addSlider(parent: HTMLElement, def: SliderDef): void {
    const fmt = def.format ?? ((v) => String(v));
    const wrap = document.createElement('div');
    wrap.className = 'slider-field';
    wrap.innerHTML = `
      <div class="slider-header">
        <span class="slider-label">${def.label}</span>
        <span class="slider-val">${fmt(def.value)}</span>
      </div>
      <input type="range" id="${def.id}" min="${def.min}" max="${def.max}" step="${def.step}" value="${def.value}" />
    `;
    const input = wrap.querySelector('input')!;
    const valEl = wrap.querySelector('.slider-val') as HTMLElement;
    input.addEventListener('input', () => {
      const v = parseFloat(input.value);
      valEl.textContent = fmt(v);
      def.onChange(v);
    });
    parent.appendChild(wrap);
    this.sliderRefs.set(def.id, { input, valEl, format: fmt });
  }

  private setSliderValue(id: string, value: number): void {
    const ref = this.sliderRefs.get(id);
    if (!ref) return;
    ref.input.value = String(value);
    ref.valEl.textContent = ref.format(value);
  }

  private clearActivePreset(): void {
    this.presetButtons.forEach((b) => b.classList.remove('active'));
  }

  private applyPreset(presetId: string): void {
    const preset = STOCKING_PRESETS.find((p) => p.id === presetId);
    if (!preset) return;
    this.clearActivePreset();
    this.presetButtons.get(presetId)?.classList.add('active');

    const merged: StockingVisualConfig = { ...this.stage.visualConfig, ...preset.visual };
    this.stage.setVisualConfig(merged);

    this.colorBaseInput.value = merged.color;
    this.colorHiInput.value = merged.highlightColor;
    this.laceToggleInput.checked = merged.laceCuff;
    this.setSliderValue('vis-denier', merged.denier);
    this.setSliderValue('vis-sheen', merged.sheen);
    this.setSliderValue('vis-fresnel', merged.fresnel);
    this.setSliderValue('vis-wrinkle', merged.wrinkleStrength);
    this.setSliderValue('vis-weave', merged.weaveIntensity);
  }

  private resetDefaults(): void {
    this.stage.setQuota('left', 82);
    this.stage.setQuota('right', 58);
    this.setSliderValue('quota-left', 82);
    this.setSliderValue('quota-right', 58);

    const defVis: StockingVisualConfig = { ...DEFAULT_VISUAL_CONFIG };
    this.stage.setVisualConfig(defVis);
    this.applyPreset(STOCKING_PRESETS[0].id);
    this.setSliderValue('vis-cuffh', defVis.cuffHeight);
    this.setSliderValue('vis-pinch', defVis.cuffPinch);

    const defPhy: PhysicsConfig = { ...DEFAULT_PHYSICS_CONFIG };
    this.stage.setPhysicsConfig(defPhy);
    this.setSliderValue('phy-stiff', defPhy.stiffness);
    this.setSliderValue('phy-nonlin', defPhy.nonLinearResistance);
    this.setSliderValue('phy-damp', defPhy.damping);
    this.setSliderValue('phy-couple', defPhy.dragCoupling);
    this.setSliderValue('phy-cuffel', defPhy.cuffElasticity);
    this.setSliderValue('phy-hand', defPhy.handCounterStrength);
  }

  private updateTelemetry(t: StageTelemetry): void {
    this.hudFpsEl.innerHTML = `<strong>${t.fps}</strong> FPS · ${t.frameTimeMs}ms`;
    this.hudQuotaEl.innerHTML = `左腿 <strong>${Math.round(t.left.quotaPct)}%</strong> · 右腿 <strong>${Math.round(t.right.quotaPct)}%</strong>`;

    const fmtLeg = (name: string, leg: StageTelemetry['left']) => {
      if (leg.isPulledOff || leg.shieldEngagement > 0.35) {
        return `${name} <b>已扯下 · 双手遮挡中</b>`;
      }
      if (leg.quotaPct <= 0.5) {
        return `${name} <b>光脚 (0%)</b>`;
      }
      if (leg.instepRoll > 0.35) {
        return `${name} <b>脚背半卷</b> · 拉力 <b>${Math.round(leg.tension * 100)}%</b>`;
      }
      return `${name} <b>Δ${Math.round(leg.displacementPx)}px</b> · 拉力 <b>${Math.round(leg.tension * 100)}%</b> · 双手 <b>${Math.round(leg.handEngagement * 100)}%</b>`;
    };

    this.telemetryLeftEl.innerHTML = fmtLeg('左腿', t.left);
    this.telemetryRightEl.innerHTML = fmtLeg('右腿', t.right);
  }
}
