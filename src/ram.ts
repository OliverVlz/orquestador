/**
 * Tope de RAM de toda la máquina (no solo de los agentes): el equipo no debe pasar de `ORQ_RAM_MAX_GB` (11 por
 * defecto) ni empezar a usar swap. Antes de lanzar un worker se espera a que quepa; el vigía
 * (`orq.ts vigia-ram`) apaga el worker de menor prioridad si el uso se pasa del tope.
 */
import { execFileSync } from 'node:child_process';
import { freemem, totalmem } from 'node:os';

import { log } from './util.ts';

export const RAM_MAX_GB = Number(process.env.ORQ_RAM_MAX_GB ?? 11);
/** Lo que suma un worker nuevo en su pico (pruebas, lint y compilación). */
export const MARGEN_WORKER_GB = Number(process.env.ORQ_RAM_MARGEN_GB ?? 2);

const GB = 1024 ** 3;

/** GB realmente en uso (todo menos la memoria que el sistema devuelve al instante). */
export function memoriaUsadaGb(): number {
  const total = totalmem() / GB;
  if (process.platform === 'darwin') {
    try {
      const salida = execFileSync('memory_pressure', [], { encoding: 'utf8' });
      const libre = Number(/free percentage:\s*(\d+)%/.exec(salida)?.[1]);
      if (Number.isFinite(libre)) return Math.round(total * (1 - libre / 100) * 10) / 10;
    } catch {
      /* sin memory_pressure: se usa os.freemem */
    }
  }
  return Math.round((total - freemem() / GB) * 10) / 10;
}

/** GB de swap en uso (macOS: `vm.swapusage`); 0 si no se puede leer. */
export function swapUsadoGb(): number {
  if (process.platform !== 'darwin') return 0;
  try {
    const salida = execFileSync('sysctl', ['-n', 'vm.swapusage'], { encoding: 'utf8' });
    const m = /used = ([\d.]+)([MG])/.exec(salida);
    if (!m) return 0;
    return m[2] === 'G' ? Number(m[1]) : Number(m[1]) / 1024;
  } catch {
    return 0;
  }
}

export const cabeUnWorker = (): boolean => memoriaUsadaGb() + MARGEN_WORKER_GB <= RAM_MAX_GB;

/** Bloquea (con avisos) hasta que quepa un worker más bajo el tope de RAM. */
export function esperarMemoria(): void {
  let espera = 0;
  while (!cabeUnWorker()) {
    if (espera % 6 === 0) log(`RAM: ${memoriaUsadaGb()} GB en uso de ${RAM_MAX_GB} GB permitidos; espero a que quepa otro worker…`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20_000);
    espera++;
  }
}
