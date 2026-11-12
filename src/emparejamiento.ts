import crypto from "node:crypto";

export const CODIGO_EXPIRA_MS = 5 * 60 * 1000;
export const MAX_INTENTOS = 5;

export type ResultadoEmparejar =
  | { ok: true; token: string }
  | { ok: false; motivo: "codigo_incorrecto" | "codigo_expirado" | "codigo_usado" | "demasiados_intentos" };

function iguales(a: string, b: string): boolean {
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/**
 * Codigo de 6 digitos de un solo uso, con expiracion y limite de intentos. Al acertar se
 * entrega un token de sesion aleatorio (el "secreto por sesion"); sin el, todo se rechaza.
 */
export class Emparejamiento {
  private codigo = "";
  private expira = 0;
  private intentos = 0;
  private usado = true;
  private tokens = new Set<string>();

  constructor(private ahora: () => number = Date.now) {
    this.nuevoCodigo();
  }

  nuevoCodigo(): string {
    this.codigo = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
    this.expira = this.ahora() + CODIGO_EXPIRA_MS;
    this.intentos = 0;
    this.usado = false;
    return this.codigo;
  }

  get codigoActual(): string {
    return this.codigo;
  }

  intentar(candidato: unknown): ResultadoEmparejar {
    if (this.usado) return { ok: false, motivo: "codigo_usado" };
    if (this.ahora() > this.expira) return { ok: false, motivo: "codigo_expirado" };
    if (this.intentos >= MAX_INTENTOS) return { ok: false, motivo: "demasiados_intentos" };
    this.intentos++;
    if (typeof candidato !== "string" || !/^\d{6}$/.test(candidato) || !iguales(candidato, this.codigo)) {
      if (this.intentos >= MAX_INTENTOS) return { ok: false, motivo: "demasiados_intentos" };
      return { ok: false, motivo: "codigo_incorrecto" };
    }
    this.usado = true;
    const token = crypto.randomBytes(32).toString("hex");
    this.tokens.add(token);
    return { ok: true, token };
  }

  tokenValido(token: unknown): boolean {
    if (typeof token !== "string" || token.length !== 64) return false;
    for (const t of this.tokens) if (iguales(t, token)) return true;
    return false;
  }

  revocarTodos(): void {
    this.tokens.clear();
  }
}
