/**
 * ShellModel.js
 * Builds the static view model for menus and toolbar.
 * Pure data — no DOM access, no side effects.
 */

export function buildMenuModel(state) {
  const { canUndo, canRedo, documentStatus } = state ?? {};
  const hasDoc = documentStatus === 'ready';

  return [
    {
      id: 'file',
      label: '檔案',
      items: [
        { id: 'open',     label: '開啟...', shortcut: 'Ctrl+O' },
        { id: 'save-as',  label: '另存新檔...', shortcut: 'Ctrl+Shift+S', disabled: !hasDoc },
        { type: 'separator' },
        { id: 'recent',   label: '最近開啟', submenu: true },
        { type: 'separator' },
        { id: 'close',    label: '關閉', shortcut: 'Ctrl+W', disabled: !hasDoc },
      ],
    },
    {
      id: 'edit',
      label: '編輯',
      items: [
        { id: 'undo',     label: '復原', shortcut: 'Ctrl+Z', disabled: !canUndo },
        { id: 'redo',     label: '取消復原', shortcut: 'Ctrl+Y', disabled: !canRedo },
        { type: 'separator' },
        { id: 'select-all', label: '全選', shortcut: 'Ctrl+A', disabled: !hasDoc },
        { id: 'delete',   label: '刪除選取', shortcut: 'Del', disabled: !hasDoc },
      ],
    },
    {
      id: 'view',
      label: '檢視',
      items: [
        { id: 'zoom-in',    label: '放大', shortcut: 'Ctrl+=' },
        { id: 'zoom-out',   label: '縮小', shortcut: 'Ctrl+-' },
        { id: 'fit-width',  label: '符合寬度', shortcut: 'Ctrl+0' },
        { id: 'fit-page',   label: '符合頁面', shortcut: 'Ctrl+Shift+0' },
        { type: 'separator' },
        { id: 'toggle-sidebar',   label: '切換側邊欄', shortcut: 'F6' },
        { id: 'toggle-inspector', label: '切換屬性面板', shortcut: 'F7' },
        { type: 'separator' },
        { id: 'dark-mode',  label: '深色模式' },
      ],
    },
    {
      id: 'insert',
      label: '插入',
      items: [
        { id: 'tool-text',      label: '文字印章', shortcut: 'T', disabled: !hasDoc },
        { id: 'tool-highlight', label: '螢光筆',   shortcut: 'H', disabled: !hasDoc },
        { id: 'tool-draw',      label: '手繪',     shortcut: 'D', disabled: !hasDoc },
        { id: 'tool-rect',      label: '矩形框',   shortcut: 'R', disabled: !hasDoc },
        { type: 'separator' },
        { id: 'page-number',    label: '插入頁碼...', disabled: !hasDoc },
        { id: 'watermark',      label: '浮水印...',   disabled: !hasDoc },
        { id: 'blank-page',     label: '插入空白頁',  disabled: !hasDoc },
      ],
    },
    {
      id: 'tools',
      label: '工具',
      items: [
        { id: 'merge',    label: '合併 PDF...' },
        { id: 'split',    label: '拆分 PDF...', disabled: !hasDoc },
        { id: 'img2pdf',  label: '圖片轉 PDF...' },
        { type: 'separator' },
        { id: 'clear-sessions', label: '清除所有 Session 資料' },
        { type: 'separator' },
        { id: 'about',    label: '關於 OpenSpec' },
      ],
    },
  ];
}

export function buildToolbarModel(state) {
  const { documentStatus, selectedTool, zoom, currentPage, pageCount } = state ?? {};
  const hasDoc = documentStatus === 'ready';
  const zoomPct = Math.round((zoom ?? 1) * 100);

  return {
    tools: [
      { id: 'select',    label: '選取',    icon: '↖',  active: selectedTool === 'select',    disabled: !hasDoc },
      { id: 'highlight', label: '螢光筆',  icon: '▬',  active: selectedTool === 'highlight', disabled: !hasDoc },
      { id: 'draw',      label: '手繪',    icon: '✏',  active: selectedTool === 'draw',      disabled: !hasDoc },
      { id: 'text',      label: '文字',    icon: 'T',   active: selectedTool === 'text',      disabled: !hasDoc },
      { id: 'rect',      label: '矩形',    icon: '□',   active: selectedTool === 'rect',      disabled: !hasDoc },
    ],
    zoom: { value: zoomPct, disabled: !hasDoc },
    page: { current: currentPage ?? 1, total: pageCount ?? 0, disabled: !hasDoc },
  };
}
