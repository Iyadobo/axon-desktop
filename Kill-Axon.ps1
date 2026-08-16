# Emergency cleanup for stray Axon desktop processes.
$targets = Get-Process -ErrorAction SilentlyContinue | Where-Object {
  $_.ProcessName -eq 'Axon' -or
  # -like is not regex: a backslash needs no escaping here, and '\\' would only
  # ever match a literal double backslash, so the dev instances were never caught.
  ($_.ProcessName -eq 'electron' -and $_.Path -like '*ollama-desktop-harness*electron.exe')
}
if ($targets) { $targets | Stop-Process -Force; Write-Host 'Stopped Axon.' }
else { Write-Host 'Axon is not running.' }
