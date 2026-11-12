import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { configPorDefecto, type ConfigMotor } from "../src/config.js";
import { Emparejamiento } from "../src/emparejamiento.js";
import { loggerSilencioso } from "../src/log.js";
import { ServidorMotor } from "../src/servidor.js";
import type { Ejecutor } from "../src/protocolo.js";
import { EjecutorSimulado } from "../src/simulado.js";

export const ORIGEN_OK = "http://localhost:8765";

export function carpetaTemporal(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "awki-motor-")));
}

export async function arrancar(opc: {
  carpetas?: string[];
  ejecutor?: Ejecutor;
  permisoTimeoutMs?: number;
  ahora?: () => number;
}) {
  const config: ConfigMotor = { ...configPorDefecto(), carpetas_permitidas: opc.carpetas ?? [] };
  const emparejamiento = new Emparejamiento(opc.ahora);
  const servidor = new ServidorMotor({
    config: () => config,
    ejecutor: opc.ejecutor ?? new EjecutorSimulado(10),
    emparejamiento,
    log: loggerSilencioso,
    simulado: true,
    hayClave: () => false,
    puerto: 0,
    permisoTimeoutMs: opc.permisoTimeoutMs,
  });
  const puerto = await servidor.iniciar();
  return { servidor, emparejamiento, puerto, config };
}

export interface Cliente {
  ws: WebSocket;
  recibidos: Array<Record<string, unknown>>;
  enviar(m: unknown): void;
  esperar(pred: (m: Record<string, unknown>) => boolean, ms?: number): Promise<Record<string, unknown>>;
  cerrar(): void;
}

export function conectar(puerto: number, origen: string | null = ORIGEN_OK): Promise<Cliente> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${puerto}`, origen ? { origin: origen } : {});
    const recibidos: Array<Record<string, unknown>> = [];
    const oyentes: Array<() => void> = [];
    ws.on("message", (d) => {
      recibidos.push(JSON.parse(d.toString()) as Record<string, unknown>);
      oyentes.forEach((f) => f());
    });
    ws.once("error", reject);
    ws.once("open", () =>
      resolve({
        ws,
        recibidos,
        enviar: (m) => ws.send(JSON.stringify(m)),
        esperar: (pred, ms = 3000) =>
          new Promise((res, rej) => {
            const t = setTimeout(() => rej(new Error("Tiempo agotado esperando mensaje")), ms);
            const revisar = (): boolean => {
              const m = recibidos.find(pred);
              if (m) {
                clearTimeout(t);
                res(m);
                return true;
              }
              return false;
            };
            if (!revisar()) oyentes.push(() => void revisar());
          }),
        cerrar: () => ws.close(),
      }),
    );
  });
}

export async function emparejado(puerto: number, codigo: string): Promise<{ c: Cliente; token: string }> {
  const c = await conectar(puerto);
  c.enviar({ tipo: "emparejar", codigo });
  const r = await c.esperar((m) => m.tipo === "emparejado");
  return { c, token: r.token as string };
}
