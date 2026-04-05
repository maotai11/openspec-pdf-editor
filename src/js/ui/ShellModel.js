/**
 * ShellModel.js
 * Builds the static view model for menus and toolbar.
 */

export function buildMenuModel(state) {
  const { canUndo, canRedo, documentStatus, pageCount } = state ?? {};
  const hasDoc = documentStatus === 'ready';

  return [
    {
      id: 'file',
      label: '檔案',
      items: [
        { id: 'open', label: '開啟', shortcut: 'Ctrl+O' },
        { id: 'save-as', label: '另存新檔', shortcut: 'Ctrl+Shift+S', disabled: !hasDoc },
        { type: 'separator' },
        { id: 'recent', label: '最近開啟' },
        { type: 'separator' },
        { id: 'close', label: '關閉', shortcut: 'Ctrl+W', disabled: !hasDoc },
      ],
    },
    {
      id: 'edit',
      label: '編輯',
      items: [
        { id: 'undo', label: '復原', shortcut: 'Ctrl+Z', disabled: !canUndo },
        { id: 'redo', label: '重做', shortcut: 'Ctrl+Y', disabled: !canRedo },
        { type: 'separator' },
        { id: 'select-all', label: '全選本頁標註', shortcut: 'Ctrl+A', disabled: !hasDoc },
        { id: 'delete', label: '刪除', shortcut: 'Del', disabled: !hasDoc },
        { type: 'separator' },
        { id: 'rotate-cw', label: '順時針旋轉 90°', disabled: !hasDoc },
        { id: 'rotate-ccw', label: '逆時針旋轉 90°', disabled: !hasDoc },
        { id: 'crop-pages', label: '裁切頁面', disabled: !hasDoc },
        { id: 'delete-page', label: '刪除頁面', disabled: !hasDoc || pageCount <= 1 },
        { type: 'separator' },
        { id: 'batch-move-pages-dialog', label: '批量移動頁面…', disabled: !hasDoc },
      ],
    },
    {
      id: 'view',
      label: '檢視',
      items: [
        { id: 'zoom-in', label: '放大', shortcut: 'Ctrl+=' },
        { id: 'zoom-out', label: '縮小', shortcut: 'Ctrl+-' },
        { id: 'fit-width', label: '符合寬度', shortcut: 'Ctrl+0' },
        { id: 'fit-page', label: '符合頁面', shortcut: 'Ctrl+Shift+0' },
        { type: 'separator' },
        { id: 'toggle-sidebar', label: '切換縮圖面板', shortcut: 'F6' },
        { id: 'toggle-inspector', label: '切換屬性面板', shortcut: 'F7' },
        { type: 'separator' },
        { id: 'dark-mode', label: '深色模式' },
      ],
    },
    {
      id: 'insert',
      label: '插入',
      items: [
        { id: 'tool-text', label: '文字', shortcut: 'T', disabled: !hasDoc },
        { id: 'tool-highlight', label: '螢光標示', shortcut: 'H', disabled: !hasDoc },
        { id: 'tool-underline', label: '底線', shortcut: 'U', disabled: !hasDoc },
        { id: 'tool-draw', label: '手繪', shortcut: 'D', disabled: !hasDoc },
        { id: 'tool-rect', label: '矩形', shortcut: 'R', disabled: !hasDoc },
        { id: 'tool-circle', label: '圓形', shortcut: 'O', disabled: !hasDoc },
        { id: 'tool-line', label: '線段', shortcut: 'L', disabled: !hasDoc },
        { id: 'tool-arrow', label: '箭頭', shortcut: 'A', disabled: !hasDoc },
        { id: 'tool-stamp', label: '印章', shortcut: 'S', disabled: !hasDoc },
        { id: 'tool-signature', label: '電子簽署', shortcut: 'G', disabled: !hasDoc },
        { type: 'separator' },
        { id: 'page-number', label: '插入頁碼', disabled: !hasDoc },
        { id: 'watermark', label: '加入浮水印', disabled: !hasDoc },
        { id: 'blank-page', label: '插入空白頁', disabled: !hasDoc },
      ],
    },
    {
      id: 'tools',
      label: '工具',
      items: [
        { id: 'merge', label: '合併 PDF' },
        { id: 'split', label: '拆分 PDF', disabled: !hasDoc },
        { id: 'img2pdf', label: '圖片轉 PDF' },
        { id: 'convert-office', label: '轉換為 Word / PowerPoint / Excel', disabled: !hasDoc },
        { id: 'protect-pdf', label: '保護 PDF', disabled: !hasDoc },
        { type: 'separator' },
        { id: 'clear-sessions', label: '清除暫存工作階段' },
        { type: 'separator' },
        { id: 'show-signature-manifest', label: '簽署記錄', disabled: !hasDoc },
        { type: 'separator' },
        { id: 'about', label: '關於 OpenSpec' },
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
      { id: 'select', label: '選取', icon: 'V', active: selectedTool === 'select', disabled: !hasDoc },
      { id: 'highlight', label: '螢光標示', icon: 'H', active: selectedTool === 'highlight', disabled: !hasDoc },
      { id: 'underline', label: '底線', icon: 'U', active: selectedTool === 'underline', disabled: !hasDoc },
      { id: 'draw', label: '手繪', icon: 'D', active: selectedTool === 'draw', disabled: !hasDoc },
      { id: 'text', label: '文字', icon: 'T', active: selectedTool === 'text', disabled: !hasDoc },
      { id: 'rect', label: '矩形', icon: 'R', active: selectedTool === 'rect', disabled: !hasDoc },
      { id: 'circle', label: '圓形', icon: 'O', active: selectedTool === 'circle', disabled: !hasDoc },
      { id: 'line', label: '線段', icon: 'L', active: selectedTool === 'line', disabled: !hasDoc },
      { id: 'arrow', label: '箭頭', icon: 'A', active: selectedTool === 'arrow', disabled: !hasDoc },
      { id: 'stamp', label: '印章', icon: 'S', active: selectedTool === 'stamp', disabled: !hasDoc },
      { id: 'signature', label: '電子簽署', icon: 'G', active: selectedTool === 'signature', disabled: !hasDoc },
    ],
    zoom: { value: zoomPct, disabled: !hasDoc },
    page: { current: currentPage ?? 1, total: pageCount ?? 0, disabled: !hasDoc },
  };
}
