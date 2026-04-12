# OpenSpec Security Checklist

This repository is packaged as an offline `file://` application, so the release
artifact itself is part of the trusted boundary.

## Development Guardrails

1. Before changing dependencies, run `npm audit --audit-level=high`.
2. If a package has a HIGH or CRITICAL advisory with no fix, stop and replace
   the package before upload.
3. Keep generated release files reproducible through `npm run build` and
   `dist/integrity.json`.

## Pre-Upload Workflow

Run this from the repository root:

```bash
npm run security:check
```

That command executes:

1. `npm test`
2. `npm run build`
3. `verify-integrity.ps1`
4. `npm audit --audit-level=high`

Upload only after all four steps pass.

## Current Notes

- The previous `xlsx` dependency was removed because `npm audit` reported a
  HIGH advisory with no upstream fix.
- Excel export now uses `exceljs`, which supports workbook creation and
  `workbook.xlsx.writeBuffer()` for browser-compatible XLSX output.
