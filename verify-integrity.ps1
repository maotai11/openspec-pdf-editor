# verify-integrity.ps1
# Usage: cd OpenSpec && .\verify-integrity.ps1
# Verifies all dist/ files against integrity.json SHA-256 hashes.

$manifest = Get-Content "dist\integrity.json" | ConvertFrom-Json
$pass = 0; $fail = 0

foreach ($prop in $manifest.files.PSObject.Properties) {
    $relPath = $prop.Name -replace '/', '\'
    $filePath = "dist\$relPath"
    $expected = $prop.Value.sha256

    if (-not (Test-Path $filePath)) {
        Write-Host "MISSING: $($prop.Name)" -ForegroundColor Red
        $fail++
        continue
    }

    $actual = (Get-FileHash $filePath -Algorithm SHA256).Hash.ToLower()
    if ($actual -eq $expected) {
        Write-Host "OK:      $($prop.Name)" -ForegroundColor Green
        $pass++
    } else {
        Write-Host "FAIL:    $($prop.Name)" -ForegroundColor Red
        Write-Host "         expected: $expected"
        Write-Host "         actual:   $actual"
        $fail++
    }
}

Write-Host ""
Write-Host "Result: $pass OK, $fail FAILED" -ForegroundColor ($fail -eq 0 ? 'Green' : 'Red')
if ($fail -gt 0) { exit 1 }
