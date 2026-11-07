# Optional: publish this independent adapter source to chrvidal/ioBroker.coffeelink.
# This script NEVER force-pushes, creates releases or publishes to npm.
# It refuses to push if the remote repository already has a branch.
$ErrorActionPreference = 'Stop'
$target = 'https://github.com/chrvidal/ioBroker.coffeelink.git'
$project = $PSScriptRoot

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    throw 'Git ist nicht installiert.'
}
if (Test-Path (Join-Path $project '.git')) {
    throw 'Der Ordner ist bereits ein Git-Repository. Bitte manuell kontrollieren.'
}

Write-Host 'Pruefe, ob das GitHub-Repository noch leer ist ...'
$remoteBranches = & git ls-remote --heads $target
if ($LASTEXITCODE -ne 0) { throw 'GitHub ist nicht erreichbar oder die Git-Anmeldung fehlt.' }
if ($remoteBranches) {
    throw 'GitHub-Repository hat bereits Commits. Sicherheitshalber kein automatischer Push.'
}

Push-Location $project
try {
    & git init -b main
    if ($LASTEXITCODE -ne 0) { throw 'git init fehlgeschlagen.' }
    & git add .
    if ($LASTEXITCODE -ne 0) { throw 'git add fehlgeschlagen.' }
    & git commit -m 'Initial independent Coffee Link adapter (read-only)'
    if ($LASTEXITCODE -ne 0) { throw 'git commit fehlgeschlagen. Git-Benutzerdaten pruefen.' }
    & git remote add origin $target
    if ($LASTEXITCODE -ne 0) { throw 'git remote add fehlgeschlagen.' }
    & git push -u origin main
    if ($LASTEXITCODE -ne 0) { throw 'git push fehlgeschlagen. Keine erzwungenen Aenderungen.' }
    Write-Host 'FERTIG: Code auf https://github.com/chrvidal/ioBroker.coffeelink'
} finally {
    Pop-Location
}
