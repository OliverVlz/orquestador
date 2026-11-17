/**
 * Lanzar un motor: resolver su binario, correrlo en la carpeta del ticket con la salida a disco y
 * clasificar el final (terminó, sin cuota, corte de red). Común a todos los motores.
 */
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { entornoLimpio, resolverBinario, type Binario } from '../util.ts';
import { MOTORES } from './registro.ts';
import type { Motor, Trabajo } from './tipos.ts';

/** Avisos de cuota o límite de uso. Solo se buscan donde el motor informa errores (ver clasificar). */
const SIN_CUOTA =
  /usage limit|insufficient_quota|quota exceeded|exceeded your current quota|resource_exhausted|too many requests|purchase more credits|out of credits|individual quota reached|rate limit reached/i;
const CORTE_RED = /"retryable":true|network issue|unexpected EOF|ECONNRESET|ETIMEDOUT|socket hang up/i;

export function motorPorNombre(nombre: string): Motor {
  const motor = MOTORES[nombre];
  if (!motor) throw new Error(`Motor desconocido: ${nombre} (conocidos: ${Object.keys(MOTORES).join(', ')})`);
  return motor;
}

export function binarioDe(motor: Motor): Binario | null {
  if (motor.manual) return { command: motor.binario, prefix: [] };
  const override = motor.envBinario ? process.env[motor.envBinario] : undefined;
  if (override) return existsSync(override) ? { command: override, prefix: [] } : null;
  return resolverBinario(motor.binario);
}

/**
 * ¿La CLI del motor tiene sesión iniciada? null si el motor no sabe decirlo (o es manual). Corre con el
 * entorno de los workers, así que refleja lo que verá `trabajar`, no lo que ve esta terminal.
 */
export function sesionIniciada(motor: Motor): boolean | null {
  const bin = binarioDe(motor);
  if (!bin || motor.manual || !motor.sesion) return null;
  const result = spawnSync(bin.command, [...bin.prefix, ...motor.sesion.args], {
    encoding: 'utf8',
    env: entornoLimpio(),
    windowsHide: true,
    timeout: 30_000,
  });
  if (result.error) return null;
  return result.status === 0 && motor.sesion.ok.test(`${result.stdout ?? ''}\n${result.stderr ?? ''}`);
}

export type Final = {
  code: number;
  /** El motor avisó que no tiene cuota: hay que pasar al siguiente de la cadena. */
  sinCuota: boolean;
  /** Se cortó la conexión: se puede relanzar sobre la misma carpeta. */
  corteRed: boolean;
  stdoutFile: string;
  stderrFile: string;
};

/**
 * Clasifica el final. La salida estándar puede contener código o texto con «429» o «rate limit» sin
 * que falte cuota, así que solo se mira el stderr y, si el motor falló, el final de su salida.
 */
export function clasificar(motor: Motor, code: number, stdout: string, stderr: string): Pick<Final, 'sinCuota' | 'corteRed'> {
  const tail = code === 0 ? '' : stdout.slice(-4000);
  const patrones = [SIN_CUOTA, motor.sinCuota].filter((p): p is RegExp => Boolean(p));
  const sinCuota = patrones.some((p) => p.test(stderr) || p.test(tail));
  const corteRed = !sinCuota && code !== 0 && (CORTE_RED.test(stderr) || CORTE_RED.test(tail));
  return { sinCuota, corteRed };
}

export function correrMotor(
  motor: Motor,
  trabajo: Trabajo,
  logBase: string,
  { timeoutMin = Number(process.env.ORQ_TIMEOUT_MIN ?? 120) } = {},
): Final {
  const bin = binarioDe(motor);
  const stdoutFile = `${logBase}.out.log`;
  const stderrFile = `${logBase}.err.log`;
  if (!bin) {
    writeFileSync(stderrFile, `No se encontró "${motor.binario}" en el PATH${motor.envBinario ? ` ni en ${motor.envBinario}` : ''}.\n`);
    return { code: 127, sinCuota: false, corteRed: false, stdoutFile, stderrFile };
  }
  writeFileSync(trabajo.promptFile, trabajo.prompt);
  const input = motor.stdin(trabajo);
  const out = openSync(stdoutFile, 'w');
  const err = openSync(stderrFile, 'w');
  let code: number;
  try {
    const result = spawnSync(bin.command, [...bin.prefix, ...motor.args(trabajo)], {
      cwd: trabajo.cwd,
      input: input ?? '',
      stdio: ['pipe', out, err],
      env: entornoLimpio(),
      windowsHide: true,
      timeout: timeoutMin * 60_000,
    });
    code = result.error ? 1 : (result.status ?? 1);
    if (result.error) writeFileSync(stderrFile, `\n${result.error.message}\n`, { flag: 'a' });
  } finally {
    closeSync(out);
    closeSync(err);
  }
  const read = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8') : '');
  return { code, ...clasificar(motor, code, read(stdoutFile), read(stderrFile)), stdoutFile, stderrFile };
}
