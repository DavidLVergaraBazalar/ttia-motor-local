import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import type { ConfigMotor } from "./config.js";
import { Emparejamiento } from "./emparejamiento.js";
import { rutaPermitida, resolverReal } from "./rutas.js";
import { SolicitudesPermiso } from "./permisos.js";
import type { Ejecutor, Evento } from "./protocolo.js";
import type { Logger } from "./log.js";
import type { EstadoDespachador } from "./despachador.js";

export const VERSION = "0.5.0";
export const MAX_SISTEMA = 100_000;
const SESION_VALIDA = /^[A-Za-z0-9-]{8,100}$/;
const MAX_MENSAJE = 256 * 1024;
const MAX_NO_AUTORIZADOS = 10;

export interface OpcionesServidor {
  config: () => ConfigMotor;
  ejecutor: Ejecutor;
  emparejamiento: Emparejamiento;
  log: Logger;
  simulado: boolean;
  hayClave: () => boolean;
  hayWorkspace?: () => boolean;
  /** Abre el dialogo nativo para elegir una carpeta. null = la persona cancelo. Sin esto, la web no puede agregar carpetas. */
  elegirCarpeta?: () => Promise<string | null>;
  /** Agrega o quita una carpeta permitida en motor.json y recarga la configuracion. Devuelve la lista final. */
  cambiarCarpeta?: (ruta: string, accion: "agregar" | "quitar") => string[];
  /** Estado del despachador (para el `info`). Sin esto, el info no trae el campo. */
  despachador?: () => EstadoDespachador;
  /** 0 = puerto libre (tests). */
  puerto?: number;
  permisoTimeoutMs?: number;
}

interface TareaActiva {
  id: string;
  ws: WebSocket;
  abort: AbortController;
}

export class ServidorMotor {
  readonly wss: WebSocketServer;
  private http: http.Server;
  private tarea: TareaActiva | null = null;
  readonly permisos: SolicitudesPermiso;

  constructor(private o: OpcionesServidor) {
    this.permisos = new SolicitudesPermiso(o.permisoTimeoutMs);
    this.http = http.createServer((_req, res) => {
      res.writeHead(426, { "content-type": "text/plain; charset=utf-8" });
      res.end("Este puerto es solo para el WebSocket de THE TOWN IA.");
    });
    this.wss = new WebSocketServer({
      server: this.http,
      maxPayload: MAX_MENSAJE,
      verifyClient: (info, cb) => {
        const origen = info.origin;
        const permitidos = this.o.config().origenes;
        if (!origen || !permitidos.includes(origen)) {
          this.o.log.error("origen rechazado", { origen: origen ?? "(ninguno)" });
          return cb(false, 403, "Origen no permitido");
        }
        if (!hostLocalValido(info.req.headers.host)) {
          this.o.log.error("host rechazado", { host: info.req.headers.host ?? "(ninguno)" });
          return cb(false, 403, "Host no permitido");
        }
        cb(true);
      },
    });
    this.wss.on("connection", (ws) => this.alConectar(ws));
  }

  /** Escucha SOLO en 127.0.0.1. Devuelve el puerto real. */
  iniciar(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.http.once("error", reject);
      this.http.listen(this.o.puerto ?? this.o.config().puerto, "127.0.0.1", () => {
        const dir = this.http.address();
        resolve(typeof dir === "object" && dir ? dir.port : 0);
      });
    });
  }

  /** Direccion en la que realmente escucha (para verificar que es 127.0.0.1). */
  get direccion(): string | null {
    const d = this.http.address();
    return typeof d === "object" && d ? d.address : null;
  }

  async detener(): Promise<void> {
    this.tarea?.abort.abort();
    this.permisos.cancelarTodas();
    for (const c of this.wss.clients) c.terminate();
    await new Promise<void>((r) => this.wss.close(() => r()));
    await new Promise<void>((r) => this.http.close(() => r()));
  }

  private enviar(ws: WebSocket, ev: Evento): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(ev));
  }

  private alConectar(ws: WebSocket): void {
    let noAutorizados = 0;
    ws.on("message", (datos) => {
      let msg: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(datos.toString());
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("no es objeto");
        msg = parsed as Record<string, unknown>;
      } catch {
        return this.enviar(ws, { tipo: "error", codigo: "json_invalido", mensaje: "El mensaje no es un JSON valido." });
      }

      if (msg.tipo === "emparejar") return this.emparejar(ws, msg);

      if (!this.o.emparejamiento.tokenValido(msg.token)) {
        noAutorizados++;
        this.enviar(ws, { tipo: "error", codigo: "no_autorizado", mensaje: "Falta el token de sesion o no es valido. Empareja primero." });
        if (noAutorizados >= MAX_NO_AUTORIZADOS) ws.close(1008, "demasiados mensajes sin autorizacion");
        return;
      }

      switch (msg.tipo) {
        case "info":
          return this.enviar(ws, {
            tipo: "info",
            version: VERSION,
            simulado: this.o.simulado,
            modelo: this.o.config().modelo,
            hay_clave: this.o.hayClave(),
            hay_workspace: this.o.hayWorkspace?.() ?? false,
            carpetas: this.o.config().carpetas_permitidas,
            ocupado: this.tarea !== null,
            ...(this.o.despachador ? { despachador: this.o.despachador() } : {}),
          });
        case "tarea":
          return this.iniciarTarea(ws, msg);
        case "respuesta_permiso":
          if (typeof msg.id !== "string" || typeof msg.aprobado !== "boolean") {
            return this.enviar(ws, { tipo: "error", codigo: "mensaje_invalido", mensaje: "respuesta_permiso necesita id y aprobado (true/false)." });
          }
          if (!this.permisos.responder(msg.id, msg.aprobado)) {
            this.enviar(ws, { tipo: "error", codigo: "permiso_desconocido", mensaje: "Ese permiso ya no esta pendiente (vencio o ya se respondio)." });
          }
          return;
        case "carpeta_elegir":
          return void this.elegirCarpeta(ws);
        case "carpeta_quitar":
          return this.quitarCarpeta(ws, msg);
        case "cancelar":
          if (this.tarea && (msg.id === undefined || msg.id === this.tarea.id)) {
            this.log("tarea cancelada por la web", this.tarea.id);
            this.tarea.abort.abort();
            this.permisos.cancelarTodas();
          }
          return;
        default:
          return this.enviar(ws, { tipo: "error", codigo: "tipo_desconocido", mensaje: "Tipo de mensaje desconocido." });
      }
    });
    ws.on("close", () => {
      if (this.tarea?.ws === ws) {
        this.tarea.abort.abort();
        this.permisos.cancelarTodas();
      }
    });
    ws.on("error", () => ws.terminate());
  }

  private eligiendo = false;

  /** La web pide agregar una carpeta: el motor abre el dialogo de Windows y la persona la elige ahi (la web no manda rutas). */
  private async elegirCarpeta(ws: WebSocket): Promise<void> {
    const elegir = this.o.elegirCarpeta, cambiar = this.o.cambiarCarpeta;
    if (!elegir || !cambiar) {
      return this.enviar(ws, { tipo: "error", codigo: "no_disponible", mensaje: "Este motor no puede abrir el dialogo de carpetas. Usa: carpeta agregar <ruta>." });
    }
    if (this.eligiendo) {
      return this.enviar(ws, { tipo: "error", codigo: "dialogo_abierto", mensaje: "Ya hay una ventana para elegir carpeta abierta en tu PC." });
    }
    this.eligiendo = true;
    try {
      const ruta = await elegir();
      if (!ruta) return this.enviar(ws, { tipo: "carpetas", carpetas: this.o.config().carpetas_permitidas, agregada: null });
      const carpetas = cambiar(ruta, "agregar");
      this.o.log.info("carpeta agregada desde la web");
      this.enviar(ws, { tipo: "carpetas", carpetas, agregada: ruta });
    } catch (e) {
      this.enviar(ws, { tipo: "error", codigo: "carpeta_invalida", mensaje: e instanceof Error ? e.message : String(e) });
    } finally {
      this.eligiendo = false;
    }
  }

  /** Quitar reduce el acceso: se acepta desde la web, pero solo una ruta que ya este en la lista (comparacion exacta). */
  private quitarCarpeta(ws: WebSocket, msg: Record<string, unknown>): void {
    const cambiar = this.o.cambiarCarpeta;
    if (!cambiar) return this.enviar(ws, { tipo: "error", codigo: "no_disponible", mensaje: "Este motor no puede cambiar carpetas desde la web." });
    const ruta = msg.ruta;
    if (typeof ruta !== "string" || !this.o.config().carpetas_permitidas.includes(ruta)) {
      return this.enviar(ws, { tipo: "error", codigo: "carpeta_desconocida", mensaje: "Esa carpeta no esta en la lista de carpetas permitidas." });
    }
    try {
      const carpetas = cambiar(ruta, "quitar");
      this.o.log.info("carpeta quitada desde la web");
      this.enviar(ws, { tipo: "carpetas", carpetas, quitada: ruta });
    } catch (e) {
      this.enviar(ws, { tipo: "error", codigo: "carpeta_invalida", mensaje: e instanceof Error ? e.message : String(e) });
    }
  }

  private log(msg: string, id: string): void {
    this.o.log.info(msg, { id });
  }

  private emparejar(ws: WebSocket, msg: Record<string, unknown>): void {
    const r = this.o.emparejamiento.intentar(msg.codigo);
    if (r.ok) {
      this.o.log.info("emparejamiento exitoso");
      return this.enviar(ws, { tipo: "emparejado", token: r.token });
    }
    const textos: Record<string, string> = {
      codigo_incorrecto: "El codigo no es correcto.",
      codigo_expirado: "El codigo vencio. Reinicia el motor o escribe 'nuevo' en su consola para generar otro.",
      codigo_usado: "Ese codigo ya se uso. Genera uno nuevo en la consola del motor.",
      demasiados_intentos: "Demasiados intentos. Genera un codigo nuevo en la consola del motor.",
    };
    this.o.log.error("emparejamiento rechazado", { motivo: r.motivo });
    this.enviar(ws, { tipo: "error", codigo: r.motivo, mensaje: textos[r.motivo] ?? "No se pudo emparejar." });
  }

  private iniciarTarea(ws: WebSocket, msg: Record<string, unknown>): void {
    const id = typeof msg.id === "string" && msg.id ? msg.id : undefined;
    const prompt = msg.prompt;
    if (!id || typeof prompt !== "string" || prompt.trim() === "") {
      return this.enviar(ws, { tipo: "error", id, codigo: "mensaje_invalido", mensaje: "La tarea necesita id y prompt." });
    }
    const sistema = msg.sistema;
    if (sistema !== undefined && (typeof sistema !== "string" || sistema.length > MAX_SISTEMA)) {
      return this.enviar(ws, { tipo: "error", id, codigo: "mensaje_invalido", mensaje: "El rol del agente (sistema) no es valido o es muy largo." });
    }
    const continuar = msg.continuar;
    if (continuar !== undefined && (typeof continuar !== "string" || !SESION_VALIDA.test(continuar))) {
      return this.enviar(ws, { tipo: "error", id, codigo: "mensaje_invalido", mensaje: "El id de sesion para continuar no es valido." });
    }
    const cfg = this.o.config();
    if (cfg.carpetas_permitidas.length === 0) {
      return this.enviar(ws, {
        tipo: "error",
        id,
        codigo: "sin_carpetas",
        mensaje: "No hay carpetas permitidas. Agrega al menos una en carpetas_permitidas de motor.json y reinicia el motor.",
      });
    }
    if (this.tarea) {
      return this.enviar(ws, { tipo: "error", id, codigo: "ocupado", mensaje: "El motor ya esta trabajando en otra tarea." });
    }
    const pedida = typeof msg.carpeta === "string" && msg.carpeta !== "" ? msg.carpeta : (cfg.carpetas_permitidas[0] as string);
    if (!rutaPermitida(pedida, cfg.carpetas_permitidas)) {
      this.o.log.error("carpeta fuera de lo permitido", { id });
      return this.enviar(ws, { tipo: "error", id, codigo: "carpeta_no_permitida", mensaje: "Esa carpeta no esta en las carpetas permitidas." });
    }
    const carpeta = resolverReal(pedida);
    const abort = new AbortController();
    this.tarea = { id, ws, abort };
    this.o.log.info("tarea recibida", { id, largo_prompt: prompt.length });

    const emitir = (ev: Evento): void => this.enviar(ws, ev);
    const pedirPermiso = (p: { herramienta: string; resumen: string }): Promise<boolean> =>
      this.permisos.pedir(
        (ped) => emitir({ tipo: "permiso", id: ped.id, tarea: id, herramienta: ped.herramienta, resumen: ped.resumen }),
        p,
        abort.signal,
      );

    void this.o.ejecutor
      .ejecutar({
        id,
        prompt,
        carpeta,
        sistema: typeof sistema === "string" && sistema.trim() !== "" ? sistema : undefined,
        continuar: typeof continuar === "string" ? continuar : undefined,
        signal: abort.signal,
        emitir,
        pedirPermiso,
      })
      .catch((e: unknown) => {
        this.o.log.error("fallo del ejecutor", { id, error: e instanceof Error ? e.message : String(e) });
        emitir({ tipo: "error", id, codigo: "fallo_interno", mensaje: "El motor fallo al ejecutar la tarea." });
      })
      .finally(() => {
        if (abort.signal.aborted) {
          emitir({ tipo: "estado", id, estado: "libre" });
          emitir({ tipo: "error", id, codigo: "cancelada", mensaje: "La tarea se cancelo." });
        }
        this.tarea = null;
      });
  }
}

/** Defensa contra DNS rebinding: el Host debe ser el bucle local. */
export function hostLocalValido(host: string | undefined): boolean {
  if (!host) return false;
  const nombre = host.replace(/:\d+$/, "").toLowerCase();
  return nombre === "127.0.0.1" || nombre === "localhost" || nombre === "[::1]";
}
