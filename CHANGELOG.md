# OpenSpec Changelog

## v0.1.0-alpha (2026-04-03)

### 新增
- 完整專案骨架（dist/ 目錄結構 + npm scripts）
- Core 架構：EventBus / StateManager / CommandStack（不互相耦合，透過 EventBus 通訊）
- DocumentEngine：pdf.js + pdf-lib 雙載入，並行 SHA-256 + 兩個 PDF 引擎
  - 主執行緒執行模式（維持 `file://` 相容）
  - 加密 PDF 偵測 + 密碼輸入 Modal
  - MIME + magic bytes 雙重驗證
  - 100 MB 軟警告，150 MB 硬限制
- UI Shell：
  - oklch token 設計系統（深色 / 淺色模式）
  - 四行 Grid layout（MenuBar / ToolBar / Workspace / StatusBar）
  - 三欄 Workspace（Sidebar 17rem / Stage 1fr / Inspector 19rem）
  - 響應式斷點（1100px / 760px）
  - 完整選單結構（File / Edit / View / Insert / Tools）
- CanvasLayer：
  - pdf.js 頁面渲染（Canvas 2D）
  - Canvas Pool 5 個上限，LRU 淘汰
  - devicePixelRatio-aware（HiDPI 支援）
  - 預渲染相鄰頁（± 1）
  - 三種縮放模式（custom / fitWidth / fitPage）
- AnnotationLayer（SVG）：
  - 四種標注工具：螢光筆 / 手繪 / 文字印章 / 矩形框
  - 選取工具（click to select）
  - 所有操作包裝為 Command → CommandStack（支援 Undo/Redo）
  - PDF 座標系儲存（不用螢幕像素）
- KeyMap：集中快捷鍵管理（SPEC.md Section 6.3 完整清單）
- SessionDB：IndexedDB 持久化，2 秒 debounce 自動儲存，30 天自動清理
- 函式庫下載腳本（scripts/get-libs.js）
- 建置腳本（scripts/build.js）
- integrity.json 產生腳本（scripts/gen-integrity.js）
- PowerShell 完整性驗證腳本（verify-integrity.ps1）
- 單元測試 23 項（全部通過）

### 修正
- 頁面刪除、插入、重排、旋轉、頁碼與浮水印後，不再錯誤重置為第 1 頁
- 修正標注資料在非 A4 頁面上的座標換算，避免畫面與匯出位置失真
- 補上縮圖拖放重排、Delete 刪除選取標注/當前頁面、Inspector 屬性面板
- 頁面結構變動時同步調整標注頁碼，避免刪頁或重排後標注遺失/錯位
- 將規格文件標註為「v1 目標 + alpha 實作基線」，避免文件誤導目前完成度

---

## v0.1 Alpha Smoke Test 清單

執行前提：`npm run get-libs && npm run build`，在 Chrome 115+ 開啟 `dist/index.html`

### 基礎功能
- [ ] 開啟正常 PDF（Ctrl+O）→ 顯示第一頁，縮圖面板顯示
- [ ] 拖放 PDF 到編輯區 → 正常載入
- [ ] 開啟加密 PDF → 密碼 Modal 出現 → 輸入正確密碼後正常載入
- [ ] 輸入錯誤密碼 → 顯示錯誤訊息，可重試
- [ ] 開啟損壞 PDF → 顯示明確錯誤 Toast，不白屏
- [ ] 嘗試拖入非 PDF 檔案 → banner 提示，拒絕載入

### 頁面操作
- [ ] 頁面導覽（Ctrl+O 後按 ← → 鍵）
- [ ] 縮圖面板點擊任意頁 → 跳轉至對應頁
- [ ] 放大（Ctrl+=）/ 縮小（Ctrl+-）/ 符合寬度（Ctrl+0）/ 符合頁面（Ctrl+Shift+0）
- [ ] 工具列縮放輸入框手動輸入值

### 標注工具
- [ ] 螢光筆（H）：拖拉選取 → 顯示半透明黃色矩形
- [ ] 矩形框（R）：拖拉 → 顯示藍色邊框
- [ ] 手繪（D）：按壓拖曳 → 顯示紅色路徑
- [ ] 文字印章（T）：點擊位置 → 顯示文字
- [ ] 選取工具（Esc/V）：點擊標注 → 選取高亮
- [ ] 標注 Undo（Ctrl+Z）→ 標注消失
- [ ] 標注 Redo（Ctrl+Y）→ 標注恢復

### Session 持久化
- [ ] 加入標注 → 等待 2.5 秒 → 狀態列顯示「已儲存」
- [ ] 關閉分頁重開同一 PDF → Toast「已還原上次工作」，標注恢復
- [ ] Tools > 清除所有 Session 資料 → 再次開啟 → 無還原 Toast

### UI/UX
- [ ] F6 切換側邊欄顯示/隱藏
- [ ] F7 切換 Inspector 顯示/隱藏
- [ ] View > 深色模式 → 整個 UI 切換深色
- [ ] 狀態列顯示正確頁碼和縮放比例

### 安全驗證
- [ ] DevTools（F12）→ Network 標籤 → 重新整理 → 零外部請求
- [ ] Tools > About → 顯示版本資訊 Toast

### 效能
- [ ] 50 頁 PDF 載入 < 3 秒
- [ ] 縮圖面板所有縮圖在 30 秒內顯示

---

*所有核心單元測試：23/23 通過（EventBus 7 / CommandStack 8 / StateManager 8）*
