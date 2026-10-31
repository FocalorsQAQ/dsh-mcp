; Compile with /DReleaseInclude=<absolute generated definitions file>.
#include ReleaseInclude

[Setup]
AppId={{C0BA8D32-0CC9-4FA4-906C-437E93D8F935}
AppName=DeepSeek Harness as Subagent
AppVersion={#AppVersion}
AppPublisher=FocalorsQAQ
AppPublisherURL=https://github.com/FocalorsQAQ/dsh-mcp
AppSupportURL=https://github.com/FocalorsQAQ/dsh-mcp/issues
DefaultDirName={localappdata}\Programs\dsh-mcp
DefaultGroupName=DeepSeek Harness as Subagent
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.19041
WizardStyle=modern
Compression=lzma2
SolidCompression=yes
ArchiveExtraction=full
SetupLogging=yes
LicenseFile=..\LICENSE
OutputDir={#ReleaseOutput}
OutputBaseFilename=dsh-mcp-{#AppVersion}-setup-win-x64
UninstallDisplayIcon={app}\node_modules\electron\dist\electron.exe
CloseApplications=no
DisableProgramGroupPage=yes

[Tasks]
Name: "codex"; Description: "Connect dsh to Codex automatically (recommended)"; GroupDescription: "Codex integration:"

[Files]
Source: "{tmp}\{#AppArchive}"; DestDir: "{app}"; Flags: external extractarchive recursesubdirs ignoreversion
Source: "{tmp}\{#CoreArchive}"; DestDir: "{app}"; Flags: external extractarchive recursesubdirs ignoreversion

[Icons]
Name: "{group}\DeepSeek Harness as Subagent"; Filename: "{app}\node_modules\electron\dist\electron.exe"; Parameters: """{app}\desktop\main.mjs"" --config ""{app}\dsh.config.json"""; WorkingDir: "{app}"
Name: "{group}\Installation guide"; Filename: "https://github.com/FocalorsQAQ/dsh-mcp/blob/main/docs/install.md"
Name: "{group}\Connect to Codex"; Filename: "{app}\Connect to Codex.cmd"; WorkingDir: "{app}"
Name: "{group}\Uninstall"; Filename: "{uninstallexe}"

[Run]
Filename: "{app}\node_modules\electron\dist\electron.exe"; Parameters: """{app}\desktop\main.mjs"" --config ""{app}\dsh.config.json"""; Description: "Open DeepSeek Harness as Subagent"; Flags: postinstall nowait skipifsilent

[UninstallRun]
Filename: "{app}\bin\python\python.exe"; Parameters: "-I -B ""{app}\packaging\codex_registration.py"" unregister --root ""{app}"""; Flags: runhidden waituntilterminated; RunOnceId: "dsh-remove-codex-registration"
Filename: "{app}\bin\node\node.exe"; Parameters: """{app}\packaging\uninstall-links.mjs"""; Flags: runhidden waituntilterminated; RunOnceId: "dsh-remove-runtime-links"

[Code]
var
  DownloadPage: TDownloadWizardPage;
  WorkspacePage: TInputDirWizardPage;

procedure InitializeWizard;
begin
  WorkspacePage := CreateInputDirPage(wpSelectDir, 'Agent workspace',
    'Choose the folder external agents can work in.',
    'The CLI core comes from DeepSeek Harness. This installer downloads the application and a pinned, redistributed official CLI runtime from GitHub Releases. Both are required. API keys are added after installation.', False, '');
  WorkspacePage.Add('Workspace folder:');
  WorkspacePage.Values[0] := ExpandConstant('{param:WORKSPACE|{userdocs}\dsh-workspace}');
  DownloadPage := CreateDownloadPage('Download from GitHub', 'Downloading and verifying the application and DeepSeek Harness CLI core...', nil);
  DownloadPage.ShowBaseNameInsteadOfUrl := True;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  Cached: String;
begin
  Result := '';
  try
    Cached := ExpandConstant('{param:PACKAGEDIR|}');
    if Cached <> '' then begin
      if (GetSHA256OfFile(AddBackslash(Cached) + '{#AppArchive}') <> '{#AppSHA256}') or
         (GetSHA256OfFile(AddBackslash(Cached) + '{#CoreArchive}') <> '{#CoreSHA256}') then
        RaiseException('Package checksum mismatch. Download both matching release archives again.');
      if not FileCopy(AddBackslash(Cached) + '{#AppArchive}', ExpandConstant('{tmp}\{#AppArchive}'), False) then
        RaiseException('Cannot copy application archive.');
      if not FileCopy(AddBackslash(Cached) + '{#CoreArchive}', ExpandConstant('{tmp}\{#CoreArchive}'), False) then
        RaiseException('Cannot copy CLI core archive.');
    end else begin
      DownloadPage.Clear;
      DownloadPage.Add('{#DownloadBase}/{#AppArchive}', '{#AppArchive}', '{#AppSHA256}');
      DownloadPage.Add('{#DownloadBase}/{#CoreArchive}', '{#CoreArchive}', '{#CoreSHA256}');
      DownloadPage.Show;
      try
        DownloadPage.Download;
      finally
        DownloadPage.Hide;
      end;
    end;
  except
    Result := GetExceptionMessage;
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  Code: Integer;
  Arguments: String;
begin
  if CurStep = ssPostInstall then begin
    Arguments := '"' + ExpandConstant('{app}\packaging\initialize.mjs') + '" --workspace "' + WorkspacePage.Values[0] + '" --data-dir "' + ExpandConstant('{param:DATADIR|{localappdata}\dsh-mcp\data}') + '"';
    if not ExecAndLogOutput(ExpandConstant('{app}\bin\node\node.exe'), Arguments,
      ExpandConstant('{app}'), SW_SHOWNORMAL, ewWaitUntilTerminated, Code, nil) then
      RaiseException('Unable to initialize the CLI core.');
    if Code <> 0 then RaiseException('CLI core initialization failed. See initialization-result.json in the installation folder and the Setup Log for details.');
    if WizardIsTaskSelected('codex') then begin
      if not Exec(ExpandConstant('{app}\bin\python\python.exe'),
        '-I -B "' + ExpandConstant('{app}\packaging\codex_registration.py') + '" register --root "' + ExpandConstant('{app}') + '"',
        ExpandConstant('{app}'), SW_HIDE, ewWaitUntilTerminated, Code) then Code := 2;
      if Code <> 0 then
        SuppressibleMsgBox('The application is installed, but Codex registration needs attention. Existing Codex settings were preserved. See codex-registration-result.json in the installation folder, or use codex-mcp.toml to connect manually.', mbInformation, MB_OK, IDOK)
      else
        WizardForm.FinishedLabel.Caption := 'Installation completed and dsh is registered with Codex. Restart Codex to load the tools. Add API keys and enable a model in the control window before running a task.';
    end;
  end;
end;
