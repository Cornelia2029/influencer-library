# 零依赖静态文件服务器（PowerShell HttpListener）
# 用法：powershell -ExecutionPolicy Bypass -File server.ps1 [-Port 8765]
param([int]$Port = 8765)
$Root = $PSScriptRoot
if (-not $Root) { $Root = (Get-Location).Path }
$Root = $Root.TrimEnd('\')
Add-Type -AssemblyName System.Web
$prefix = "http://localhost:$Port/"
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add($prefix)
$listener.Start()
Write-Host "Serving '$Root' at $prefix  (Ctrl+C to stop)"
try {
  while ($listener.IsListening) {
    try {
      $ctx = $listener.GetContext()
      $req = $ctx.Request; $res = $ctx.Response
      $rawUrl = [Uri]::UnescapeDataString($req.Url.AbsolutePath)
      if ($rawUrl -eq '/') { $rawUrl = '/index.html' }
      $relPath = $rawUrl.TrimStart('/')
      $filePath = Join-Path $Root ($relPath -replace '/', '\')
      # 防止目录穿越
      $fullRoot = (Resolve-Path $Root).Path
      try { $resolved = (Resolve-Path $filePath -ErrorAction Stop).Path } catch { $resolved = $filePath }
      if ($resolved -and $resolved.StartsWith($fullRoot, [StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $resolved -PathType Leaf)) {
        $ext = [System.IO.Path]::GetExtension($resolved).ToLower()
        $mime = switch ($ext) {
          '.html' { 'text/html; charset=utf-8' }
          '.js'   { 'application/javascript; charset=utf-8' }
          '.css'  { 'text/css; charset=utf-8' }
          '.json' { 'application/json; charset=utf-8' }
          '.png'   { 'image/png' }
          '.jpg'   { 'image/jpeg' }
          '.svg'   { 'image/svg+xml' }
          default { 'application/octet-stream' }
        }
        $bytes = [System.IO.File]::ReadAllBytes($resolved)
        $res.ContentType = $mime
        $res.ContentLength64 = $bytes.Length
        $res.OutputStream.Write($bytes, 0, $bytes.Length)
      } else {
        $res.StatusCode = 404
        $body = [System.Text.Encoding]::UTF8.GetBytes("404 Not Found: $rawUrl")
        $res.OutputStream.Write($body, 0, $body.Length)
      }
    } catch {
      try { $ctx.Response.StatusCode = 500 } catch {}
    } finally {
      try { $ctx.Response.Close() } catch {}
    }
  }
} finally {
  $listener.Stop()
}
