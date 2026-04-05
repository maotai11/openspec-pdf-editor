/**
 * renderApp.js
 * Renders ONLY the UI chrome: menubar, toolbar, statusbar, inspector shell.
 * NEVER touches #canvas-layer-root or #annotation-layer-root.
 * Uses targeted DOM updates — no full innerHTML replacement.
 */

import { buildMenuModel, buildToolbarModel } from './ShellModel.js';
import { eventBus } from '../core/EventBus.js';

export class AppRenderer {
  #menubar       = document.getElementById('menubar');
  #toolbar       = document.getElementById('toolbar');
  #statusPage    = document.getElementById('status-page');
  #statusZoom    = document.getElementById('status-zoom');
  #statusFile    = document.getElementById('status-filename');
  #statusDot     = document.getElementById('status-dot');
  #statusSave    = document.getElementById('status-save');
  #emptyState    = document.getElementById('empty-state');
  #progressOverlay = document.getElementById('progress-overlay');
  #progressBar   = document.getElementById('progress-bar');
  #progressLabel = document.getElementById('progress-label');
  #toastHost     = document.getElementById('toast-host');

  #activeMenuId  = null;

  init() {
    this.#bindGlobalEvents();
  }

  /**
   * Re-render menus and toolbar from state.
   * Called by app.js on state:changed for relevant keys.
   */
  renderShell(state, cmdState) {
    const menuModel    = buildMenuModel({ ...state, ...cmdState });
    const toolbarModel = buildToolbarModel(state);

    this.#renderMenubar(menuModel);
    this.#renderToolbar(toolbarModel);
    this.#renderStatusbar(state);

    // Show/hide empty state
    const hasDoc = state.documentStatus === 'ready';
    this.#emptyState.classList.toggle('hidden', hasDoc);
  }

  // ---- Progress ----

  showProgress(pct, label = '載入中...') {
    this.#progressOverlay.classList.remove('hidden');
    this.#progressBar.style.width = `${pct}%`;
    this.#progressLabel.textContent = label;
  }

  hideProgress() {
    this.#progressOverlay.classList.add('hidden');
  }

  // ---- Toast ----

  toast(message, type = 'info', duration = 3000) {
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = message;
    this.#toastHost.appendChild(el);
    if (duration > 0) setTimeout(() => el.remove(), duration);
  }

  // ---- Save status ----

  setSaveStatus(status) {
    // status: 'saved' | 'saving' | 'error'
    this.#statusDot.className = 'statusbar-dot' + (status !== 'saved' ? ` ${status}` : '');
    this.#statusSave.textContent = { saved: '已儲存', saving: '儲存中…', error: '儲存失敗' }[status] ?? '就緒';
  }

  // ---- Private: Menubar ----

  #renderMenubar(menuModel) {
    // Only re-render if structure changed (skip if same length as proxy)
    const existing = this.#menubar.querySelectorAll('[data-menu-id]');
    if (existing.length !== menuModel.length) {
      // Preserve brand element, replace only menu items
      const brand = this.#menubar.querySelector('.app-brand');
      this.#menubar.innerHTML = '';
      if (brand) this.#menubar.appendChild(brand);
      for (const menu of menuModel) {
        this.#menubar.appendChild(this.#buildMenuEl(menu));
      }
    } else {
      // Targeted update: update disabled states only
      for (let i = 0; i < menuModel.length; i++) {
        const el = existing[i];
        const dropdown = el.querySelector('.menu-dropdown');
        if (!dropdown) continue;
        const items = menuModel[i].items.filter(it => it.id);
        const dropdownItems = dropdown.querySelectorAll('[data-action]');
        items.forEach((item, j) => {
          const itemEl = dropdownItems[j];
          if (itemEl) itemEl.toggleAttribute('disabled', !!item.disabled);
        });
      }
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

      itemEl.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!item.disabled) {
          this.#closeAllMenus();
          eventBus.emit('ui:action', { action: item.id });
        }
      });

      dropdown.appendChild(itemEl);
    }

    el.appendChild(dropdown);

    el.addEventListener('click', (e) => {
      e.stopPropagation();
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
    this.#menubar.querySelectorAll('[aria-expanded="true"]').forEach(el => {
      el.setAttribute('aria-expanded', 'false');
    });
    this.#activeMenuId = null;
  }

  // ---- Private: Toolbar ----

  #renderToolbar(model) {
    // Only rebuild once; after that, update active/disabled states
    if (!this.#toolbar.dataset.built) {
      this.#buildToolbar(model);
      this.#toolbar.dataset.built = '1';
      return;
    }

    // Update tool active states
    for (const tool of model.tools) {
      const btn = this.#toolbar.querySelector(`[data-tool="${tool.id}"]`);
      if (btn) {
        btn.classList.toggle('active', tool.active);
        btn.toggleAttribute('disabled', tool.disabled);
      }
    }

    // Update zoom
    const zoomInput = this.#toolbar.querySelector('#zoom-input');
    if (zoomInput && document.activeElement !== zoomInput) {
      zoomInput.value = model.zoom.value + '%';
    }

    // Update page nav
    const pageInput = this.#toolbar.querySelector('#page-input');
    const pageTotal = this.#toolbar.querySelector('#page-total');
    if (pageInput && document.activeElement !== pageInput) {
      pageInput.value = model.page.current;
    }
    if (pageTotal) pageTotal.textContent = `/ ${model.page.total}`;
  }

  #buildToolbar(model) {
    this.#toolbar.innerHTML = '';

    // Tool buttons
    for (const tool of model.tools) {
      const btn = document.createElement('button');
      btn.className = 'tool-btn' + (tool.active ? ' active' : '');
      btn.setAttribute('data-tool', tool.id);
      btn.setAttribute('aria-label', tool.label);
      btn.setAttribute('title', tool.label);
      btn.textContent = tool.icon;
      if (tool.disabled) btn.setAttribute('disabled', '');
      btn.addEventListener('click', () => {
        eventBus.emit('ui:action', { action: `tool-${tool.id}` });
      });
      this.#toolbar.appendChild(btn);
    }

    // Separator
    const sep1 = document.createElement('div');
    sep1.className = 'tool-separator';
    this.#toolbar.appendChild(sep1);

    // Zoom control
    const zoomControl = document.createElement('div');
    zoomControl.className = 'zoom-control';
    zoomControl.innerHTML = `
      <button class="tool-btn" data-action="zoom-out" aria-label="縮小" title="縮小 (Ctrl+-)">−</button>
      <input id="zoom-input" class="zoom-input" type="text" value="${model.zoom.value}%"
             aria-label="縮放比例" inputmode="numeric">
      <button class="tool-btn" data-action="zoom-in" aria-label="放大" title="放大 (Ctrl+=)">+</button>
    `;
    this.#toolbar.appendChild(zoomControl);

    // Page navigation
    const pageNav = document.createElement('div');
    pageNav.className = 'page-nav';
    pageNav.innerHTML = `
      <button class="tool-btn" data-action="page-prev" aria-label="上一頁">‹</button>
      <input id="page-input" class="page-nav-input" type="text"
             value="${model.page.current}" aria-label="頁碼">
      <span id="page-total" class="page-nav-total">/ ${model.page.total}</span>
      <button class="tool-btn" data-action="page-next" aria-label="下一頁">›</button>
    `;
    this.#toolbar.appendChild(pageNav);

    // Bind toolbar events
    this.#toolbar.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (btn) eventBus.emit('ui:action', { action: btn.dataset.action });
    });

    const zoomInput = this.#toolbar.querySelector('#zoom-input');
    zoomInput.addEventListener('change', () => {
      const val = parseInt(zoomInput.value);
      if (!isNaN(val)) {
        eventBus.emit('ui:action', { action: 'zoom-set', value: val / 100 });
      }
    });

    const pageInput = this.#toolbar.querySelector('#page-input');
    pageInput.addEventListener('change', () => {
      const val = parseInt(pageInput.value);
      if (!isNaN(val)) {
        eventBus.emit('ui:action', { action: 'page-navigate', page: val });
      }
    });
  }

  // ---- Private: Statusbar ----

  #renderStatusbar(state) {
    const { currentPage, pageCount, documentStatus, zoom, sessionRestored } = state;

    if (documentStatus === 'ready') {
      this.#statusPage.textContent = `第 ${currentPage} / ${pageCount} 頁`;
      this.#statusZoom.textContent = `${Math.round(zoom * 100)}%`;
    } else {
      this.#statusPage.textContent = '—';
      this.#statusZoom.textContent = '—';
    }
  }

  // ---- Private: Global event bindings ----

  #bindGlobalEvents() {
    // Empty state CTA button
    document.getElementById('btn-open-pdf')?.addEventListener('click', () => {
      eventBus.emit('ui:action', { action: 'open' });
    });

    // Close menus on outside click
    document.addEventListener('click', () => this.#closeAllMenus());

    // Close menus on Escape
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.#closeAllMenus();
    });

    // Workspace drag-over styling
    const stage = document.getElementById('editor-stage');
    stage.addEventListener('dragover', (e) => {
      e.preventDefault();
      stage.classList.add('drag-over');
    });
    stage.addEventListener('dragleave', () => {
      stage.classList.remove('drag-over');
    });
    stage.addEventListener('drop', (e) => {
      e.preventDefault();
      stage.classList.remove('drag-over');
      const files = Array.from(e.dataTransfer.files).filter(
        f => f.type === 'application/pdf' || f.name.endsWith('.pdf')
      );
      if (files.length > 0) {
        eventBus.emit('ui:action', { action: 'open-files', files });
      }
    });
  }
}

export const appRenderer = new AppRenderer();
