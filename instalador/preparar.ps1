# Arma la carpeta paquete\ que empaqueta el instalador: nuestro codigo compilado + Node.js portable.
# No incluye node_modules: el instalador los descarga de npm en la PC del usuario.
param([string]$NodeVersion = "22.12.0")
$ErrorActionPreference = "Stop"
$raiz = Split-Path -Parent $PSScriptRoot
$paquete = Join-Path $raiz "paquete"
if (Test-Path $paquete) { Remove-Item -Recurse -Force $paquete }
New-Item -ItemType Directory -Force $paquete | Out-Null

if (-not (Test-Path (Join-Path $raiz "dist\cli.js"))) { throw "Falta dist\cli.js: corre 'npm run build' antes." }
Copy-Item -Recurse (Join-Path $raiz "dist") (Join-Path $paquete "dist")
foreach ($f in "package.json", "package-lock.json", "LICENSE", "THIRD-PARTY-NOTICES.md", "README.md") {
  Copy-Item (Join-Path $raiz $f) $paquete
}
Copy-Item (Join-Path $PSScriptRoot "motor.cmd") $paquete

# Node.js portable, verificado contra el SHASUMS256.txt oficial.
$nombre = "node-v$NodeVersion-win-x64"
$tmp = Join-Path ([IO.Path]::GetTempPath()) "ttia-node-$NodeVersion"
New-Item -ItemType Directory -Force $tmp | Out-Null
$zip = Join-Path $tmp "$nombre.zip"
$base = "https://nodejs.org/dist/v$NodeVersion"
Invoke-WebRequest "$base/$nombre.zip" -OutFile $zip -UseBasicParsing
$sumas = (Invoke-WebRequest "$base/SHASUMS256.txt" -UseBasicParsing).Content -split "`n"
$esperado = ($sumas | Where-Object { $_ -match " $nombre\.zip$" }) -replace "\s.*$", ""
$real = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
if (-not $esperado -or $esperado.ToLower() -ne $real) { throw "El SHA256 de $nombre.zip no coincide con SHASUMS256.txt." }
Expand-Archive $zip -DestinationPath $tmp -Force
Move-Item (Join-Path $tmp $nombre) (Join-Path $paquete "node")
Write-Host "paquete listo en $paquete (Node $NodeVersion)"
