# Packages the app files, builds the debug APK, installs it on the connected device and saves the device log.
# Usage (from the repo root): .\scripts\android-install.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$env:JAVA_HOME = 'C:\Program Files\Eclipse Adoptium\jdk-21.0.13.9-hotspot'
$adb = Join-Path $env:LOCALAPPDATA 'Android\Sdk\platform-tools\adb.exe'

node (Join-Path $root 'scripts\android-assets.mjs')
Push-Location (Join-Path $root 'android')
try {
    .\gradlew.bat assembleDebug --no-daemon
    & $adb install -r app\build\outputs\apk\debug\app-debug.apk
    & $adb logcat -c
    & $adb shell am start -n app.souldew/.MainActivity
    Start-Sleep -Seconds 15
    $log = Join-Path $root 'android\device-log.txt'
    & $adb logcat -d -v time | Out-File $log -Encoding utf8
    Write-Host "log saved: $log"
} finally {
    Pop-Location
}
