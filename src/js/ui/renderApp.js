/**
 * renderApp.js
 * Renders ONLY the UI chrome: menubar, toolbar, statusbar, inspector shell.
 * NEVER touches #canvas-layer-root or #annotation-layer-root.
 * Uses targeted DOM updates with no full redraw of the editor layers.
 */

import { buildMenuModel, buildToolbarModel } from './ShellModel.js';
import { eventBus } from '../core/EventBus.js';

const WORD_THEME_COLORS = [
  { label: '黑色', value: '#000000' },
  { label: '灰色', value: '#666666' },
  { label: '藍色', value: '#4472C4' },
  { label: '青綠', value: '#5B9BD5' },
  { label: '綠色', value: '#70AD47' },
  { label: '金色', value: '#FFC000' },
  { label: '橘色', value: '#ED7D31' },
  { label: '紅色', value: '#C00000' },
  { label: '紫色', value: '#7030A0' },
];

const WORD_HIGHLIGHT_COLORS = [
  { label: '黃色', value: '#FFF200' },
  { label: '綠色', value: '#92D050' },
  { label: '青色', value: '#00B0F0' },
  { label: '藍色', value: '#4F81BD' },
  { label: '紅色', value: '#FF5050' },
  { label: '粉紅', value: '#FF66CC' },
];

const ROTATION_OPTIONS = [
  ['0', '0°'],
  ['90', '90°'],
  ['180', '180°'],
  ['270', '270°'],
];

export class AppRenderer {
  #menubar = document.getElementById('menubar');
  #toolbar = document.getElementById('toolbar');
  #statusPage = document.getElementById('status-page');
  #statusZoom = document.getElementById('status-zoom');
  #statusFile = document.getElementById('status-filename');
  #statusDot = document.getElementById('status-dot');
  #statusSave = document.getElementById('status-save');
  #emptyState = document.getElementById('empty-state');
  #inspector = document.getElementById('inspector');
  #progressOverlay = document.getElementById('progress-overlay');
  #progressBar = document.getElementById('progress-bar');
  #progressLabel = document.getElementById('progress-label');
  #toastHost = document.getElementById('toast-host');

  #activeMenuId = null;

  init() {
    this.#bindGlobalEvents();
  }

  renderShell(state, cmdState) {
    const menuModel = buildMenuModel({ ...state, ...cmdState });
    const toolbarModel = buildToolbarModel(state);

    this.#renderMenubar(menuModel);
    this.#renderToolbar(toolbarModel);
    this.#renderStatusbar(state);

    const hasDoc = state.documentStatus === 'ready';
    this.#emptyState.classList.toggle('hidden', hasDoc);
  }

  showProgress(pct, label = '正在載入…') {
    this.#progressOverlay.classList.remove('hidden');
    this.#progressBar.style.width = `${pct}%`;
    this.#progressLabel.textContent = label;
  }

  hideProgress() {
    this.#progressOverlay.classList.add('hidden');
  }

  toast(message, type = 'info', duration = 3000) {
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = message;
    this.#toastHost.appendChild(el);
    if (duration > 0) setTimeout(() => el.remove(), duration);
  }

  setSaveStatus(status) {
    this.#statusDot.className = 'statusbar-dot' + (status !== 'saved' ? ` ${status}` : '');
    this.#statusSave.textContent = {
      saved: '已儲存',
      saving: '儲存中',
      error: '儲存失敗',
    }[status] ?? '未儲存';
  }

  renderInspector(state, annotation = null) {
    this.#inspector.innerHTML = '';

    const summary = document.createElement('section');
    summary.className = 'inspector-card';
    summary.innerHTML = `
      <div class="inspector-section-title">文件資訊</div>
      <div class="inspector-grid">
        <div class="inspector-field"><span>狀態</span><strong>${state.documentStatus}</strong></div>
        <div class="inspector-field"><span>頁面</span><strong>${state.currentPage} / ${state.pageCount}</strong></div>
        <div class="inspector-field"><span>縮放</span><strong>${Math.round((state.zoom ?? 1) * 100)}%</strong></div>
        <div class="inspector-field"><span>工具</span><strong>${state.selectedTool}</strong></div>
      </div>
    `;
    this.#inspector.appendChild(summary);

    this.#inspector.appendChild(this.#buildToolHubTabs(state.toolHubTab ?? 'all-tools'));
    this.#inspector.appendChild(this.#buildToolHubPanel(state));

    const details = document.createElement('section');
    details.className = 'inspector-card';

    if (!annotation) {
      details.innerHTML = `
        <div class="inspector-section-title">格式與屬性</div>
        <p class="inspector-empty">選取一個標註後，可在這裡調整文字、顏色、透明度與樣式。</p>
      `;
      this.#inspector.appendChild(details);
      return;
    }

    details.innerHTML = `
      <div class="inspector-section-title">標註屬性</div>
      <div class="inspector-grid">
        <div class="inspector-field"><span>類型</span><strong>${annotation.type}</strong></div>
        <div class="inspector-field"><span>所在頁</span><strong>第 ${annotation.pageNumber} 頁</strong></div>
      </div>
    `;

    const controls = document.createElement('div');
    controls.className = 'inspector-controls';

    if (annotation.type === 'signature') {
      // Signature info card
      if (annotation.signerName) {
        const sigInfo = document.createElement('div');
        sigInfo.className = 'inspector-sig-info';
        sigInfo.innerHTML = `
          <div class="inspector-field"><span>簽署人</span><strong>${annotation.signerName}</strong></div>
          ${annotation.signedAt ? `<div class="inspector-field"><span>簽署時間</span><strong>${new Date(annotation.signedAt).toLocaleString('zh-TW')}</strong></div>` : ''}
          ${annotation.signatureType ? `<div class="inspector-field"><span>方式</span><strong>${annotation.signatureType === 'draw' ? '手繪' : annotation.signatureType === 'type' ? '輸入' : annotation.signatureType}</strong></div>` : ''}
        `;
        controls.appendChild(sigInfo);
      }
      controls.appendChild(this.#buildRangeField('透明度', 'opacity', annotation.style?.opacity ?? 1, 0, 1, 0.05));
    } else {
      controls.appendChild(this.#buildColorField(annotation.type, annotation.style?.color ?? '#000000'));
      if (typeof annotation.style?.opacity === 'number') {
        controls.appendChild(this.#buildRangeField(annotation.type === 'highlight' ? '標記透明度' : '透明度', 'opacity', annotation.style.opacity, 0, 1, 0.05));
      }
    }

    if (annotation.type === 'draw' || annotation.type === 'rect' || annotation.type === 'line' || annotation.type === 'arrow' || annotation.type === 'underline' || annotation.type === 'circle' || annotation.type === 'stamp') {
      controls.appendChild(this.#buildNumberField('線條粗細', 'strokeWidth', annotation.style?.strokeWidth ?? 2, 1, 24));
    }

    if (annotation.type === 'text' || annotation.type === 'stamp') {
      controls.appendChild(this.#buildTextField('文字內容', annotation.content ?? ''));
      controls.appendChild(this.#buildNumberField('字體大小', 'fontSize', annotation.style?.fontSize ?? 12, 8, 72));
    }

    if (annotation.type === 'text' || annotation.type === 'rect' || annotation.type === 'draw' || annotation.type === 'stamp' || annotation.type === 'signature') {
      controls.appendChild(this.#buildSelectField('旋轉角度', 'rotation', String(annotation.style?.rotation ?? 0), ROTATION_OPTIONS));
    }

    const hint = document.createElement('p');
    hint.className = 'workflow-help';
    hint.textContent = annotation.type === 'text'
      ? '雙擊可直接改文字；再次點選後拖曳可移動。'
      : annotation.type === 'stamp'
        ? '拖曳可移動印章；內容與日期可直接在這裡改。'
        : '先點一下選取，再拖曳可移動；按 Delete 可刪除。';
    controls.appendChild(hint);

    const deleteButton = document.createElement('button');
    deleteButton.className = 'btn';
    deleteButton.textContent = '刪除標註';
    let confirmTimer = null;
    deleteButton.addEventListener('click', () => {
      if (deleteButton.dataset.confirm !== '1') {
        deleteButton.dataset.confirm = '1';
        deleteButton.textContent = '再次點擊確認刪除';
        clearTimeout(confirmTimer);
        confirmTimer = setTimeout(() => {
          deleteButton.dataset.confirm = '0';
          deleteButton.textContent = '刪除標註';
        }, 2200);
        return;
      }
      clearTimeout(confirmTimer);
      eventBus.emit('ui:action', { action: 'delete' });
    });
    controls.appendChild(deleteButton);

    details.appendChild(controls);
    this.#inspector.appendChild(details);
  }

  #buildToolHubTabs(activeTab) {
    const tabs = [
      ['all-tools', '所有工具'],
      ['edit', '編輯'],
      ['convert', '轉換'],
      ['esign', '電子簽署'],
    ];

    const card = document.createElement('section');
    card.className = 'inspector-card tool-hub-tabs-card';
    const row = document.createElement('div');
    row.className = 'tool-hub-tabs';

    tabs.forEach(([id, label]) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'tool-hub-tab' + (activeTab === id ? ' active' : '');
      button.textContent = label;
      button.addEventListener('click', () => {
        eventBus.emit('ui:action', { action: 'set-tool-hub-tab', value: id });
      });
      row.appendChild(button);
    });

    card.appendChild(row);
    return card;
  }

  #buildToolHubPanel(state) {
    const hasDoc = state.documentStatus === 'ready';
    const groupsByTab = {
      'all-tools': [
        {
          title: '所有工具',
          items: [
            { label: '匯出 PDF', action: 'save-as', enabled: hasDoc },
            { label: '編輯 PDF', action: 'set-tool-hub-tab', value: 'edit', enabled: hasDoc },
            { label: '建立 PDF', action: 'img2pdf', enabled: true },
            { label: '合併檔案', action: 'merge', enabled: true },
            { label: '組織頁面', action: 'set-tool-hub-tab', value: 'edit', enabled: hasDoc },
            { label: '新增註解', action: 'tool-text', enabled: hasDoc },
            { label: '轉換為 PDF', action: 'img2pdf', enabled: true },
            { label: '頁首頁尾', action: 'page-number', enabled: hasDoc },
            { label: '浮水印', action: 'watermark', enabled: hasDoc },
          ],
        },
      ],
      edit: [
        {
          title: '修改頁面',
          items: [
            { label: '旋轉頁面', action: 'rotate-cw', enabled: hasDoc },
            { label: '裁切頁面', action: 'crop-pages', enabled: hasDoc },
            { label: '刪除頁面', action: 'delete-page', enabled: hasDoc && state.pageCount > 1 },
            { label: '插入空白頁', action: 'blank-page', enabled: hasDoc },
            { label: '組織頁面', action: 'toggle-sidebar', enabled: hasDoc },
          ],
        },
        {
          title: '新增內容',
          items: [
            { label: '文字', action: 'tool-text', enabled: hasDoc },
            { label: '影像轉 PDF', action: 'img2pdf', enabled: true },
            { label: '頁首和頁尾', action: 'page-number', enabled: hasDoc },
            { label: '浮水印', action: 'watermark', enabled: hasDoc },
            { label: '合併檔案', action: 'merge', enabled: true },
          ],
        },
        {
          title: '新增註解',
          items: [
            { label: '新增文字註解', action: 'tool-text', enabled: hasDoc },
            { label: '螢光標示', action: 'tool-highlight', enabled: hasDoc },
            { label: '底線', action: 'tool-underline', enabled: hasDoc },
            { label: '矩形框', action: 'tool-rect', enabled: hasDoc },
            { label: '圓形', action: 'tool-circle', enabled: hasDoc },
            { label: '線段', action: 'tool-line', enabled: hasDoc },
            { label: '箭頭', action: 'tool-arrow', enabled: hasDoc },
            { label: '新增印章', action: 'tool-stamp', enabled: hasDoc },
            { label: '手繪簽批', action: 'tool-draw', enabled: hasDoc },
          ],
        },
      ],
      convert: [
        {
          title: '轉換',
          items: [
            { label: '匯出 PDF', action: 'save-as', enabled: hasDoc },
            { label: '圖片轉 PDF', action: 'img2pdf', enabled: true },
            { label: '拆分 PDF', action: 'split', enabled: hasDoc },
            { label: '合併檔案', action: 'merge', enabled: true },
          ],
        },
        {
          title: '離線限制',
          items: [
            { label: 'Word / PowerPoint / Excel 轉換', enabled: false, note: '離線版未提供' },
            { label: '掃描與 OCR', enabled: false, note: '需要 OCR 引擎' },
            { label: '壓縮 PDF', enabled: false, note: '尚未接入壓縮管線' },
          ],
        },
      ],
      esign: [
        {
          title: '電子簽署',
          items: [
            { label: '新增印章', enabled: false, note: '下一批補印章流程' },
            { label: '填寫和簽署', enabled: false, note: '離線簽署 UI 尚未完成' },
            { label: '保護 PDF', enabled: false, note: '目前離線版未提供加密' },
          ],
        },
      ],
    };

    const panel = document.createElement('section');
    panel.className = 'inspector-card tool-hub-card';
    (groupsByTab[state.toolHubTab ?? 'all-tools'] ?? []).forEach((group) => {
      const groupEl = document.createElement('div');
      groupEl.className = 'tool-hub-group';
      const title = document.createElement('div');
      title.className = 'inspector-section-title';
      title.textContent = group.title;
      groupEl.appendChild(title);

      const list = document.createElement('div');
      list.className = 'tool-hub-list';
      group.items.forEach((item) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'tool-hub-action';
        button.disabled = item.enabled === false;
        button.innerHTML = `
          <span class="tool-hub-action-label">${item.label}</span>
          ${item.note ? `<span class="tool-hub-action-note">${item.note}</span>` : ''}
        `;
        if (item.enabled !== false && item.action) {
          button.addEventListener('click', () => {
            eventBus.emit('ui:action', { action: item.action, value: item.value });
          });
        }
        list.appendChild(button);
      });
      groupEl.appendChild(list);
      panel.appendChild(groupEl);
    });

    return panel;
  }

  #renderMenubar(menuModel) {
    const existing = this.#menubar.querySelectorAll('[data-menu-id]');
    if (existing.length !== menuModel.length) {
      const brand = this.#menubar.querySelector('.app-brand');
      this.#menubar.innerHTML = '';
      if (brand) this.#menubar.appendChild(brand);
      for (const menu of menuModel) {
        this.#menubar.appendChild(this.#buildMenuEl(menu));
      }
      return;
    }

    for (let index = 0; index < menuModel.length; index++) {
      const el = existing[index];
      const dropdown = el.querySelector('.menu-dropdown');
      if (!dropdown) continue;
      const items = menuModel[index].items.filter((item) => item.id);
      const dropdownItems = dropdown.querySelectorAll('[data-action]');
      items.forEach((item, itemIndex) => {
        const itemEl = dropdownItems[itemIndex];
        if (itemEl) itemEl.toggleAttribute('disabled', !!item.disabled);
      });
    }
  }

  #buildMenuEl(menu) {
    const el = document.createElement('div');
    el.className = 'menu-item';
    el.setAttribute('role', 'menuitem');
    el.setAttribute('tabindex', '0');
    el.setAttribute('aria-haspopup', 'true');
    el.setAttribute('aria-expanded', 'false');
    el.setAttribute('data-menu-id', menu.id);
    el.textContent = menu.label;

    const dropdown = document.createElement('div');
    dropdown.className = 'menu-dropdown';
    dropdown.setAttribute('role', 'menu');

    for (const item of menu.items) {
      if (item.type === 'separator') {
        const sep = document.createElement('div');
        sep.className = 'menu-separator';
        sep.setAttribute('role', 'separator');
        dropdown.appendChild(sep);
        continue;
      }

      const itemEl = document.createElement('div');
      itemEl.className = 'menu-dropdown-item';
      itemEl.setAttribute('role', 'menuitem');
      itemEl.setAttribute('tabindex', '-1');
      itemEl.setAttribute('data-action', item.id);
      if (item.disabled) itemEl.setAttribute('disabled', '');
      itemEl.innerHTML = `
        <span>${item.label}</span>
        ${item.shortcut ? `<span class="shortcut">${item.shortcut}</span>` : ''}
      `;
      itemEl.addEventListener('click', (event) => {
        event.stopPropagation();
        if (!itemEl.hasAttribute('disabled')) {
          this.#closeAllMenus();
          eventBus.emit('ui:action', { action: item.id });
        }
      });
      dropdown.appendChild(itemEl);
    }

    el.appendChild(dropdown);
    el.addEventListener('click', (event) => {
      event.stopPropagation();
      const isOpen = el.getAttribute('aria-expanded') === 'true';
      this.#closeAllMenus();
      if (!isOpen) {
        el.setAttribute('aria-expanded', 'true');
        this.#activeMenuId = menu.id;
      }
    });

    return el;
  }

  #closeAllMenus() {
    this.#menubar.querySelectorAll('[aria-expanded="true"]').forEach((el) => {
      el.setAttribute('aria-expanded', 'false');
    });
    this.#activeMenuId = null;
  }

  #renderToolbar(model) {
    if (!this.#toolbar.dataset.built) {
      this.#buildToolbar(model);
      this.#toolbar.dataset.built = '1';
      return;
    }

    for (const tool of model.tools) {
      const btn = this.#toolbar.querySelector(`[data-tool="${tool.id}"]`);
      if (btn) {
        btn.classList.toggle('active', tool.active);
        btn.toggleAttribute('disabled', tool.disabled);
      }
    }

    const zoomInput = this.#toolbar.querySelector('#zoom-input');
    if (zoomInput && document.activeElement !== zoomInput) {
      zoomInput.value = `${model.zoom.value}%`;
    }

    const pageInput = this.#toolbar.querySelector('#page-input');
    const pageTotal = this.#toolbar.querySelector('#page-total');
    if (pageInput && document.activeElement !== pageInput) {
      pageInput.value = model.page.current;
    }
    if (pageTotal) pageTotal.textContent = `/ ${model.page.total}`;
  }

  #buildToolbar(model) {
    this.#toolbar.innerHTML = '';

    for (const tool of model.tools) {
      const btn = document.createElement('button');
      btn.className = 'tool-btn tool-btn--annotate' + (tool.active ? ' active' : '');
      btn.setAttribute('data-tool', tool.id);
      btn.setAttribute('aria-label', tool.label);
      btn.setAttribute('title', tool.label);
      btn.innerHTML = `<span class="tool-btn-icon" aria-hidden="true">${tool.icon}</span><span class="tool-btn-label">${tool.label}</span>`;
      if (tool.disabled) btn.setAttribute('disabled', '');
      btn.addEventListener('click', () => {
        eventBus.emit('ui:action', { action: `tool-${tool.id}` });
      });
      this.#toolbar.appendChild(btn);
    }

    const separator = document.createElement('div');
    separator.className = 'tool-separator';
    this.#toolbar.appendChild(separator);

    const zoomControl = document.createElement('div');
    zoomControl.className = 'zoom-control';
    zoomControl.innerHTML = `
      <button class="tool-btn" data-action="zoom-out" aria-label="縮小" title="縮小 (Ctrl+-)">−</button>
      <input id="zoom-input" class="zoom-input" type="text" value="${model.zoom.value}%"
             aria-label="縮放比例" inputmode="numeric">
      <button class="tool-btn" data-action="zoom-in" aria-label="放大" title="放大 (Ctrl+=)">+</button>
    `;
    this.#toolbar.appendChild(zoomControl);

    const pageNav = document.createElement('div');
    pageNav.className = 'page-nav';
    pageNav.innerHTML = `
      <button class="tool-btn" data-action="page-prev" aria-label="上一頁">‹</button>
      <input id="page-input" class="page-nav-input" type="text" value="${model.page.current}" aria-label="頁碼">
      <span id="page-total" class="page-nav-total">/ ${model.page.total}</span>
      <button class="tool-btn" data-action="page-next" aria-label="下一頁">›</button>
    `;
    this.#toolbar.appendChild(pageNav);

    this.#toolbar.addEventListener('click', (event) => {
      const btn = event.target.closest('[data-action]');
      if (btn) eventBus.emit('ui:action', { action: btn.dataset.action });
    });

    const zoomInput = this.#toolbar.querySelector('#zoom-input');
    zoomInput.addEventListener('change', () => {
      const value = parseInt(zoomInput.value, 10);
      if (!Number.isNaN(value)) {
        eventBus.emit('ui:action', { action: 'zoom-set', value: value / 100 });
      }
    });

    const pageInput = this.#toolbar.querySelector('#page-input');
    pageInput.addEventListener('change', () => {
      const value = parseInt(pageInput.value, 10);
      if (!Number.isNaN(value)) {
        eventBus.emit('ui:action', { action: 'page-navigate', page: value });
      }
    });
  }

  #renderStatusbar(state) {
    const { currentPage, pageCount, documentStatus, zoom } = state;

    if (documentStatus === 'ready') {
      this.#statusPage.textContent = `第 ${currentPage} / ${pageCount} 頁`;
      this.#statusZoom.textContent = `${Math.round(zoom * 100)}%`;
    } else {
      this.#statusPage.textContent = '—';
      this.#statusZoom.textContent = '—';
    }
  }

  #buildFieldShell(label) {
    const wrapper = document.createElement('label');
    wrapper.className = 'inspector-control';

    const labelEl = document.createElement('span');
    labelEl.className = 'form-label';
    labelEl.textContent = label;
    wrapper.appendChild(labelEl);

    return wrapper;
  }

  #buildColorField(annotationType, value) {
    const palette = annotationType === 'highlight' ? WORD_HIGHLIGHT_COLORS : WORD_THEME_COLORS;
    const wrapper = this.#buildFieldShell(annotationType === 'highlight' ? '標記色' : '顏色');
    const grid = document.createElement('div');
    grid.className = 'inspector-color-palette';

    palette.forEach((swatch) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'inspector-color-swatch' + (swatch.value.toLowerCase() === String(value).toLowerCase() ? ' active' : '');
      button.style.setProperty('--swatch-color', swatch.value);
      button.setAttribute('aria-label', swatch.label);
      button.title = swatch.label;
      button.addEventListener('click', () => {
        eventBus.emit('ui:action', {
          action: 'update-selected-annotation',
          patch: { style: { color: swatch.value } },
        });
      });
      grid.appendChild(button);
    });

    wrapper.appendChild(grid);
    return wrapper;
  }

  #buildRangeField(label, styleKey, value, min, max, step) {
    const wrapper = this.#buildFieldShell(label);
    const row = document.createElement('div');
    row.className = 'inspector-range-row';

    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(value);

    const output = document.createElement('output');
    output.textContent = Number(value).toFixed(2);

    input.addEventListener('change', () => {
      eventBus.emit('ui:action', {
        action: 'update-selected-annotation',
        patch: { style: { [styleKey]: Number(input.value) } },
      });
      output.textContent = Number(input.value).toFixed(2);
    });

    row.appendChild(input);
    row.appendChild(output);
    wrapper.appendChild(row);
    return wrapper;
  }

  #buildNumberField(label, styleKey, value, min, max) {
    const wrapper = this.#buildFieldShell(label);
    const input = document.createElement('input');
    input.type = 'number';
    input.className = 'form-input';
    input.min = String(min);
    input.max = String(max);
    input.value = String(value);
    input.addEventListener('change', () => {
      const numeric = Number(input.value);
      if (Number.isNaN(numeric)) return;
      eventBus.emit('ui:action', {
        action: 'update-selected-annotation',
        patch: { style: { [styleKey]: Math.min(Math.max(numeric, min), max) } },
      });
    });
    wrapper.appendChild(input);
    return wrapper;
  }

  #buildSelectField(label, styleKey, value, options) {
    const wrapper = this.#buildFieldShell(label);
    const input = document.createElement('select');
    input.className = 'form-input';
    options.forEach(([optionValue, optionLabel]) => {
      const option = document.createElement('option');
      option.value = optionValue;
      option.textContent = optionLabel;
      option.selected = optionValue === value;
      input.appendChild(option);
    });
    input.addEventListener('change', () => {
      eventBus.emit('ui:action', {
        action: 'update-selected-annotation',
        patch: { style: { [styleKey]: Number(input.value) } },
      });
    });
    wrapper.appendChild(input);
    return wrapper;
  }

  #buildTextField(label, value) {
    const wrapper = this.#buildFieldShell(label);
    const input = document.createElement('textarea');
    input.className = 'form-input inspector-textarea';
    input.value = value;
    input.rows = 3;
    input.addEventListener('change', () => {
      eventBus.emit('ui:action', {
        action: 'update-selected-annotation',
        patch: { content: input.value },
      });
    });
    wrapper.appendChild(input);
    return wrapper;
  }

  #bindGlobalEvents() {
    document.getElementById('btn-open-pdf')?.addEventListener('click', () => {
      eventBus.emit('ui:action', { action: 'open' });
    });

    document.addEventListener('click', () => this.#closeAllMenus());
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') this.#closeAllMenus();
    });

    const stage = document.getElementById('editor-stage');
    stage.addEventListener('dragover', (event) => {
      event.preventDefault();
      stage.classList.add('drag-over');
    });
    stage.addEventListener('dragleave', () => {
      stage.classList.remove('drag-over');
    });
    stage.addEventListener('drop', (event) => {
      event.preventDefault();
      stage.classList.remove('drag-over');
      const files = Array.from(event.dataTransfer.files).filter((file) =>
        file.type === 'application/pdf' ||
        file.name.toLowerCase().endsWith('.pdf') ||
        file.type.startsWith('image/') ||
        /\.(png|jpe?g|webp)$/i.test(file.name)
      );
      if (files.length > 0) {
        eventBus.emit('ui:action', { action: 'open-files', files });
      }
    });
  }
}

export const appRenderer = new AppRenderer();
