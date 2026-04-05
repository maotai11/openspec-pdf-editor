# OpenSpec — 技術規格書（目標 v1.0 / 實作基線 v0.1.0-alpha）

**產品名稱：** OpenSpec PDF Editor
**規格版本：** 1.0.0
**目前實作版本：** 0.1.0-alpha
**日期：** 2026-04-03
**執行環境：** 離線乾淨機，`file://` 協定，Chrome/Edge 115+

> 本文件描述的是產品目標規格。凡涉及 Worker、匯出進階選項、裁切、批次操作等章節，除非另有標示，均屬 v1.0 目標能力；目前 `main` 實作以 `v0.1.0-alpha` 為準，已完成離線開啟、渲染、縮圖、基本頁面操作、標注、Session 與合併/拆分等核心能力。

---

## 目錄

1. [產品概覽](#1-產品概覽)
2. [環境限制與部署模式](#2-環境限制與部署模式)
3. [技術棧（版本鎖定）](#3-技術棧版本鎖定)
4. [架構設計](#4-架構設計)
5. [功能規格](#5-功能規格)
6. [使用者介面規格](#6-使用者介面規格)
7. [Web Worker 架構](#7-web-worker-架構)
8. [資料模型](#8-資料模型)
9. [錯誤處理矩陣](#9-錯誤處理矩陣)
10. [效能預算](#10-效能預算)
11. [瀏覽器相容性策略](#11-瀏覽器相容性策略)
12. [安全考量](#12-安全考量)
13. [測試策略](#13-測試策略)
14. [建置與發布](#14-建置與發布)
15. [驗收清單](#15-驗收清單)
16. [版本規劃](#16-版本規劃)

---

## 1. 產品概覽

### 1.1 問題陳述

知識工作者、法律/財務專業人員在以下情境需要 PDF 編輯能力：

- 空氣隔離（air-gapped）或乾淨機，無法安裝軟體
- 企業 IT 政策禁止瀏覽器擴充套件
- 無網路連線，無法使用線上工具
- 需要確保檔案不離開本機

**OpenSpec** 是一個純靜態 HTML+JS 應用，解壓縮即可使用，零安裝、零網路請求、零伺服器。

### 1.2 產品目標

| 目標 | 說明 |
|------|------|
| 離線完整運作 | 所有功能在 `file://` 協定下可用，永不發出外部請求 |
| 零安裝 | 解壓縮 `dist/` 資料夾，開啟 `index.html` 即可 |
| 專業級 PDF 操作 | 合併、拆分、旋轉、裁切、標注、頁碼、浮水印 |
| 效能可預期 | 200 頁 PDF 可流暢操作，有量化效能預算 |
| 可維護開源專案 | 清晰架構、模組化設計、完整測試 |

### 1.3 非目標（v1.0）

- OCR 文字識別
- 表單欄位填寫（PDF Form）
- 數位簽名驗證
- PDF/A 合規轉換
- 多標籤頁同時開啟多份文件

### 1.4 術語定義

| 術語 | 定義 |
|------|------|
| Command | 可 Undo/Redo 的原子操作單元 |
| Page Surface | 單一 PDF 頁面的渲染目標（Canvas 元素） |
| Session | 一次開啟 PDF 到關閉頁面的使用週期 |
| dist manifest | `dist/` 資料夾內所有必要檔案的規範性清單 |
| file hash | 檔案 ArrayBuffer 的 SHA-256，作為 session 識別鍵 |

---

## 2. 環境限制與部署模式

### 2.1 部署架構

```
Standard 版（主要目標）：
dist/
  index.html
  css/
  js/
    core/
    ui/
    workers/
  lib/             ← 所有 JS 函式庫本地副本
  integrity.json   ← SHA-256 完整性清單
```

> **Lite 版（未來）：** 單一 `OpenSpec.html`，核心功能，< 3MB
> **PWA 版（未來）：** Service Worker + manifest，需 HTTPS 或 localhost

### 2.2 `file://` 協定限制（規範性清單）

| Web API | 狀態 | 替代方案 |
|---------|------|----------|
| `SharedArrayBuffer` | ❌ 不可用（需 COOP/COEP，須 server） | 用 `ArrayBuffer` postMessage transfer |
| `fetch()` 到任何 URL | ❌ 不可用 | 不需要——所有資源本地化 |
| `BroadcastChannel`（跨分頁） | ❌ 不可用 | 不需要——單分頁應用 |
| `new Worker('./path.js')` | ⚠️ 部分版本有問題 | **Blob URL 模式**（見 Section 7.2） |
| `IndexedDB` | ✅ 可用 | — |
| `localStorage` | ✅ 可用（同分頁） | — |
| `WebCrypto` (`crypto.subtle`) | ✅ 可用 | — |
| `Canvas 2D` / `OffscreenCanvas` | ✅ 可用 | — |
| `File System Access API` | ✅ Chrome/Edge 可用 | Firefox 降級為 ZIP 下載 |

### 2.3 硬體基準

| 指標 | 最低需求 | 建議 |
|------|---------|------|
| RAM | 4 GB（瀏覽器分頁可用 2 GB） | 8 GB |
| CPU | i5 等級（2017+） | 任何現代 CPU |
| GPU | 不需要（Canvas 2D only） | — |
| 磁碟 | dist/ 約 5 MB | — |

---

## 3. 技術棧（版本鎖定）

### 3.1 核心函式庫

| 函式庫 | 版本 | 授權 | 用途 |
|--------|------|------|------|
| pdf.js | v4.x (最新穩定) | Apache 2.0 | PDF 渲染（縮圖 + 主預覽） |
| pdf-lib | **v1.17.1**（鎖定） | MIT | PDF 建立、合併、拆分、旋轉、嵌入圖片、頁碼、浮水印 |
| fflate | v0.8.x | MIT | DEFLATE 壓縮（多檔 ZIP 匯出） |

**注意事項：**

- `package.json` 使用精確版本（`"pdf-lib": "1.17.1"`，非 `"^1.17.1"`）
- pdf.js v4 需要 `pdf.worker.min.js` 與主檔案分開存放
- pdf-lib 使用 UMD bundle（`pdf-lib.min.js`）
- pdf.js 的 `workerSrc` 必須設為 Blob URL（見 Section 7.2）

### 3.2 `dist/` 檔案清單（規範性）

```
dist/
├── index.html
├── integrity.json
├── css/
│   └── main.css
├── js/
│   ├── app.js                    ← 進入點，單例初始化
│   ├── core/
│   │   ├── EventBus.js
│   │   ├── StateManager.js
│   │   ├── CommandStack.js
│   │   └── DocumentEngine.js
│   ├── ui/
│   │   ├── ShellModel.js
│   │   ├── renderApp.js          ← 只負責 UI chrome DOM
│   │   ├── CanvasLayer.js        ← 獨立擁有 Canvas DOM 節點
│   │   └── AnnotationLayer.js    ← 獨立擁有 SVG DOM 節點
│   └── workers/
│       ├── thumbnail-worker.js
│       └── export-worker.js      ← 可選，大文件匯出用
└── lib/
    ├── pdf.min.js
    ├── pdf.worker.min.js
    ├── pdf-lib.min.js
    └── fflate.min.js
```

### 3.3 函式庫載入順序

```html
<!-- index.html 載入順序 -->
<script src="lib/fflate.min.js"></script>
<script src="lib/pdf-lib.min.js"></script>
<script src="lib/pdf.min.js"></script>
<!-- pdf.worker 由 DocumentEngine 在執行期讀取為文字並轉成 Blob URL -->
<script type="module" src="js/app.js"></script>
```

失敗處理：任何 `<script>` 載入失敗觸發 `window.onerror`，顯示靜態錯誤頁面並列出哪個檔案失敗。

---

## 4. 架構設計

### 4.1 渲染層模型（三層不相交）

```
┌────────────────────────────────────┐
│  UI Chrome Layer (DOM)             │  ← renderApp.js 管理
│  工具列、選單、側邊欄、狀態列        │    純 DOM，任何 patch 不觸碰下兩層
├────────────────────────────────────┤
│  Annotation Overlay Layer (SVG)    │  ← AnnotationLayer.js 管理
│  標注選取框、控點、繪製路徑          │    SVG（解析度無關）
├────────────────────────────────────┤
│  PDF Raster Layer (Canvas 2D)      │  ← CanvasLayer.js 管理
│  PDF 頁面渲染                      │    pdf.js 輸出目標
└────────────────────────────────────┘
```

**架構約束：**
- `renderApp.js` 的 `innerHTML` 替換**絕不**涵蓋 Canvas 和 SVG 所在節點
- `CanvasLayer` 和 `AnnotationLayer` 各自擁有獨立的 DOM 根節點，不通過 `renderApp` 渲染
- 狀態變更觸發渲染的路徑：`StateManager.patch()` → `EventBus` → 各 Layer 各自決定是否重繪

### 4.2 狀態架構（三個獨立職責）

```
┌─────────────────┐  patch()  ┌──────────────────┐
│  StateManager   │           │  UI State         │
│                 │──────────→│  zoom, currentPage│
│  (UI 狀態)      │           │  selectedTool     │
└─────────────────┘           │  sidebarPanel     │
                              └──────────────────┘

┌─────────────────┐  execute()┌──────────────────┐
│  CommandStack   │           │  Document History │
│                 │──────────→│  [AddAnnotation,  │
│  (操作歷史)     │           │   DeletePage, ...] │
└─────────────────┘           └──────────────────┘

┌─────────────────┐  openFile()┌─────────────────┐
│  DocumentEngine │            │  PDF Binary State│
│                 │───────────→│  pdfjsDoc        │
│  (PDF 實體)     │            │  pdfLibDoc       │
└─────────────────┘            └─────────────────┘
```

**耦合規則：** 三個模組**不互相直接引用**，只通過 `EventBus` 通訊。`app.js` 是唯一可以持有全部三個引用的模組。

### 4.3 EventBus 事件目錄（規範性）

| 事件名稱 | Payload | 發送者 | 訂閱者 |
|---------|---------|--------|--------|
| `document:open-requested` | `{ file: File }` | UI | DocumentEngine |
| `document:loaded` | `{ pageCount, fileName, fileHash }` | DocumentEngine | CanvasLayer, ThumbnailWorker, StateManager |
| `document:load-failed` | `{ reason, code }` | DocumentEngine | UI (顯示錯誤) |
| `page:navigate` | `{ targetPage: number }` | UI | CanvasLayer, StateManager |
| `page:rendered` | `{ pageNumber, renderTime }` | CanvasLayer | StateManager (效能記錄) |
| `annotation:add` | `{ annotation: AnnotationModel }` | AnnotationLayer | CommandStack |
| `annotation:update` | `{ id, patch }` | AnnotationLayer | CommandStack |
| `annotation:delete` | `{ id }` | AnnotationLayer | CommandStack |
| `command:undo` | — | UI (Ctrl+Z) | CommandStack |
| `command:redo` | — | UI (Ctrl+Y) | CommandStack |
| `export:save-as-requested` | — | UI | DocumentEngine |
| `export:complete` | `{ blobUrl }` | DocumentEngine | UI (觸發下載) |
| `worker:crashed` | `{ workerName }` | Worker 管理器 | UI (顯示降級提示) |

### 4.4 CommandStack 合約

```typescript
interface Command {
  execute(): void;
  undo(): void;
  description: string;     // 顯示在 Undo/Redo 選單
  estimatedBytes: number;  // 估計記憶體佔用（用於限制）
}

interface CommandStack {
  execute(cmd: Command): void;  // 執行、推入 history、清空 redo
  undo(): void;                 // 彈出 history，呼叫 cmd.undo()，推入 redo
  redo(): void;                 // 彈出 redo，呼叫 cmd.execute()，推入 history
  canUndo: boolean;
  canRedo: boolean;
  historyDescription: string[]; // 供 UI 顯示
}
```

**限制：**
- History 上限：100 條 **或** 50 MB 總 `estimatedBytes`（先到先限制），超出時從最舊項目刪除
- 以下操作**不進 CommandStack**（transient）：縮放變更、頁面導覽、側邊欄切換
- Undo/Redo 快捷鍵在 Modal 開啟時停用

### 4.5 DocumentEngine 合約

```typescript
interface DocumentEngine {
  openFile(file: File): Promise<void>;
  getPage(n: number): Promise<PDFPageProxy>;  // pdf.js proxy
  embedAnnotations(annotations: AnnotationModel[]): Promise<void>;
  exportToBlob(): Promise<Blob>;
  readonly pageCount: number;
  readonly fileName: string;
  readonly fileHash: string;  // SHA-256 hex
}
```

**並行載入策略：**
```
openFile() 觸發後，以下三項**並行執行**：
  1. pdf.js 載入（渲染用）
  2. pdf-lib 載入（編輯用）
  3. WebCrypto SHA-256 計算（session 識別用）
全部 resolve 後才 emit document:loaded
```

---

## 5. 功能規格

### 5.1 檔案匯入

**觸發方式：** 工具列「開啟」按鈕（file input）、拖放至編輯區、`Ctrl+O`

**輸入驗證（按順序執行）：**

| 驗證步驟 | 規則 | 失敗處理 |
|---------|------|---------|
| MIME type | `application/pdf` 或 `.pdf` 副檔名 | inline banner，拒絕檔案 |
| Magic bytes | 前 5 bytes 必須為 `%PDF-` | 同上 |
| 檔案大小警告 | > 100 MB | Toast 提示效能風險，允許繼續 |
| 檔案大小限制 | > 150 MB | Modal 錯誤，拒絕載入 |
| 重複檔案 | 同名同 hash | 詢問「取代現有？」 |
| 加密 PDF | pdf.js 偵測到 `onPassword` | 顯示密碼輸入 Modal |

**載入狀態：**
- 使用 pdf.js `onProgress` 回調驅動進度條（0–100%）
- 進度條顯示在主編輯區中央
- 載入期間工具列按鈕全部 disabled

### 5.2 頁面渲染

**渲染策略：**
- 預渲染：當前頁 ± 1 頁（共最多 3 頁常駐 Canvas pool）
- 縮圖：最大 5 頁 Canvas 常駐，LRU 淘汰
- 解析度：`devicePixelRatio`-aware（HiDPI/Retina 支援）
- 縮放範圍：25% – 400%，步進 10%；特殊值：「符合寬度」、「符合頁面」

**重繪觸發：** 縮放變更、視窗 resize、頁面導覽
**Canvas Pool 大小：** 最多 5 個 Canvas 元素，超出時銷毀並重建

### 5.3 縮圖面板

- 生成解析度：寬 96px（等比例高度）
- 生成策略：先產生可見區域縮圖，再依滾動方向預產生
- 使用 `ImageBitmap` 在 Worker 中產生，transfer 回主線程
- 當前頁高亮：CSS class 切換，**不重新渲染縮圖**
- 縮圖點擊：導覽至對應頁

### 5.4 頁面管理操作

| 操作 | 觸發方式 | Undoable | 說明 |
|------|---------|---------|------|
| 重新排序 | 縮圖面板拖放 | ✅ | HTML5 Drag API |
| 刪除頁面 | 右鍵選單 / `Del` 鍵 | ✅ | 確認 Modal |
| 旋轉（單頁） | 右鍵選單 / 工具列 | ✅ | 90° 步進，CW/CCW |
| 旋轉（批次） | 多選後工具列 | ✅ | Ctrl/Shift 多選 |
| 裁切 | 工具列選擇裁切工具 | ✅ | WYSIWYG，拖拉選框 |
| 插入空白頁 | 選單 Insert → Blank Page | ✅ | 插入至選定頁後 |

**多選行為：**
- `Ctrl+Click`：切換選取
- `Shift+Click`：範圍選取
- 多選狀態下，刪除/旋轉作用於全部選取頁

### 5.5 標注工具

| 工具 | 快捷鍵 | 描述 | 資料格式 |
|------|--------|------|---------|
| 選取 | `Esc` / `V` | 選取並移動/調整標注 | — |
| 螢光筆 | `H` | 矩形選取，半透明填色 | rect + color + opacity |
| 手繪 | `D` | 自由路徑，可設顏色/線寬 | SVG path |
| 文字印章 | `T` | 可定位文字方塊 | position + text + style |
| 矩形框 | `R` | 邊框矩形，可設顏色 | rect + strokeColor |

**標注建立流程：** `pointer-up` → 建立 `AnnotationModel` → 包裝為 `AddAnnotationCommand` → `CommandStack.execute()` → SVG 重繪 → IndexedDB 自動儲存（debounce 2s）

**座標系統：** 所有標注幾何資料以 **PDF 座標系（左下角原點，pt 為單位）** 儲存，不以螢幕像素儲存。渲染時才轉換。

### 5.6 頁碼插入

- 可設定：位置（上/下 × 左/中/右 = 6 種）、起始號、格式（阿拉伯數字/羅馬數字）、字型大小、顏色
- 作用範圍：全部頁面或指定頁範圍
- 實作：pdf-lib 嵌入為 PDF 文字物件（非圖片）
- Undoable：是

### 5.7 浮水印

- 文字浮水印：可設文字、字型大小、顏色、旋轉角度、透明度、位置
- 圖片浮水印：支援 PNG/JPG，可設透明度、位置、縮放
- 作用範圍：全部頁面或指定頁範圍
- Undoable：是

### 5.8 圖片轉 PDF

- 支援：PNG、JPG/JPEG、WebP（pdf-lib 原生支援 PNG/JPG，WebP 需轉換）
- 頁面尺寸選項：A4 / Letter / 原始尺寸 / 符合頁面
- 可設 DPI：72 / 150 / 300
- 可設邊距：無 / 標準（10mm）/ 自訂
- 多張圖片：每張建立一頁，支援重新排序

### 5.9 合併與拆分

**合併：**
- 拖入多個 PDF，縮圖面板顯示所有頁面（跨文件）
- 調整頁面順序後匯出為單一 PDF

**拆分：**
- 模式 A：每頁一個 PDF（批次命名：`filename_001.pdf`, `filename_002.pdf`...）
- 模式 B：依指定頁碼範圍拆分（UI：輸入 "1-3, 4-7, 8-"）
- 多檔輸出：打包為 ZIP（fflate）後下載

### 5.10 匯出 / 另存新檔

**匯出選項：**

| 選項 | 預設值 | 說明 |
|------|--------|------|
| 壓縮等級 | 標準 | 無/標準/最大 |
| 圖片 DPI | 150 | 72/150/300 |
| PDF 版本 | 1.7 | 1.4/1.7/2.0 |
| 扁平化標注 | 否 | 是=標注變成靜態內容 |
| 元資料 | 保留原始 | 可編輯：標題/作者/主題/關鍵字 |
| 密碼保護 | 無 | 可設開啟密碼 |

**匯出流程：**
1. pdf-lib 將所有 `AnnotationModel` 嵌入為 PDF 物件
2. 序列化為 `Uint8Array`（此步驟可能耗時，在 export-worker 中執行）
3. 包裝為 `Blob`，建立 Object URL
4. 觸發 `<a download="filename_annotated.pdf">` 點擊
5. 60 秒後 revoke Object URL（記憶體釋放）

### 5.11 Session 持久化

**儲存引擎：** IndexedDB，資料庫名 `openspec-v1`

**識別鍵：** 檔案 SHA-256（不用檔名——同名不同內容的檔案可獨立記憶）

**儲存內容：**
```json
{
  "fileHash": "sha256hex",
  "fileName": "report.pdf",
  "savedAt": "ISO8601",
  "lastPage": 3,
  "lastZoom": 1.2,
  "annotations": []
}
```

**還原流程：**
1. 開啟 PDF 時計算 SHA-256
2. 查詢 IndexedDB
3. 找到記錄 → 還原 annotations + lastPage + lastZoom → 顯示 "已還原上次工作" Toast
4. 找不到 → 正常新 session

**自動儲存：** 最後一次標注變更後 debounce 2 秒觸發

---

## 6. 使用者介面規格

### 6.1 版面區域（規範性）

```
┌─────────────────────────────────────────────┐
│  Row 1: Menu Bar (48px)                     │
│  File │ Edit │ View │ Insert │ Tools         │
├─────────────────────────────────────────────┤
│  Row 2: Tool Bar (52px)                     │
│  [工具組] [縮放] [頁面導覽] [匯出]            │
├──────────┬──────────────────┬───────────────┤
│  Left    │                  │  Right        │
│  Sidebar │  Editor Stage    │  Inspector    │
│  17rem   │  1fr             │  Panel        │
│          │  (CanvasLayer +  │  19rem        │
│  縮圖列表 │   AnnotationSVG) │  屬性/設定     │
│          │                  │               │
├──────────┴──────────────────┴───────────────┤
│  Row 4: Status Bar (28px)                   │
│  頁碼 │ 縮放 │ 檔名 │ 儲存狀態 │ Session 狀態  │
└─────────────────────────────────────────────┘
```

**響應式行為：**
- ≥ 1100px：三欄完整顯示
- 760–1099px：Inspector 隱藏（可 F7 開關）
- < 760px：單欄，Sidebar 折疊

### 6.2 選單結構（規範性）

```
File
  Open...         Ctrl+O
  Save As...      Ctrl+Shift+S
  Recent Files >  （最多 10 項，localStorage）
  ──────────────
  Close           Ctrl+W

Edit
  Undo [描述]     Ctrl+Z
  Redo [描述]     Ctrl+Y / Ctrl+Shift+Z
  ──────────────
  Select All      Ctrl+A
  Delete Selected Del

View
  Zoom In         Ctrl+=
  Zoom Out        Ctrl+-
  Fit Width       Ctrl+0
  Fit Page        Ctrl+Shift+0
  ──────────────
  Toggle Sidebar  F6
  Toggle Inspector F7
  ──────────────
  Dark Mode       （toggle）

Insert
  Text Stamp      T
  Highlight       H
  Freehand Draw   D
  Rectangle       R
  ──────────────
  Page Number...
  Watermark...
  Blank Page

Tools
  Merge PDFs...
  Split PDF...
  Image to PDF...
  ──────────────
  Clear Session Data
  About
```

### 6.3 鍵盤快捷鍵完整清單（規範性）

所有快捷鍵**集中**在 `js/core/KeyMap.js` 統一註冊，禁止散落在各元件。

| 快捷鍵 | 動作 |
|--------|------|
| `Ctrl+O` | 開啟檔案 |
| `Ctrl+Shift+S` | 另存新檔 |
| `Ctrl+W` | 關閉文件 |
| `Ctrl+Z` | Undo |
| `Ctrl+Y` / `Ctrl+Shift+Z` | Redo |
| `Ctrl+=` | 放大 |
| `Ctrl+-` | 縮小 |
| `Ctrl+0` | 符合寬度 |
| `Ctrl+Shift+0` | 符合頁面 |
| `Ctrl+A` | 全選標注 |
| `Del` | 刪除選取標注/頁面 |
| `←` `→` | 上/下一頁 |
| `↑` `↓` | 縮圖面板滾動 |
| `Esc` | 取消工具 / 關閉 Modal |
| `V` | 選取工具 |
| `H` | 螢光筆工具 |
| `D` | 手繪工具 |
| `T` | 文字印章工具 |
| `R` | 矩形工具 |
| `F6` | 切換左側邊欄 |
| `F7` | 切換右側 Inspector |

### 6.4 設計 Token 規範

- 所有顏色使用 `main.css` `:root` 中定義的 oklch 命名 token
- 任何新元件**禁止**直接使用 hex/rgb 原始色值
- 最低對比度：一般文字 4.5:1（WCAG 2.1 AA）、大文字 3:1
- 深色模式：`[data-theme="dark"]` 切換，token 重映射

### 6.5 無障礙需求

- 所有互動元素具備 `tabindex="0"` 和描述性 `aria-label`
- 狀態列使用 `aria-live="polite"`（頁碼/縮放變更播報）
- Modal 對話框：focus trap（純 JS 實作）、`role="dialog"`、`aria-modal="true"`
- Canvas Layer：`role="img"`，動態 `aria-label` 描述當前頁內容
- 鍵盤完整可操作（Tab / Enter / Space / Escape）

---

## 7. Web Worker 架構

> 實作狀態：`v0.1.0-alpha` 目前以主執行緒版本為準；本章保留作為 `v1.0` 目標設計，尚未完全落地。

### 7.1 Worker 清單

| Worker | 負責 | 生命週期 |
|--------|------|---------|
| pdf.js 內建 Worker | PDF 解析引擎 | pdf.js 自動管理 |
| `thumbnail-worker.js` | 縮圖 ImageBitmap 產生 | 應用啟動時建立，持久存活 |
| `export-worker.js` | 大文件 pdf-lib 序列化 | 按需建立，完成後終止 |

### 7.2 Worker 建立模式（`file://` 安全）

```javascript
// 所有自行撰寫的 Worker 必須使用此模式
async function createWorker(scriptPath) {
  const response = await fetch(scriptPath);
  const text = await response.text();
  const blob = new Blob([text], { type: 'application/javascript' });
  const url = URL.createObjectURL(blob);
  const worker = new Worker(url, { type: 'module' });
  URL.revokeObjectURL(url); // Worker 建立後立即 revoke 無影響
  return worker;
}
```

**pdf.js Worker 設定：**
```javascript
// DocumentEngine 初始化時執行
const workerText = await fetch('./lib/pdf.worker.min.js').then(r => r.text());
const workerBlob = new Blob([workerText], { type: 'application/javascript' });
pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(workerBlob);
```

### 7.3 訊息協定

**請求格式：**
```json
{ "type": "GENERATE_THUMBNAIL", "id": "uuid", "payload": { "pageNumber": 3 } }
```

**回應格式（成功）：**
```json
{ "type": "GENERATE_THUMBNAIL", "id": "uuid", "result": { "imageBitmap": ... } }
```

**回應格式（失敗）：**
```json
{ "type": "GENERATE_THUMBNAIL", "id": "uuid", "error": { "message": "...", "code": "RENDER_FAILED" } }
```

**Timeout：** 每條訊息 30 秒，超時則 terminate Worker 並重建

### 7.4 Worker 錯誤恢復

```
Worker 崩潰
  │
  ├─ 首次崩潰（60秒內第 1 次）
  │    → 靜默重啟
  │    → 重試上一個任務
  │
  └─ 再次崩潰（60秒內第 2 次）
       → 停止重試
       → 發送 EventBus: worker:crashed
       → UI 顯示「[功能名稱] 暫時不可用」banner
       → 應用繼續運作（降級模式）
```

---

## 8. 資料模型

### 8.1 AnnotationModel

```typescript
interface AnnotationModel {
  id: string;               // UUID v4
  type: 'highlight' | 'draw' | 'text' | 'rect';
  pageNumber: number;       // 1-based
  geometry: HighlightGeom | DrawGeom | TextGeom | RectGeom;
  style: {
    color: string;          // 6字元 hex，如 "#FFFF00"
    opacity: number;        // 0.0–1.0
    strokeWidth?: number;   // pt
    fontSize?: number;      // pt
  };
  content?: string;         // 僅 text 類型使用
  createdAt: string;        // ISO 8601
  modifiedAt: string;       // ISO 8601
}

// 所有座標以 PDF 座標系（pt，左下角原點）
interface HighlightGeom { x: number; y: number; width: number; height: number; }
interface DrawGeom      { pathData: string; }  // SVG path d 屬性
interface TextGeom      { x: number; y: number; }
interface RectGeom      { x: number; y: number; width: number; height: number; }
```

### 8.2 AppState（StateManager 管理）

```typescript
interface AppState {
  documentStatus: 'idle' | 'loading' | 'ready' | 'error';
  currentPage: number;        // 1-based
  pageCount: number;
  zoom: number;               // 1.0 = 100%
  zoomMode: 'custom' | 'fitWidth' | 'fitPage';
  selectedTool: 'select' | 'highlight' | 'draw' | 'text' | 'rect';
  sidebarOpen: boolean;
  inspectorOpen: boolean;
  theme: 'light' | 'dark';
  selectedAnnotationIds: string[];
  selectedPageNumbers: number[];
  exportDialogOpen: boolean;
  sessionRestored: boolean;
}
```

### 8.3 IndexedDB Schema

```
Database: openspec-v1
  Object Store: sessions
    keyPath: fileHash (string)
    Indexes:
      - savedAt (Date) — for cleanup of old entries
    Value:
      fileHash: string
      fileName: string
      savedAt: string
      lastPage: number
      lastZoom: number
      annotations: AnnotationModel[]
```

**清理策略：** 超過 30 天未存取的 session 在開啟新文件時自動刪除（保持 IndexedDB 整潔）

---

## 9. 錯誤處理矩陣

| 錯誤情境 | 偵測點 | UI 回應 | 可恢復 |
|---------|--------|---------|--------|
| 非 PDF 格式 | MIME + magic bytes 驗證 | Inline banner，檔案拒絕 | ✅ |
| 加密 PDF | pdf.js `onPassword` | 密碼輸入 Modal | ✅ |
| 損壞 PDF | pdf.js Promise rejection | 錯誤狀態 + 診斷訊息（不顯示白屏） | ❌ |
| 檔案 > 150MB | 大小檢查 | Modal + 檔案大小數字 | ✅（開較小檔案） |
| Worker 首次崩潰 | `worker.onerror` | 靜默重啟 | ✅ |
| Worker 二次崩潰 | 重啟計數器 | 「功能暫時不可用」banner | 部分 |
| IndexedDB 不可用 | `idb.open()` rejection | Warning toast，繼續（不持久化） | ✅ |
| 匯出序列化失敗 | `exportToBlob()` rejection | 錯誤 Modal + 重試按鈕 | ✅ |
| 記憶體不足 | `performance.measureUserAgentSpecificMemory()` 或 canvas 建立失敗 | 提示減少頁面，自動淘汰 Canvas pool | ✅ |
| 任何函式庫載入失敗 | `window.onerror` | 靜態錯誤頁面（列明失敗檔案） | ❌（重新整理） |

**錯誤訊息原則：**
- 每條錯誤訊息必須清楚說明「發生什麼」和「可以怎麼做」
- 禁止顯示技術性 stack trace 給使用者
- 錯誤記錄到 `console.error`（方便除錯）

---

## 10. 效能預算

| 指標 | 預算 | 量測方式 |
|------|------|---------|
| 首頁渲染（10MB PDF） | < 3 秒 | `page:rendered` - `document:open-requested` 時間差 |
| 首頁渲染（100MB PDF） | < 10 秒 | 同上 |
| 標注提交延遲（pointer-up 到可見） | < 100ms | AnnotationLayer 重繪時間 |
| 縮圖全部產生（50 頁 PDF） | < 30 秒（背景執行） | Worker 完成時間 |
| 匯出（50 頁 + 20 個標注） | < 5 秒 | `export:complete` 時間戳 |
| 匯出（200 頁） | < 15 秒 | 同上 |
| 記憶體峰值（200 頁 PDF） | < 800MB | Chrome DevTools Heap |
| 拖拉排序 FPS | > 30 fps | Chrome DevTools Performance |
| Canvas Pool 上限 | 5 個 Canvas | 架構約束 |

**大檔支援：**
- > 100 頁：縮圖面板啟用虛擬滾動（Virtual Scroll），只渲染可見縮圖的 DOM
- 記憶體壓力時：自動從 Canvas Pool 淘汰最久未使用的頁面，需要時重建

---

## 11. 瀏覽器相容性策略

### 11.1 相容性矩陣

| 功能 | Chrome 115+ | Edge 115+ | Firefox latest | Safari latest |
|------|-------------|-----------|----------------|---------------|
| 核心 PDF 操作 | ✅ | ✅ | ✅ | ✅ |
| File System Access API | ✅ | ✅ | ❌ → ZIP 下載 | ❌ → ZIP 下載 |
| 拖拉排序 | ✅ | ✅ | ✅ | ✅ |
| Web Worker (Blob URL) | ✅ | ✅ | ✅ | ✅ |
| IndexedDB | ✅ | ✅ | ✅ | ⚠️（限制） |
| 大檔案 (>100MB) | ✅ | ✅ | ⚠️ 效能較差 | ⚠️ 記憶體限制 |
| OffscreenCanvas | ✅ | ✅ | ✅ | ✅ |

**官方支援：** Chrome 115+、Edge 115+
**非官方可用：** Firefox（核心功能）
**不支援：** Safari（可顯示提示但不阻止載入）

### 11.2 降級行為

- **File System Access API 不支援：** 自動降級為 `<a download>` Blob URL 下載（ZIP for 多檔）
- **Worker Blob URL 失敗：** 縮圖在主線程同步生成（效能降級，不崩潰）
- **IndexedDB 不可用：** Session 不持久化，每次全新開始

### 11.3 首次載入能力偵測

```javascript
// app.js 初始化時執行，結果儲存在 AppCapabilities 物件
const capabilities = {
  fileSystemAccess: 'showSaveFilePicker' in window,
  workerBlobUrl: true, // 嘗試建立後確認
  indexedDB: 'indexedDB' in window,
  offscreenCanvas: 'OffscreenCanvas' in window,
};
```

---

## 12. 安全考量

### 12.1 輸入驗證

- MIME type + magic bytes 雙重驗證（Section 5.1 已定義）
- 檔名長度上限：255 字元
- 檔名用於 DOM 顯示時：使用 `textContent` 而非 `innerHTML`（防 XSS）
- PDF 中的 JavaScript：確認 pdf.js 的 `enableXfa: false`、不執行 PDF 內嵌 JS

### 12.2 外部連結處理

- 偵測 PDF 中的外部 URL
- 點擊時顯示確認 Modal：「此連結將開啟外部網站：[URL]，是否繼續？」
- 不自動追蹤任何外部連結

### 12.3 本地資料隱私

- 零網路請求（DevTools Network 面板確認）
- IndexedDB 包含標注資料：提供「清除所有 Session 資料」功能（Tools 選單）
- 不寫入任何 cookie

### 12.4 發布完整性驗證

`integrity.json` 結構：
```json
{
  "version": "1.0.0",
  "generatedAt": "2026-04-03T00:00:00Z",
  "files": {
    "index.html":           { "sha256": "...", "bytes": 12345 },
    "lib/pdf.min.js":       { "sha256": "...", "bytes": 980000 },
    "lib/pdf-lib.min.js":   { "sha256": "...", "bytes": 380000 }
  }
}
```

**IT 驗證 PowerShell 指令（隨 dist/ 提供）：**
```powershell
# verify-integrity.ps1
$manifest = Get-Content integrity.json | ConvertFrom-Json
foreach ($file in $manifest.files.PSObject.Properties) {
    $hash = (Get-FileHash $file.Name -Algorithm SHA256).Hash.ToLower()
    $expected = $file.Value.sha256
    if ($hash -ne $expected) { Write-Host "FAIL: $($file.Name)" -ForegroundColor Red }
    else { Write-Host "OK: $($file.Name)" -ForegroundColor Green }
}
```

---

## 13. 測試策略

### 13.1 單元測試（Node.js `node:test`）

目標覆蓋率：`core/` 模組 100%

| 模組 | 測試重點 |
|------|---------|
| `EventBus` | on/emit/off，多訂閱者，同事件多 handler |
| `StateManager` | patch，subscribe，unsubscribe，不可變原則 |
| `CommandStack` | execute/undo/redo，history 上限，記憶體上限 |
| `AnnotationModel` | schema 驗證，座標系轉換 |

測試夾具：`tests/fixtures/test-10p.pdf`（10 頁測試 PDF，納入版本控制）

### 13.2 整合測試

- `DocumentEngine` 搭配真實 PDF fixture（不 mock pdf.js）
- Worker 訊息 round-trip（mock Worker 驗證訊息格式）

### 13.3 瀏覽器 Smoke Test（手動清單）

每次 release 前執行：

```
□ 開啟正常 PDF → 顯示第一頁
□ 開啟加密 PDF → 密碼對話框出現 → 輸入後正常載入
□ 開啟損壞 PDF → 顯示明確錯誤，不白屏
□ 開啟 > 100MB PDF → 顯示效能警告，允許繼續
□ 拖入圖片 → 圖片轉 PDF 流程
□ 縮圖面板顯示全部頁面（50頁 PDF）
□ 拖拉縮圖重排 → Undo → 順序還原
□ 各標注工具：建立 → 選取 → 移動 → 刪除 → Undo
□ 頁碼插入 → 匯出 → Adobe Reader 確認
□ 浮水印 → 匯出確認
□ 多頁旋轉（批次）→ 匯出確認
□ 關閉分頁重開同一 PDF → Session 已還原 Toast
□ 合併兩個 PDF → 匯出 → 總頁數正確
□ 拆分 → ZIP 下載 → 解壓縮確認
□ DevTools Network → 零外部請求
□ 清除 Session 資料 → IndexedDB 清空
```

### 13.4 效能測試

使用 `performance.mark` / `performance.measure` 埋點，在 console 輸出效能報告。每次 release 對照效能預算（Section 10）。

---

## 14. 建置與發布

### 14.1 建置腳本需求

- 工具：npm scripts（使用 `esbuild` 壓縮，或純檔案複製）
- 輸入：`src/` 目錄
- 輸出：`dist/` 目錄（符合 Section 3.2 清單）
- 步驟：lint → test → 複製/壓縮 lib → 複製 source → 產生 `integrity.json`

### 14.2 發布套件格式

```
OpenSpec-v1.0.0-win.zip
└── OpenSpec/
    ├── index.html
    ├── README.txt       ← "在 Chrome 或 Edge 中開啟 index.html"
    ├── verify-integrity.ps1
    ├── integrity.json
    ├── css/
    ├── js/
    └── lib/
```

### 14.3 版本鎖定規則

- `package.json` 使用精確版本（無 `^` 或 `~`）
- 所有 lib 檔案 vendor 進 `lib/`（發布時不需 `npm install`）
- 版本升級必須更新 `integrity.json` 並重新驗證所有 Smoke Test

---

## 15. 驗收清單

### 功能驗收

```
□ 加密 PDF 輸入密碼後正常載入
□ 損壞 PDF 顯示明確錯誤（非白屏、非 JS 異常）
□ 100 頁 PDF 合併後可被 Adobe Reader 正常開啟
□ 旋轉後的頁面在其他 PDF 閱讀器中方向正確
□ 裁切後頁面不殘留被裁切內容（安全裁切）
□ 圖片轉 PDF 後選擇 300 DPI 無明顯劣化
□ Undo/Redo 支援至少 50 步操作
□ 同時載入 5 個 PDF 進行合併不崩潰
□ 頁碼插入後匯出，頁碼位置/格式正確
□ Session 還原在同一 Chrome profile 下有效
```

### 效能驗收

```
□ 50 頁 10MB PDF 載入 < 3 秒（i5 等級筆電 Chrome）
□ 拖拉排序 FPS > 30
□ 標注建立後 < 100ms 可見
□ 匯出 100 頁 PDF < 8 秒
```

### 相容性驗收

```
□ Chrome 115+ 所有功能正常
□ Edge 115+ 所有功能正常
□ Firefox（核心功能）：匯出降級為下載（非 File System Access）
```

### 安全驗收

```
□ DevTools Network 面板：零外部請求
□ 含惡意 JS 的 PDF：不執行任何 PDF 內嵌 JS
□ 長檔名（255字元）：正常顯示，不截斷重要資訊，不觸發 XSS
□ 清除 Session 後 IndexedDB 完全清空（DevTools Application 確認）
□ integrity.json 驗證腳本通過
```

---

## 16. 版本規劃

### v0.1 Alpha — 基礎骨架

```
✦ dist/ 資料夾結構與建置腳本
✦ EventBus / StateManager / CommandStack 架構
✦ DocumentEngine（pdf.js + pdf-lib 雙載入）
✦ Canvas 首頁渲染
✦ 縮圖面板（同步版，無 Worker）
✦ 基本合併匯出
```

### v0.5 Beta — 核心功能

```
✦ Thumbnail Worker（非同步）
✦ 拖拉排序（縮圖面板）
✦ 頁面旋轉（單頁 + 批次）
✦ 標注工具四種（螢光筆 / 手繪 / 文字 / 矩形）
✦ Undo/Redo（CommandStack）
✦ IndexedDB Session 持久化
✦ 拆分 + ZIP 下載
✦ 鍵盤快捷鍵完整
```

### v1.0 Release — 專業級

```
✦ 裁切（WYSIWYG）
✦ 圖片轉 PDF（含尺寸/DPI 設定）
✦ 頁碼插入
✦ 浮水印（文字 + 圖片）
✦ 密碼保護匯出
✦ 匯出 Worker（大文件非同步）
✦ 深色模式
✦ 虛擬滾動（> 100 頁）
✦ integrity.json 建置整合
✦ 完整 Smoke Test 清單通過
```

### v1.5 — 進階功能

```
✦ 書籤/大綱編輯
✦ PDF 元資料編輯（標題/作者）
✦ 匯出為圖片（PDF → PNG/JPG）
✦ 元素搜尋（文字搜尋 + 高亮）
✦ i18n 架構（zh-TW / en）
```

### v2.0 — 生態擴展

```
✦ Plugin 系統
✦ OCR（Tesseract.js，離線模型）
✦ 表單填寫
✦ 列印支援（CSS print media query）
✦ 多文件分頁工作區
```

---

*規格書結束 — OpenSpec v1.0.0*
