$ErrorActionPreference = "Stop"

$source = "E:\Other computers\Windows 11 - 2022\Graphic Design"
$targets = @(
  "\\192.168.1.7\D$\BACKUP",
  "\\192.168.1.7\F$\Backup\Graphic Design"
)

foreach ($target in $targets) {
  $label = ($target -replace '[^A-Za-z0-9]+', '-').Trim('-')
  $log = "D:\PC Backup Restore\graphic-design-remote-$label.log"
  robocopy.exe $source $target /E /Z /J /MT:16 /XO /COPY:DAT /DCOPY:DAT /R:5 /W:10 /XJ /NP /LOG:$log
  if ($LASTEXITCODE -ge 8) { exit $LASTEXITCODE }
}
