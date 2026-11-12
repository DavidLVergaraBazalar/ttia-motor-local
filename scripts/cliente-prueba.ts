/**
 * Cliente de prueba del motor local.
 *
 * Sin argumentos: levanta el motor en --simulado con una config temporal, empareja con el codigo
 * que el motor imprime, manda una tarea y aprueba el permiso. Es la prueba de humo.
 *
 * Contra un motor ya corriendo:
 *   tsx scripts/cliente-prueba.ts --codigo 123456 [--puerto 47821] [--origen http://localhost:8765] [--carpeta C:\ruta] [--denegar]
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const aqui = path.dirname(fileURLToPath(import.meta.url));
const raiz = path.resolve(aqui, "..");

function arg(nombre: string): string | undefined {
  const i = process.argv.indexOf(`--${nombre}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function lanzarMotor(): Promise<{ puerto: number; codigo: string; carpeta: string; detener: () => void }> {
  const datos = fs.mkdtempSync(path.join(os.tmpdir(), "awki-humo-"));
  const carpeta = fs.mkdtempSync(path.join(os.tmpdir(), "awki-trabajo-"));
  const puerto = 40000 + Math.floor(Math.random() * 10000);
  fs.writeFileSync(
    path.join(datos, "motor.json"),
    JSON.stringify({ carpetas_permitidas: [carpeta], origenes: ["http://localhost:8765"], puerto }),
  );
  const hijo = spawn(process.execPath, [path.join(raiz, "node_modules", "tsx", "dist", "cli.mjs"), path.join(raiz, "src", "cli.ts"), "--simulado"], {
    env: { ...process.env, AWKI_OFFICE_DIR: datos },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const codigo = await new Promise<string>((resolve, reject) => {
    let salida = "";
    const t = setTimeout(() => reject(new Error("El motor no mostro el codigo a tiempo.")), 15000);
    hijo.stdout.on("data", (d: Buffer) => {
      const texto = d.toString();
      salida += texto;
      process.stdout.write(`[motor] ${texto}`);
      const m = /Codigo de emparejamiento: (\d{6})/.exec(salida);
      if (m?.[1]) {
        clearTimeout(t);
        resolve(m[1]);
      }
    });
    hijo.once("exit", (c) => reject(new Error(`El motor termino antes de tiempo (codigo ${c}).`)));
  });
  return { puerto, codigo, carpeta, detener: () => hijo.kill() };
}

async function main(): Promise<void> {
  let puerto = Number(arg("puerto") ?? 47821);
  let codigo = arg("codigo");
  let carpeta = arg("carpeta");
  let detener = (): void => {};
  if (!codigo) {
    const m = await lanzarMotor();
    ({ puerto, codigo, carpeta, detener } = m);
  }
  const denegar = process.argv.includes("--denegar");
  const origen = arg("origen") ?? "http://localhost:8765";

  const ws = new WebSocket(`ws://127.0.0.1:${puerto}`, { origin: origen });
  const fin = new Promise<void>((resolve, reject) => {
    let token = "";
    ws.on("open", () => ws.send(JSON.stringify({ tipo: "emparejar", codigo })));
    ws.on("error", reject);
    ws.on("message", (d) => {
      const m = JSON.parse(d.toString()) as Record<string, unknown>;
      if (m.tipo === "texto") process.stdout.write(String(m.delta));
      else console.log("\n<-", JSON.stringify(m));
      if (m.tipo === "emparejado") {
        token = String(m.token);
        ws.send(JSON.stringify({ tipo: "tarea", token, id: "tarea-1", prompt: "Lee las notas y escribe un resumen", carpeta }));
      } else if (m.tipo === "permiso") {
        console.log(`-> ${denegar ? "denegando" : "aprobando"} el permiso ${String(m.id)}`);
        ws.send(JSON.stringify({ tipo: "respuesta_permiso", token, id: m.id, aprobado: !denegar }));
      } else if (m.tipo === "estado" && (m.estado === "libre" || m.estado === "entregable_listo")) {
        resolve();
      } else if (m.tipo === "error") {
        reject(new Error(`El motor respondio un error: ${String(m.codigo)}`));
      }
    });
  });
  try {
    await fin;
    console.log("\nPRUEBA DE HUMO OK");
  } finally {
    ws.close();
    detener();
  }
}

main().then(
  () => process.exit(0),
  (e: unknown) => {
    console.error("PRUEBA DE HUMO FALLO:", e instanceof Error ? e.message : String(e));
    process.exit(1);
  },
);
