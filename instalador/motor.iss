; Instalador del motor local de THE TOWN IA (Inno Setup 6).
; Lo construye .github/workflows/motor.yml al crear una etiqueta vX.Y.Z. Para construirlo a mano:
;   npm ci && npm run build && powershell -File instalador\preparar.ps1 && ISCC instalador\motor.iss
;
; Lleva Node.js y nuestro codigo. El Claude Agent SDK de Anthropic NO va dentro: se descarga de npm en la PC del
; usuario durante la instalacion, sin modificar (ver THIRD-PARTY-NOTICES.md).

#define AppVersion GetEnv("TTIA_VERSION")
#if AppVersion == ""
  #define AppVersion "0.0.0-local"
#endif

[Setup]
AppId={{6B0F6E2A-1C55-4E7B-9C1D-7A7A2D1E0B11}
AppName=THE TOWN IA - Motor local
AppVersion={#AppVersion}
AppVerName=THE TOWN IA - Motor local {#AppVersion}
AppPublisher=David Vergara Bazalar
AppPublisherURL=https://ttia.awki.ai
AppSupportURL=https://github.com/DavidLVergaraBazalar/ttia-motor-local
DefaultDirName={localappdata}\Programs\TTIA Motor Local
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir=salida
OutputBaseFilename=TTIA-Motor-Setup
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
LicenseFile=..\LICENSE
UninstallDisplayName=THE TOWN IA - Motor local
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible

[Languages]
Name: "es"; MessagesFile: "compiler:Languages\Spanish.isl"

[Tasks]
Name: "inicio"; Description: "Arrancar el motor al iniciar Windows"; Flags: unchecked

[Files]
Source: "..\paquete\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{userprograms}\THE TOWN IA\Motor local"; Filename: "{app}\motor.cmd"; WorkingDir: "{app}"
Name: "{userprograms}\THE TOWN IA\Guardar mi clave de Claude"; Filename: "{app}\motor.cmd"; Parameters: "clave set"; WorkingDir: "{app}"
Name: "{userprograms}\THE TOWN IA\Probar sin clave (simulado)"; Filename: "{app}\motor.cmd"; Parameters: "--simulado"; WorkingDir: "{app}"
Name: "{userprograms}\THE TOWN IA\Ver carpetas permitidas"; Filename: "{app}\motor.cmd"; Parameters: "carpeta lista"; WorkingDir: "{app}"
Name: "{userprograms}\THE TOWN IA\Desinstalar el motor"; Filename: "{uninstallexe}"
Name: "{userstartup}\THE TOWN IA - Motor local"; Filename: "{app}\motor.cmd"; WorkingDir: "{app}"; Tasks: inicio

[Run]
Filename: "{app}\motor.cmd"; Parameters: "clave set"; WorkingDir: "{app}"; Description: "Guardar ahora mi clave de API de Claude"; Flags: postinstall skipifsilent waituntilterminated
Filename: "{app}\motor.cmd"; WorkingDir: "{app}"; Description: "Arrancar el motor"; Flags: postinstall skipifsilent nowait unchecked

[UninstallDelete]
Type: filesandordirs; Name: "{app}\node_modules"
Type: files; Name: "{app}\instalacion.log"

[Code]
var
  PaginaCarpeta: TInputDirWizardPage;

procedure InitializeWizard;
begin
  PaginaCarpeta := CreateInputDirPage(wpSelectDir,
    'Carpeta de trabajo de tu agente',
    'Tu agente solo podra leer y escribir dentro de esta carpeta.',
    'Elige la carpeta donde tu agente puede trabajar. Despues puedes agregar o quitar carpetas con el comando "carpeta" del motor.',
    False, '');
  PaginaCarpeta.Add('');
  PaginaCarpeta.Values[0] := ExpandConstant('{userdocs}');
end;

function Ejecutar(const Archivo, Parametros, Mensaje: String): Boolean;
var
  Codigo: Integer;
begin
  WizardForm.StatusLabel.Caption := Mensaje;
  Result := Exec(ExpandConstant('{cmd}'),
    '/C ""' + Archivo + '" ' + Parametros + ' >> "' + ExpandConstant('{app}\instalacion.log') + '" 2>&1"',
    ExpandConstant('{app}'), SW_HIDE, ewWaitUntilTerminated, Codigo) and (Codigo = 0);
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
  begin
    // El SDK de Anthropic y las demas dependencias se descargan de npm, en esta PC y sin modificar.
    if not Ejecutar(ExpandConstant('{app}\node\npm.cmd'), 'ci --omit=dev --no-audit --no-fund',
                    'Descargando el motor de Claude desde npm (puede tardar unos minutos)...') then
      MsgBox('No se pudieron descargar los componentes del motor. Revisa tu conexion a internet y vuelve a ' +
             'ejecutar el instalador. Detalle en: ' + ExpandConstant('{app}\instalacion.log'), mbError, MB_OK);
    if not Ejecutar(ExpandConstant('{app}\node\node.exe'),
                    '"' + ExpandConstant('{app}\dist\cli.js') + '" carpeta agregar "' + PaginaCarpeta.Values[0] + '"',
                    'Guardando la carpeta de trabajo...') then
      MsgBox('No se pudo guardar la carpeta de trabajo. Agregala despues con: motor.cmd carpeta agregar <ruta>',
             mbInformation, MB_OK);
  end;
end;
