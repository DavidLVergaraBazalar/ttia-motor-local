/** Tipos del protocolo web <-> motor. Documentado en docs/protocolo-motor.md. */

export type EstadoAgente = "trabajando" | "necesita_humano" | "entregable_listo" | "libre";

export interface UsoTokens {
  entrada: number;
  salida: number;
  cache_lectura: number;
  cache_escritura: number;
  costo_usd: number | null;
}

// Mensajes entrantes (web -> motor)
export interface MsgEmparejar {
  tipo: "emparejar";
  codigo: string;
}
export interface MsgTarea {
  tipo: "tarea";
  token: string;
  id: string;
  prompt: string;
  carpeta?: string;
  /** Rol del agente (md_base + skills) que arma la nube para su dueno. Se agrega al prompt de sistema del motor. */
  sistema?: string;
  /** Id de sesion del SDK (vino en `fin.sesion`) para continuar la misma conversacion. */
  continuar?: string;
}
export interface MsgRespuestaPermiso {
  tipo: "respuesta_permiso";
  token: string;
  id: string;
  aprobado: boolean;
}
export interface MsgCancelar {
  tipo: "cancelar";
  token: string;
  id?: string;
}
export interface MsgInfo {
  tipo: "info";
  token: string;
}

// Eventos salientes (motor -> web)
export type Evento =
  | { tipo: "emparejado"; token: string }
  | {
      tipo: "info";
      version: string;
      simulado: boolean;
      modelo: string;
      hay_clave: boolean;
      hay_workspace: boolean;
      carpetas: string[];
      ocupado: boolean;
    }
  | { tipo: "estado"; id?: string; estado: EstadoAgente }
  | { tipo: "texto"; id: string; delta: string }
  | { tipo: "herramienta"; id: string; nombre: string; objetivo: string; solo_lectura: boolean }
  | { tipo: "permiso"; id: string; tarea: string; herramienta: string; resumen: string }
  | { tipo: "fin"; id: string; exito: boolean; uso: UsoTokens; sesion: string | null; resultado: string | null }
  | { tipo: "error"; id?: string; codigo: string; mensaje: string };

/** Lo que un ejecutor (real o simulado) recibe para trabajar una tarea. */
export interface ContextoTarea {
  id: string;
  prompt: string;
  carpeta: string;
  sistema?: string;
  continuar?: string;
  signal: AbortSignal;
  emitir(ev: Evento): void;
  /** Pide permiso a la web. true = aprobado. Timeout o cancelacion = false. */
  pedirPermiso(p: { herramienta: string; resumen: string }): Promise<boolean>;
}

export interface Ejecutor {
  ejecutar(ctx: ContextoTarea): Promise<void>;
}
