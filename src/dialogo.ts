import { execFile } from "node:child_process";

/**
 * Dialogo nativo de Windows para elegir una carpeta (FolderBrowserDialog), abierto por el motor en la PC de la persona.
 * La web solo pide «abre el dialogo»: la ruta la elige la persona aqui, nunca la manda la pagina.
 * Devuelve la ruta elegida o null si cancelo / cerro la ventana / vencio el tiempo.
 */
const SCRIPT = [
  "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
  "Add-Type -AssemblyName System.Windows.Forms",
  "$f = New-Object System.Windows.Forms.Form",
  "$f.TopMost = $true; $f.ShowInTaskbar = $false; $f.Opacity = 0; $f.StartPosition = 'CenterScreen'",
  "$f.Show(); $f.Activate()",
  "$d = New-Object System.Windows.Forms.FolderBrowserDialog",
  "$d.Description = 'THE TOWN IA: elige la carpeta donde tu agente podra trabajar'",
  "$d.ShowNewFolderButton = $true",
  "if ($d.ShowDialog($f) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.SelectedPath) }",
  "$f.Close()",
].join("; ");

/** 10 minutos para elegir; despues se cierra como si se hubiera cancelado. */
export const DIALOGO_TIMEOUT_MS = 10 * 60 * 1000;

export function elegirCarpetaWindows(timeoutMs: number = DIALOGO_TIMEOUT_MS): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-Command", SCRIPT],
      { windowsHide: true, timeout: timeoutMs, encoding: "utf8" },
      (err, stdout) => {
        if (err) return resolve(null);
        const ruta = String(stdout).trim();
        resolve(ruta === "" ? null : ruta);
      },
    );
  });
}
