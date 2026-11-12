import { Entry } from "@napi-rs/keyring";

const SERVICIO = "AwkiOffice";
const USUARIO = "claude-api-key";

/** Almacen de la clave. En Windows es el Administrador de credenciales. */
export interface AlmacenClave {
  obtener(): string | null;
  guardar(clave: string): void;
  borrar(): boolean;
}

export const almacenWindows: AlmacenClave = {
  obtener() {
    return new Entry(SERVICIO, USUARIO).getPassword();
  },
  guardar(clave) {
    new Entry(SERVICIO, USUARIO).setPassword(clave);
  },
  borrar() {
    return new Entry(SERVICIO, USUARIO).deletePassword();
  },
};

/** Pide un texto por stdin sin eco. Si no hay TTY, lee una linea tal cual (para tuberias). */
export function pedirSinEco(pregunta: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stdout.write(pregunta);
    if (!stdin.isTTY) {
      let buf = "";
      stdin.setEncoding("utf8");
      stdin.on("data", (d) => (buf += d));
      stdin.on("end", () => resolve(buf.split(/\r?\n/)[0] ?? ""));
      stdin.on("error", reject);
      return;
    }
    let valor = "";
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const fin = (): void => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", alDato);
      process.stdout.write("\n");
    };
    const alDato = (tecla: string): void => {
      for (const ch of tecla) {
        if (ch === "\r" || ch === "\n") {
          fin();
          resolve(valor);
          return;
        }
        if (ch === "\u0003") {
          fin();
          reject(new Error("Cancelado."));
          return;
        }
        if (ch === "\u007f" || ch === "\b") valor = valor.slice(0, -1);
        else valor += ch;
      }
    };
    stdin.on("data", alDato);
  });
}

export async function claveSet(almacen: AlmacenClave = almacenWindows): Promise<void> {
  const clave = (await pedirSinEco("Pega tu API key de Claude (no se mostrara): ")).trim();
  if (!clave) throw new Error("No escribiste ninguna clave.");
  if (!clave.startsWith("sk-ant-")) {
    throw new Error('Esa clave no parece una API key de Anthropic (debe empezar con "sk-ant-", por ejemplo sk-ant-api03- o sk-ant-usr-).');
  }
  almacen.guardar(clave);
}

export function claveBorrar(almacen: AlmacenClave = almacenWindows): boolean {
  return almacen.borrar();
}

export function claveEstado(almacen: AlmacenClave = almacenWindows): boolean {
  const c = almacen.obtener();
  return c !== null && c !== "";
}
