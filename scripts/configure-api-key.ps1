param()

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$projectPath = Split-Path -Parent $PSScriptRoot
$envPath = Join-Path $projectPath '.env'
$statusDirectory = Join-Path $projectPath '.dsh-mcp'
$statusPath = Join-Path $statusDirectory 'key-setup-status.json'
[System.IO.Directory]::CreateDirectory($statusDirectory) | Out-Null
$utf8 = New-Object System.Text.UTF8Encoding($false)

function Set-SetupStatus([string]$state) {
    $status = @{ state = $state; pid = $PID; updated_at = [DateTime]::UtcNow.ToString('o') } | ConvertTo-Json -Compress
    [System.IO.File]::WriteAllText($statusPath, $status, $utf8)
}

# Text is expressed with Unicode escapes via JSON so Windows PowerShell 5.1 can read this ASCII script.
$copy = @'
{"title":"dsh - DeepSeek API Key","heading":"\u8f93\u5165 DeepSeek \u5b98\u65b9 API Key","note":"\u5bc6\u94a5\u4ec5\u4fdd\u5b58\u5230\u6b64\u9879\u76ee\u7684 .env\uff0c\u4e0d\u4f1a\u663e\u793a\u5728\u804a\u5929\u91cc\u3002","save":"\u4fdd\u5b58","cancel":"\u53d6\u6d88","invalid":"\u8bf7\u8f93\u5165\u6709\u6548\u7684 API Key\uff08\u4e0d\u8981\u5305\u542b\u7a7a\u683c\u6216\u5f15\u53f7\uff09\u3002","failed":"\u4fdd\u5b58\u5931\u8d25\uff0c\u8bf7\u68c0\u67e5\u9879\u76ee\u76ee\u5f55\u7684\u5199\u5165\u6743\u9650\u540e\u91cd\u8bd5\u3002"}
'@ | ConvertFrom-Json

$form = New-Object System.Windows.Forms.Form
$form.Text = $copy.title
$form.ClientSize = New-Object System.Drawing.Size(590, 260)
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$form.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 10)
$form.TopMost = $true

$heading = New-Object System.Windows.Forms.Label
$heading.Text = $copy.heading
$heading.SetBounds(24, 22, 540, 30)
$form.Controls.Add($heading)

$inputBox = New-Object System.Windows.Forms.TextBox
$inputBox.UseSystemPasswordChar = $true
$inputBox.MaxLength = 1024
$inputBox.SetBounds(24, 59, 540, 30)
$form.Controls.Add($inputBox)

$note = New-Object System.Windows.Forms.Label
$note.Text = $copy.note + "`r`n" + $envPath
$note.SetBounds(24, 104, 540, 55)
$note.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9)
$form.Controls.Add($note)

$errorLabel = New-Object System.Windows.Forms.Label
$errorLabel.ForeColor = [System.Drawing.Color]::Firebrick
$errorLabel.SetBounds(24, 162, 540, 30)
$form.Controls.Add($errorLabel)

$saveButton = New-Object System.Windows.Forms.Button
$saveButton.Text = $copy.save
$saveButton.SetBounds(354, 206, 100, 32)
$form.Controls.Add($saveButton)
$form.AcceptButton = $saveButton

$cancelButton = New-Object System.Windows.Forms.Button
$cancelButton.Text = $copy.cancel
$cancelButton.SetBounds(464, 206, 100, 32)
$cancelButton.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
$form.Controls.Add($cancelButton)
$form.CancelButton = $cancelButton
$script:keySaved = $false

$saveButton.Add_Click({
    $keyValue = $inputBox.Text.Trim()
    if ($keyValue -notmatch '^[A-Za-z0-9._-]{8,1024}$') {
        $errorLabel.Text = $copy.invalid
        $keyValue = $null
        return
    }
    try {
        $original = if ([System.IO.File]::Exists($envPath)) { [System.IO.File]::ReadAllText($envPath) } else { '' }
        $lines = [System.Collections.Generic.List[string]]::new()
        $inserted = $false
        foreach ($line in ($original -split '\r?\n')) {
            if ($line -match '^\s*(?:export\s+)?DEEPSEEK_API_KEY\s*=') {
                if (-not $inserted) { $lines.Add('DEEPSEEK_API_KEY=' + $keyValue); $inserted = $true }
            } else {
                $lines.Add($line)
            }
        }
        if (-not $inserted) { $lines.Add('DEEPSEEK_API_KEY=' + $keyValue) }
        $newContent = ($lines -join "`r`n").Trim([char[]]"`r`n") + "`r`n"
        [System.IO.File]::WriteAllText($envPath, $newContent, $utf8)
        $script:keySaved = $true
        $inputBox.Clear()
        Set-SetupStatus 'saved'
        $form.DialogResult = [System.Windows.Forms.DialogResult]::OK
        $form.Close()
    } catch {
        # Error text never includes a submitted key or the file contents.
        $errorLabel.Text = $copy.failed
    } finally {
        $keyValue = $null
        $newContent = $null
        $original = $null
        $lines = $null
    }
})

$form.Add_Shown({
    Set-SetupStatus 'opened'
    $form.Activate()
    $inputBox.Focus() | Out-Null
    $form.TopMost = $false
})
$form.Add_FormClosed({
    $inputBox.Clear()
    if (-not $script:keySaved) { Set-SetupStatus 'cancelled' }
})

try { $form.ShowDialog() | Out-Null }
finally { $form.Dispose() }
