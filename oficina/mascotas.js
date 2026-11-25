'use strict';
/* Oficina · mascotas NPC. Solo visual: nada de esto toca el flujo del orquestador. Hasta 3 a la vez; se guardan en
   progress/oficina/mascotas.json (vía el servidor) para que sobrevivan al reinicio. Cada una tiene su casa, una
   máquina de estados con algo de azar, hambre (se resetea al alimentarla), sueño y cariño (sube al acariciarla). */

const MASC_TIPOS = {
  perro: { nombre: 'Perro', icono: '🐕', casa: 'casita', vel: 44 },
  gato: { nombre: 'Gato', icono: '🐈', casa: 'rascador', vel: 30 },
  iguana: { nombre: 'Iguana', icono: '🦎', casa: 'terrario', vel: 5 },
  pecera: { nombre: 'Peces', icono: '🐠', casa: 'pecera', vel: 0 },
  loro: { nombre: 'Loro', icono: '🦜', casa: 'jaula', vel: 60 },
  hamster: { nombre: 'Hámster', icono: '🐹', casa: 'jaula con rueda', vel: 24 },
  tortuga: { nombre: 'Tortuga', icono: '🐢', casa: 'estanque', vel: 3 },
  conejo: { nombre: 'Conejo', icono: '🐇', casa: 'conejera', vel: 34 },
};
const MASC_CASAS = [{ x: 46, y: 262 }, { x: 228, y: 266 }, { x: 404, y: 266 }, { x: 498, y: 262 }];
const MASC_HAMBRE_MS = 3 * 3600_000; // de llena a hambrienta en 3 h
const MASC_CARINO_MS = 2 * 3600_000;
const CORAZON = ['01010', '11111', '11111', '01110', '00100'];
const NOTA = ['0110', '0101', '0100', '1100', '1100'];
const azar = (a, b) => a + Math.random() * (b - a);
const unoDe = (lista) => lista[Math.floor(Math.random() * lista.length)];
const pesoAzar = (opciones) => {
  const total = opciones.reduce((s, o) => s + o[1], 0);
  let r = Math.random() * total;
  for (const [valor, peso] of opciones) if ((r -= peso) <= 0) return valor;
  return opciones[0][0];
};
const sueloAzar = () => {
  const p = { x: azar(14, 626), y: azar(228, 264) };
  if (p.x > 546 && p.y < 248) p.y = azar(250, 264); // el sofá y su alfombra
  return p;
};
const esDeDia = () => cielo().fase === 'dia';

/** Rectángulo relativo a la mascota, espejado según hacia dónde mira. */
function SR(m, dx, dy, w, h, c) { R(m.dir > 0 ? m.x + dx : m.x - dx - w, m.y + dy, w, h, c); }

/* =========================================================== estado */
const mascotasVivas = []; // { id, tipo, nombre, casa, x, y, dir, estado, hasta, ruta, vel, sueno, comio, acariciada, … }
let ahoraMs = 0;
const tazaTumbada = { hasta: 0 };
const pelota = { activa: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, enBoca: false };

function casaLibre() {
  const ocupadas = new Set(mascotasVivas.map((m) => m.casaIdx));
  return MASC_CASAS.findIndex((_, i) => !ocupadas.has(i));
}
function crearMascota(d) {
  const idx = casaLibre();
  const casa = MASC_CASAS[Math.max(0, idx)];
  const m = {
    id: d.id, tipo: d.tipo, nombre: d.nombre, casaIdx: Math.max(0, idx), casa,
    x: casa.x + 14, y: casa.y - 2, dir: 1, estado: 'casa', hasta: ahoraMs + azar(2000, 6000), ruta: [], alLlegar: null,
    vel: MASC_TIPOS[d.tipo].vel, sueno: azar(10, 50), comio: Date.parse(d.comio), acariciada: Date.parse(d.acariciada),
    corazones: 0, globo: null, extra: {}, anim: Math.random() * 1000,
  };
  if (m.tipo === 'pecera') { m.x = casa.x; m.y = casa.y; }
  if (m.tipo === 'loro') { m.x = casa.x; m.y = casa.y - 36; m.estado = 'jaula'; }
  if (m.tipo === 'hamster') { m.estado = 'rueda'; }
  return m;
}
const hambreDe = (m) => Math.max(0, Math.min(100, ((Date.now() - m.comio) / MASC_HAMBRE_MS) * 100));
const carinoDe = (m) => Math.max(0, Math.min(100, 100 - ((Date.now() - m.acariciada) / MASC_CARINO_MS) * 100));

/* =========================================================== movimiento */
function irPor(m, puntos, estado, alLlegar) {
  m.ruta = puntos.map((p) => ({ x: p.x, y: p.y }));
  m.estado = estado;
  m.alLlegar = alLlegar ?? null;
}
function avanzarMascota(m, dt, vel) {
  let paso = vel * dt;
  while (paso > 0 && m.ruta.length) {
    const p = m.ruta[0];
    const dx = p.x - m.x, dy = p.y - m.y;
    const d = Math.hypot(dx, dy);
    if (Math.abs(dx) > 0.5) m.dir = dx > 0 ? 1 : -1;
    if (d <= paso) { m.x = p.x; m.y = p.y; paso -= d; m.ruta.shift(); }
    else { m.x += (dx / d) * paso; m.y += (dy / d) * paso; paso = 0; }
  }
  if (!m.ruta.length && m.alLlegar) { const f = m.alLlegar; m.alLlegar = null; f(m); }
}
const puertaCasa = (m) => ({ x: m.casa.x + (m.tipo === 'perro' ? 0 : 14), y: Math.min(m.casa.y - 1, 264) });
const quedarse = (m, estado, segundos) => { m.estado = estado; m.ruta = []; m.hasta = ahoraMs + segundos * 1000; };

/** Junto a un agente (para visitarlo, ladrarle o celebrar con él). */
function junto(i) {
  const a = agentes[i];
  if (!a) return sueloAzar();
  if (a.pose === 'escritorio') return { x: ESCRITORIOS[i] + 15, y: 228 };
  if (a.pose === 'sofa') return { x: SOFA[a.destino.k].x, y: 248 };
  return { x: a.x + 12, y: Math.max(228, a.y) };
}

/* =========================================================== personalidades */
function decidir(m) {
  const hambre = hambreDe(m);
  // La iguana en la ventana baja por la pared antes de nada (no atraviesa la pared).
  if (m.tipo === 'iguana' && m.estado === 'sol-ventana') return decidirIguana(m);
  // Necesidades primero.
  if (m.tipo !== 'pecera' && m.tipo !== 'loro' && m.tipo !== 'hamster') {
    if (hambre > 75 && m.estado !== 'hambre') return irPor(m, [puertaCasa(m)], 'camina', () => quedarse(m, 'hambre', 30));
    if (m.sueno > 90) return irPor(m, [puertaCasa(m)], 'camina', () => quedarse(m, 'dormir', azar(45, 90)));
  }
  ({ perro: decidirPerro, gato: decidirGato, iguana: decidirIguana, pecera: decidirPecera, loro: decidirLoro,
    hamster: decidirHamster, tortuga: decidirTortuga, conejo: decidirConejo })[m.tipo](m);
}

function decidirPerro(m) {
  const colgado = agentes.findIndex((a) => a.dato?.colgado || a.dato?.atascado);
  if (colgado >= 0 && Math.random() < 0.45) {
    const p = junto(colgado);
    return irPor(m, [p], 'corre', () => { m.dir = ESCRITORIOS[colgado] > m.x ? 1 : -1; quedarse(m, 'ladra', 6); m.extra.a = colgado; });
  }
  const que = pesoAzar([['pasear', 3], ['pelota', 2], ['visitar', 2], ['echarse', 1]]);
  if (que === 'pelota') {
    const i = Math.floor(Math.random() * agentes.length);
    const desde = junto(i);
    const destino = sueloAzar();
    Object.assign(pelota, { activa: true, enBoca: false, x: desde.x, y: desde.y, z: 14, vx: (destino.x - desde.x) / 1.1, vy: (destino.y - desde.y) / 1.1, vz: 40 });
    m.extra.lanzador = i;
    return quedarse(m, 'espera-pelota', 0.4);
  }
  if (que === 'visitar') {
    const i = Math.floor(Math.random() * agentes.length);
    return irPor(m, [junto(i)], 'camina', () => quedarse(m, 'cola', azar(3, 6)));
  }
  if (que === 'echarse') return irPor(m, [sueloAzar()], 'camina', () => quedarse(m, 'echado', azar(15, 35)));
  return irPor(m, [sueloAzar()], 'camina', () => quedarse(m, 'sentado', azar(2, 6)));
}

function decidirGato(m) {
  const enPausa = agentes.filter((a) => a.dato && !alEscritorio(a.dato) && ['detenido', 'libre'].includes(a.dato.modo));
  const vacios = agentes.filter((a) => !(a.pose === 'escritorio' && alEscritorio(a.dato)));
  const opciones = [['pasear', 2], ['lamerse', 1.5], ['sol', 2.5]];
  if (enPausa.length || vacios.length) opciones.push(['teclado', 3]);
  if (tazaTumbada.hasta < Date.now()) opciones.push(['taza', 1]);
  const que = pesoAzar(opciones);
  if (que === 'teclado') {
    const a = unoDe(enPausa.length ? enPausa : vacios);
    const cx = ESCRITORIOS[a.i];
    return irPor(m, [{ x: cx + 6, y: 226 }], 'camina', () => {
      m.extra.desde = { x: m.x, y: m.y };
      irPor(m, [{ x: cx + 1, y: 168 }], 'salta', () => { m.extra.escritorio = a.i; quedarse(m, 'teclado', azar(50, 140)); });
    });
  }
  if (que === 'taza') {
    const cx = ESCRITORIOS[1];
    return irPor(m, [{ x: cx + 30, y: 226 }], 'camina', () => irPor(m, [{ x: cx + 14, y: 168 }], 'salta', () => { m.dir = 1; quedarse(m, 'manotazo', 2.2); }));
  }
  if (que === 'sol') {
    const p = esDeDia() ? { x: azar(40, 96), y: azar(224, 236) } : { x: azar(20, 120), y: azar(232, 256) };
    return irPor(m, [p], 'camina', () => quedarse(m, 'acurrucado', azar(40, 100)));
  }
  if (que === 'lamerse') return quedarse(m, 'lamerse', azar(5, 10));
  return irPor(m, [sueloAzar()], 'camina', () => quedarse(m, 'sentado', azar(3, 8)));
}

function decidirIguana(m) {
  if (m.estado === 'sol-ventana') {
    // Baja por la pared y vuelve a su terrario.
    return irPor(m, [{ x: 28, y: 121 }, { x: 28, y: 226 }, puertaCasa(m)], 'trepa', () => quedarse(m, 'casa', azar(90, 240)));
  }
  if (Math.random() < 0.7) {
    // Al sol de la ventana del jefe: cruza el piso, trepa la pared y se echa en el alféizar.
    return irPor(m, [{ x: 28, y: 228 }, { x: 28, y: 121 }, { x: azar(44, 98), y: 121 }], 'trepa', () => quedarse(m, 'sol-ventana', azar(180, 480)));
  }
  return quedarse(m, 'casa', azar(60, 180));
}

function decidirPecera(m) { quedarse(m, 'nadan', azar(5, 10)); }

function decidirLoro(m) {
  if (m.estado === 'percha-fuera') return irPor(m, [{ x: m.casa.x, y: m.casa.y - 36 }], 'vuela', () => quedarse(m, 'jaula', azar(20, 60)));
  const que = pesoAzar([['jaula', 4], ['cantar', 2], ['volar', 1.2]]);
  if (que === 'volar') {
    const destinos = [{ x: 41, y: 145 }, { x: 103, y: 145 }, ...ESCRITORIOS.map((cx) => ({ x: cx, y: 140 }))];
    const d = unoDe(destinos);
    return irPor(m, [{ x: m.x, y: m.y - 20 }, { x: d.x, y: d.y - 18 }, d], 'vuela', () => quedarse(m, 'percha-fuera', azar(25, 60)));
  }
  // Lo que dice por un dictamen manda: no lo tapa con su repertorio.
  if (que === 'cantar' && !m.globo) { m.globo = { texto: unoDe(['♪ ♫', '¡Tinto!', '¡Hola!', '¡Lorenzo lindo!', '♪ fiu fiu']), hasta: ahoraMs + 3500 }; return quedarse(m, 'jaula', 4); }
  return quedarse(m, 'jaula', azar(6, 14));
}

function decidirHamster(m) {
  if (m.estado === 'bola') return irPor(m, [puertaCasa(m)], 'bola', () => quedarse(m, 'rueda', azar(30, 60)));
  const que = pesoAzar([['rueda', 4], ['dormir-jaula', 2], ['bola', 1]]);
  if (que === 'bola') {
    const p1 = sueloAzar(), p2 = sueloAzar();
    return irPor(m, [puertaCasa(m), p1, p2], 'bola', () => quedarse(m, 'bola', 1));
  }
  return quedarse(m, que, azar(20, 60));
}

function decidirTortuga(m) {
  const p = { x: Math.max(14, Math.min(626, m.x + azar(-40, 40))), y: Math.max(230, Math.min(264, m.y + azar(-10, 10))) };
  if (Math.random() < 0.25) return irPor(m, [puertaCasa(m)], 'camina', () => quedarse(m, 'comer', azar(20, 40)));
  return irPor(m, [p], 'camina', () => quedarse(m, 'quieta', azar(8, 20)));
}

function decidirConejo(m) {
  const que = pesoAzar([['saltar', 4], ['zanahoria', 1.5], ['olfatear', 1.5], ['echado', 1]]);
  if (que === 'zanahoria') return irPor(m, [puertaCasa(m)], 'salta-suelo', () => quedarse(m, 'comer', azar(8, 15)));
  if (que === 'olfatear') return irPor(m, [junto(Math.floor(Math.random() * agentes.length))], 'salta-suelo', () => quedarse(m, 'olfatea', azar(3, 6)));
  if (que === 'echado') return quedarse(m, 'echado', azar(15, 30));
  return irPor(m, [sueloAzar()], 'salta-suelo', () => quedarse(m, 'sentado', azar(2, 5)));
}

/* =========================================================== eventos de la oficina */
function celebrar(i) {
  const perro = mascotasVivas.find((m) => m.tipo === 'perro');
  if (!perro) return;
  const p = i == null ? { x: JEFE_X + 30, y: 240 } : junto(i);
  irPor(perro, [p], 'corre', () => quedarse(perro, 'fiesta', 7));
}
window.addEventListener('oficina:pr-cerrado', (ev) => celebrar(ev.detail?.agente ?? null));

function decirDictamen(resultado) {
  const loro = mascotasVivas.find((m) => m.tipo === 'loro');
  if (!loro) return;
  const texto = resultado === 'APROBADO' ? '¡APROBADO! ¡APROBADO!' : '¡CAMBIOS! ¡CAMBIOS!';
  loro.globo = { texto, hasta: ahoraMs + 5500, fuerte: true };
}

/* =========================================================== tic de cada cuadro */
ganchos.mover.push((dt) => {
  ahoraMs = performance.now();
  for (const m of mascotasVivas) {
    m.anim += dt * 1000;
    const durmiendo = ['dormir', 'dormir-jaula', 'echado', 'acurrucado', 'teclado'].includes(m.estado);
    m.sueno = Math.max(0, Math.min(100, m.sueno + (durmiendo ? -2.2 : 0.012) * dt * 10));
    if (m.corazones > 0) m.corazones -= dt;
    if (m.globo && ahoraMs > m.globo.hasta) m.globo = null;

    // Movimiento según el estado.
    const vel = { corre: m.vel * 1.7, salta: 60, trepa: 4, vuela: m.vel, bola: m.vel * 1.4, 'salta-suelo': m.vel, huye: m.vel * 2 }[m.estado] ?? m.vel;
    if (m.ruta.length) { avanzarMascota(m, dt, vel); continue; }

    // La tortuga se esconde si pasa alguien cerca.
    if (m.tipo === 'tortuga' && m.estado !== 'escondida' && cercaAlguien(m, 22)) quedarse(m, 'escondida', 6);
    // El hámster despierta y corre si lo alimentan.
    if (m.tipo === 'pecera' && cercaAlguien(m, 30)) m.extra.superficie = ahoraMs + 3000;

    if (m.estado === 'espera-pelota' && ahoraMs > m.hasta) {
      // Persigue la pelota donde cae y se la lleva al que la tiró.
      if (pelota.activa && pelota.z <= 0) {
        irPor(m, [{ x: pelota.x - 6, y: pelota.y }], 'corre', () => {
          pelota.enBoca = true;
          irPor(m, [junto(m.extra.lanzador ?? 0)], 'camina', () => { pelota.enBoca = false; pelota.activa = false; quedarse(m, 'cola', 4); });
        });
      }
      continue;
    }
    if (m.estado === 'manotazo' && ahoraMs > m.hasta) {
      tazaTumbada.hasta = Date.now() + 180_000;
      irPor(m, [{ x: ESCRITORIOS[1] + 30, y: 226 }, sueloAzar()], 'huye', () => quedarse(m, 'sentado', 4));
      m.globo = { texto: '¡Ups!', hasta: ahoraMs + 2500 };
      continue;
    }
    if (m.estado === 'teclado' && ahoraMs > m.hasta) {
      const cx = ESCRITORIOS[m.extra.escritorio ?? 0];
      irPor(m, [{ x: cx + 6, y: 226 }], 'salta', () => decidir(m));
      continue;
    }
    if (m.estado === 'hambre' && hambreDe(m) < 30) { decidir(m); continue; }
    if (ahoraMs > m.hasta && m.estado !== 'hambre') decidir(m);
  }
  // La pelota: vuelo con rebote.
  if (pelota.activa && !pelota.enBoca && pelota.z > 0) {
    pelota.x += pelota.vx * dt; pelota.y += pelota.vy * dt;
    pelota.vz -= 120 * dt; pelota.z = Math.max(0, pelota.z + pelota.vz * dt);
  }
});

/** ¿Pasa alguien (un agente caminando, el revisor u otra mascota) cerca? */
function cercaAlguien(m, radio) {
  const caminan = agentes.filter((a) => a.pose === 'camina').map((a) => ({ x: a.x, y: a.y }));
  const otros = mascotasVivas.filter((o) => o !== m && o.ruta.length).map((o) => ({ x: o.x, y: o.y }));
  const revs = revisores.filter((r) => r.estado === 'llega' || r.estado === 'sale').map((r) => ({ x: r.x, y: r.y }));
  return [...caminan, ...otros, ...revs].some((p) => Math.hypot(p.x - m.x, (p.y - m.y) * 1.5) < radio);
}

/* =========================================================== dibujo: casas */
function dibujarCasa(m, t) {
  const { x, y } = m.casa;
  const tipo = m.tipo;
  R(x - 13, y + 1, 26, 2, 'rgba(60,30,10,.22)');
  if (tipo === 'perro') {
    R(x - 10, y - 16, 20, 16, '#c9813f'); R(x - 10, y - 16, 20, 1, '#d99a5a');
    for (let k = 0; k < 7; k++) R(x - 12 + k, y - 17 - k, 24 - 2 * k, 1, k % 2 ? '#a03d32' : '#b5473a');
    R(x - 4, y - 10, 8, 10, '#2b1a10'); R(x - 3, y - 11, 6, 1, '#2b1a10');
    R(x - 4, y - 15, 8, 2, '#f4d58d');
    R(x + 12, y - 2, 7, 2, '#4a90d9'); R(x + 13, y - 3, 5, 1, hambreDe(m) < 50 ? '#8a5a3b' : '#4a90d9');
  } else if (tipo === 'gato') {
    R(x - 9, y - 2, 18, 3, '#c9b08a');
    R(x - 2, y - 28, 4, 26, '#d8c39a');
    for (let k = y - 27; k < y - 2; k += 2) R(x - 2, k, 4, 1, '#b89a6a');
    R(x - 9, y - 31, 18, 3, '#c9b08a'); R(x - 9, y - 31, 18, 1, '#e2cfa6');
    R(x + 3, y - 14, 9, 9, '#c9b08a'); R(x + 5, y - 11, 4, 4, '#3b2414');
    R(x - 7, y - 30, 2, 5, '#d62839'); circulo(x - 6, y - 24, 1, '#ffd166');
    R(x + 11, y - 2, 6, 2, '#e76f51');
  } else if (tipo === 'iguana') {
    R(x - 12, y - 14, 24, 2, '#8a5a3b'); R(x - 11, y - 12, 2, 12, '#6b4630'); R(x + 9, y - 12, 2, 12, '#6b4630');
    R(x - 11, y - 30, 22, 16, 'rgba(200,235,255,.28)');
    R(x - 11, y - 30, 22, 1, '#7a7a7a'); R(x - 11, y - 15, 22, 1, '#7a7a7a'); R(x - 11, y - 30, 1, 16, '#7a7a7a'); R(x + 10, y - 30, 1, 16, '#7a7a7a');
    R(x - 10, y - 19, 20, 4, '#e2c48a'); R(x - 8, y - 23, 14, 1, '#7a4a22'); R(x - 6, y - 25, 1, 2, '#7a4a22');
    R(x - 3, y - 32, 6, 2, '#555'); R(x - 2, y - 30, 4, 1, (Math.floor(t / 900) % 5) ? '#ff9e64' : '#ffb27a');
  } else if (tipo === 'pecera') {
    R(x - 6, y - 12, 12, 2, '#8a5a3b'); R(x - 5, y - 10, 2, 10, '#6b4630'); R(x + 3, y - 10, 2, 10, '#6b4630');
    circulo(x, y - 21, 8, 'rgba(216,241,255,.75)');
    circulo(x, y - 20, 7, '#5fb8e8'); R(x - 7, y - 28, 15, 3, 'rgba(216,241,255,.85)');
    R(x - 5, y - 15, 10, 2, '#c9a15a'); R(x + 3, y - 21, 1, 6, '#3f7f3a'); R(x + 4, y - 19, 1, 4, '#5a9a4a');
    R(x - 5, y - 27, 2, 1, '#ffffff');
  } else if (tipo === 'loro') {
    R(x - 6, y - 2, 12, 2, '#6b4630'); R(x - 1, y - 30, 2, 28, '#8a5a3b');
    const fuera = m.estado === 'vuela' || m.estado === 'percha-fuera';
    for (let k = -9; k <= 9; k += 3) R(x + k, y - 52, 1, 20, '#c9a15a');
    for (let k = 0; k < 4; k++) R(x - 9 + k * 2, y - 53 - k, 19 - k * 4, 1, '#c9a15a');
    R(x - 10, y - 32, 21, 2, '#b8862e'); R(x - 6, y - 38, 12, 1, '#8a5a3b');
    if (fuera) R(x + 6, y - 46, 6, 1, '#c9a15a'); // la puerta abierta
    R(x - 1, y - 56, 2, 2, '#c9a15a');
  } else if (tipo === 'hamster') {
    R(x - 13, y - 2, 26, 3, '#e76f51'); R(x - 13, y - 2, 26, 1, '#f4a261');
    R(x - 12, y - 18, 24, 16, 'rgba(240,240,240,.15)');
    for (let k = -12; k <= 12; k += 2) R(x + k, y - 18, 1, 16, '#cfcfcf');
    R(x - 12, y - 19, 25, 1, '#bfbfbf');
    R(x - 11, y - 5, 12, 3, '#f4d58d');
    // la rueda
    const cx = x + 5, cy = y - 9, rad = 5;
    for (let k = 0; k < 16; k++) { const a = (k / 16) * Math.PI * 2; R(cx + Math.round(Math.cos(a) * rad), cy + Math.round(Math.sin(a) * rad), 1, 1, '#2a9d8f'); }
    const giro = m.estado === 'rueda' ? t / 120 : 0;
    for (let k = 0; k < 3; k++) { const a = giro + (k / 3) * Math.PI; linea(cx, cy, cx + Math.round(Math.cos(a) * 4), cy + Math.round(Math.sin(a) * 4), '#7fc8c0'); }
    R(cx, cy + 1, 1, 5, '#2a9d8f');
  } else if (tipo === 'tortuga') {
    R(x - 13, y - 6, 26, 6, '#8a5a3b'); R(x - 11, y - 5, 22, 3, '#5fb8e8'); R(x - 11, y - 5, 22, 1, '#8fd0f0');
    R(x - 9, y - 7, 4, 2, '#9a9a9a'); R(x + 6, y - 7, 3, 2, '#9a9a9a');
    R(x + 13, y - 3, 5, 3, '#6fb35a'); R(x + 14, y - 4, 3, 1, '#8fd06a');
  } else if (tipo === 'conejo') {
    R(x - 12, y - 16, 24, 16, '#a0663f'); R(x - 14, y - 19, 28, 3, '#7a4426');
    R(x - 9, y - 13, 10, 10, '#d9d4cc');
    for (let k = -9; k < 1; k += 2) R(x + k, y - 13, 1, 10, '#a0663f');
    R(x + 3, y - 11, 7, 11, '#3b2414');
    R(x + 13, y - 2, 6, 2, '#f77f00'); R(x + 18, y - 3, 2, 2, '#3f7f3a');
  }
}

/* =========================================================== dibujo: animales */
function dibujarPerro(m, t) {
  const camina = m.ruta.length > 0;
  const pie = Math.floor(m.anim / (m.estado === 'corre' ? 70 : 110)) % 2;
  const cola = Math.floor(m.anim / (['cola', 'fiesta'].includes(m.estado) ? 90 : 400)) % 2;
  const salto = m.estado === 'fiesta' ? Math.abs(Math.round(Math.sin(m.anim / 140) * 3)) : 0;
  const c1 = '#b5733a', c2 = '#d9a066', c3 = '#7a4a22';
  R(m.x - 7, m.y, 14, 1, 'rgba(60,30,10,.25)');
  const y0 = m.y - salto;
  const mm = { x: m.x, y: y0, dir: m.dir };
  if (m.estado === 'echado' || m.estado === 'dormir') {
    SR(mm, -7, -5, 13, 4, c1); SR(mm, -5, -2, 9, 1, c2); SR(mm, 4, -7, 6, 4, c1); SR(mm, 9, -5, 2, 2, c2);
    SR(mm, 4, -8, 2, 3, c3); SR(mm, 7, -6, 2, 1, '#3b2414'); SR(mm, -9, -3, 3, 1, c1);
    if (m.estado === 'dormir' || m.estado === 'echado') zetas(m.x + m.dir * 6, y0 - 10, t, 3);
    return;
  }
  const sentado = ['sentado', 'cola', 'ladra', 'fiesta', 'hambre', 'espera-pelota'].includes(m.estado) && !camina;
  if (sentado) {
    SR(mm, -5, -9, 10, 6, c1); SR(mm, -6, -4, 6, 4, c1); SR(mm, 2, -4, 2, 4, c2); SR(mm, 4, -4, 2, 4, c2);
    SR(mm, -9 - cola, -2 - cola, 4, 2, c1);
  } else {
    SR(mm, -6, -3, 2, 3 - (camina && pie ? 1 : 0), c3); SR(mm, -3, -3, 2, 3 - (camina && !pie ? 1 : 0), c1);
    SR(mm, 2, -3, 2, 3 - (camina && !pie ? 1 : 0), c3); SR(mm, 4, -3, 2, 3 - (camina && pie ? 1 : 0), c1);
    SR(mm, -7, -8, 13, 5, c1); SR(mm, -5, -4, 9, 1, c2);
    SR(mm, -9, -10 + cola, 2, 3, c1);
  }
  const hy = sentado ? -14 : -12;
  SR(mm, 3, hy, 6, 5, c1); SR(mm, 8, hy + 2, 3, 2, c2); SR(mm, 10, hy + 2, 1, 1, '#222');
  SR(mm, 6, hy + 1, 1, 1, '#222'); SR(mm, 3, hy - 1, 2, 4, c3); SR(mm, 3, hy + 5, 3, 1, '#d62839');
  if (m.estado === 'ladra' && Math.floor(m.anim / 300) % 2) SR(mm, 9, hy + 4, 2, 1, '#8c3b25');
  if (pelota.enBoca) SR(mm, 10, hy + 3, 3, 3, '#e9f542');
}
function dibujarGato(m, t) {
  const c1 = '#e08a3c', c2 = '#b0602a', c3 = '#f4c08a';
  const camina = m.ruta.length > 0;
  const pie = Math.floor(m.anim / 120) % 2;
  if (!['salta', 'teclado', 'manotazo'].includes(m.estado) || m.y > 200) R(m.x - 6, m.y, 12, 1, 'rgba(60,30,10,.22)');
  const mm = { x: m.x, y: m.y, dir: m.dir };
  if (['acurrucado', 'teclado', 'dormir'].includes(m.estado)) {
    SR(mm, -5, -4, 10, 4, c1); SR(mm, -4, -5, 8, 1, c1); SR(mm, -2, -5, 1, 3, c2); SR(mm, 1, -5, 1, 3, c2);
    SR(mm, 3, -6, 4, 3, c1); SR(mm, 3, -7, 1, 1, c1); SR(mm, 6, -7, 1, 1, c1); SR(mm, 4, -5, 2, 1, c2);
    SR(mm, -6, -1, 10, 1, c2);
    zetas(m.x + m.dir * 4, m.y - 9, t, 5);
    return;
  }
  if (['sentado', 'lamerse', 'manotazo', 'hambre'].includes(m.estado) && !camina) {
    SR(mm, -3, -9, 6, 7, c1); SR(mm, -1, -8, 1, 5, c2); SR(mm, -4, -2, 8, 2, c1);
    SR(mm, -2, -13, 5, 4, c1); SR(mm, -2, -14, 1, 1, c1); SR(mm, 2, -14, 1, 1, c1); SR(mm, 1, -12, 1, 1, '#3fb950');
    const cola = Math.floor(m.anim / 500) % 2;
    SR(mm, -6, -3 - cola, 3, 1, c1); SR(mm, -6, -5 - cola, 1, 2, c1);
    if (m.estado === 'lamerse') SR(mm, 2, -11 + (Math.floor(m.anim / 250) % 2), 2, 2, c3);
    if (m.estado === 'manotazo') SR(mm, 3, -6 - (Math.floor(m.anim / 200) % 2) * 2, 4, 1, c3);
    return;
  }
  SR(mm, -5, -3, 2, 3 - (camina && pie ? 1 : 0), c2); SR(mm, -3, -3, 2, 3 - (camina && !pie ? 1 : 0), c1);
  SR(mm, 2, -3, 2, 3 - (camina && !pie ? 1 : 0), c2); SR(mm, 4, -3, 2, 3 - (camina && pie ? 1 : 0), c1);
  SR(mm, -6, -7, 11, 4, c1); SR(mm, -3, -7, 1, 3, c2); SR(mm, 0, -7, 1, 3, c2); SR(mm, -4, -4, 7, 1, c3);
  SR(mm, 4, -10, 5, 4, c1); SR(mm, 4, -11, 1, 1, c1); SR(mm, 7, -11, 1, 1, c1); SR(mm, 7, -9, 1, 1, '#3fb950'); SR(mm, 9, -8, 1, 1, '#f08080');
  const cola = Math.floor(m.anim / 350) % 2;
  SR(mm, -7, -11 + cola, 1, 5, c1); SR(mm, -8, -12 + cola, 1, 2, c1);
}
function dibujarIguana(m, t) {
  const c1 = '#5aa84a', c2 = '#3d7a32', c3 = '#2f5e27';
  const mm = { x: m.x, y: m.y, dir: m.dir };
  if (m.estado === 'trepa' && Math.abs(m.x - 28) < 1 && m.y < 226 && m.y > 121) {
    // Trepando por la pared: de cabeza hacia arriba o abajo.
    const arriba = m.ruta[0] ? m.ruta[0].y < m.y : true;
    const s = arriba ? -1 : 1;
    const p = Math.floor(m.anim / 300) % 2;
    R(m.x - 1, m.y + s * 6, 3, 3, c1); R(m.x - 2, m.y - 2, 4, 6, c1); R(m.x - 1, m.y - 2, 1, 6, c3);
    R(m.x - 3, m.y - 1 + p, 1, 1, c2); R(m.x + 2, m.y - p, 1, 1, c2); R(m.x - 3, m.y + 3 - p, 1, 1, c2); R(m.x + 2, m.y + 3 + p, 1, 1, c2);
    R(m.x, m.y - s * 6, 1, 7, c2);
    return;
  }
  const bob = m.estado === 'sol-ventana' && Math.floor(m.anim / 1800) % 4 === 0 ? -1 : 0;
  const p = m.ruta.length ? Math.floor(m.anim / 300) % 2 : 0;
  SR(mm, -4, -4, 9, 3, c1); SR(mm, -3, -2, 7, 1, '#8fd06a');
  for (let k = -3; k < 5; k += 2) SR(mm, k, -5, 1, 1, c3);
  SR(mm, 5, -5 + bob, 4, 3, c1); SR(mm, 7, -5 + bob, 1, 1, '#111'); SR(mm, 6, -2 + bob, 2, 1, '#e0c040');
  SR(mm, -3, -1, 1, 1 + p, c2); SR(mm, 3, -1, 1, 2 - p, c2);
  SR(mm, -11, -3, 7, 1, c2); SR(mm, -15, -2, 4, 1, c3);
}
function dibujarPeces(m, t) {
  const { x, y } = m.casa;
  const arriba = (m.extra.superficie ?? 0) > ahoraMs || (Date.now() - m.comio) < 6000;
  const peces = [{ c: '#ff8c42', f: 0 }, { c: '#ffd166', f: 2.1 }, { c: '#ef476f', f: 4.2 }];
  peces.forEach((p, k) => {
    const fase = t / 900 + p.f;
    const fx = x + Math.round(Math.sin(fase) * 4);
    const fy = arriba ? y - 26 + (k % 2) : y - 22 + Math.round(Math.cos(fase * 0.7 + k) * 2);
    const dir = Math.cos(fase) > 0 ? 1 : -1;
    R(fx - 1, fy, 3, 2, p.c); R(dir > 0 ? fx - 2 : fx + 2, fy, 1, 2, oscuro(p.c));
  });
  for (let k = 0; k < (arriba ? 4 : 2); k++) {
    const pb = (t / 1300 + k / 3) % 1;
    R(x - 3 + k * 2, y - 16 - pb * 10, 1, 1, 'rgba(255,255,255,.8)');
  }
  if ((Date.now() - m.comio) < 6000) for (let k = 0; k < 5; k++) R(x - 4 + k * 2, y - 27 + ((t / 300 + k) % 3), 1, 1, '#c9813f');
}
function dibujarLoro(m, t) {
  const verde = '#3fae4f', oscuroV = '#2d7a3a', rojo = '#e63946';
  const mm = { x: m.x, y: m.y, dir: m.dir };
  if (m.ruta.length) {
    const ala = Math.floor(m.anim / 90) % 2;
    SR(mm, -4, -6, 8, 3, verde); SR(mm, 3, -8, 3, 3, rojo); SR(mm, 6, -7, 1, 1, '#f4c430'); SR(mm, 4, -8, 1, 1, '#111');
    SR(mm, -8, -6, 4, 1, oscuroV); SR(mm, -9, -5, 2, 1, '#3a86ff');
    SR(mm, -2, ala ? -11 : -4, 4, ala ? 5 : 4, oscuroV);
    return;
  }
  const mueve = m.globo ? Math.floor(m.anim / 150) % 2 : 0;
  SR(mm, -2, -8, 4, 6, verde); SR(mm, -2, -11 - mueve, 4, 3, rojo); SR(mm, 2, -10 - mueve, 1, 2, '#f4c430');
  SR(mm, 1, -10 - mueve, 1, 1, '#111'); SR(mm, -2, -7, 2, 4, oscuroV); SR(mm, -1, -2, 2, 5, oscuroV); SR(mm, 0, 2, 1, 2, '#3a86ff');
  SR(mm, -1, -1, 1, 1, '#555'); SR(mm, 1, -1, 1, 1, '#555');
}
function dibujarHamster(m, t) {
  const c = '#e8b26a';
  if (m.estado === 'bola' || (m.ruta.length && m.estado !== 'camina')) {
    circulo(m.x, m.y - 5, 5, 'rgba(200,235,255,.35)');
    R(m.x - 5, m.y - 10, 1, 1, '#ffffff');
    const p = Math.floor(m.anim / 100) % 2;
    R(m.x - 2, m.y - 6 + p, 4, 3, c); R(m.x + 1, m.y - 6 + p, 1, 1, '#3b2414');
    R(m.x - 5, m.y, 10, 1, 'rgba(60,30,10,.2)');
    return;
  }
  const { x, y } = m.casa;
  if (m.estado === 'rueda') {
    const p = Math.floor(t / 80) % 2;
    R(x + 3, y - 8 + p, 4, 3, c); R(x + 6, y - 8 + p, 1, 1, '#3b2414'); R(x + 3, y - 9 + p, 1, 1, '#f4a0a0');
  } else {
    R(x - 8, y - 6, 5, 3, c); R(x - 7, y - 7, 1, 1, '#f4a0a0');
    zetas(x - 4, y - 10, t, 9);
  }
}
function dibujarTortuga(m, t) {
  const mm = { x: m.x, y: m.y, dir: m.dir };
  R(m.x - 5, m.y, 10, 1, 'rgba(60,30,10,.22)');
  const escondida = m.estado === 'escondida';
  const p = m.ruta.length ? Math.floor(m.anim / 600) % 2 : 0;
  if (!escondida) { SR(mm, -4, -2, 2, 2 - p, '#8fbf6a'); SR(mm, 2, -2, 2, 1 + p, '#8fbf6a'); SR(mm, 5, -4, 3, 2, '#8fbf6a'); SR(mm, 7, -4, 1, 1, '#111'); }
  SR(mm, -4, -5, 9, 3, '#5b8c3a'); SR(mm, -3, -6, 7, 1, '#5b8c3a');
  SR(mm, -2, -5, 2, 1, '#3d6b28'); SR(mm, 1, -5, 2, 1, '#3d6b28'); SR(mm, -4, -3, 9, 1, '#c9b06a');
  if (m.estado === 'comer') SR(mm, 8, -3, 2, 2, '#6fb35a');
}
function dibujarConejo(m, t) {
  const salto = m.estado === 'salta-suelo' && m.ruta.length ? Math.abs(Math.round(Math.sin(m.anim / 110) * 4)) : 0;
  R(m.x - 5, m.y, 10, 1, 'rgba(60,30,10,.22)');
  const mm = { x: m.x, y: m.y - salto, dir: m.dir };
  const blanco = '#f2efe9', gris = '#cfc8bd';
  if (m.estado === 'echado' || m.estado === 'dormir') {
    SR(mm, -5, -4, 10, 4, blanco); SR(mm, 3, -6, 4, 3, blanco); SR(mm, 3, -8, 4, 1, gris); SR(mm, -6, -4, 2, 2, '#fff');
    zetas(m.x + 4, m.y - 12, t, 11);
    return;
  }
  SR(mm, -4, -5, 8, 5, blanco); SR(mm, -4, -1, 8, 1, gris); SR(mm, -6, -5, 2, 2, '#ffffff');
  SR(mm, 2, -8, 4, 4, blanco); SR(mm, 4, -7, 1, 1, '#3b2414'); SR(mm, 6, -6, 1, 1, '#f4a0a0');
  const oreja = m.estado === 'olfatea' ? Math.floor(m.anim / 200) % 2 : 0;
  SR(mm, 2, -13 + oreja, 1, 5, blanco); SR(mm, 4, -12, 1, 4, blanco); SR(mm, 2, -12 + oreja, 1, 3, '#f4c0c0');
  if (m.estado === 'comer') SR(mm, 6, -5, 3, 1, '#f77f00');
}
const DIBUJAR = { perro: dibujarPerro, gato: dibujarGato, iguana: dibujarIguana, pecera: dibujarPeces, loro: dibujarLoro, hamster: dibujarHamster, tortuga: dibujarTortuga, conejo: dibujarConejo };

/** Iconos de necesidad (hueso de hambre) y corazones de cariño sobre la mascota. */
function dibujarNecesidades(m, t) {
  const cabeza = m.tipo === 'pecera' ? { x: m.casa.x, y: m.casa.y - 34 } : m.tipo === 'hamster' && m.estado !== 'bola' ? { x: m.casa.x, y: m.casa.y - 24 } : { x: m.x, y: m.y - 18 };
  if (hambreDe(m) > 70) {
    const b = Math.round(Math.sin(t / 300));
    const y = cabeza.y - 3 + b;
    R(cabeza.x - 3, y, 7, 1, '#f5ecd8'); R(cabeza.x - 4, y - 1, 2, 1, '#f5ecd8'); R(cabeza.x - 4, y + 1, 2, 1, '#f5ecd8');
    R(cabeza.x + 3, y - 1, 2, 1, '#f5ecd8'); R(cabeza.x + 3, y + 1, 2, 1, '#f5ecd8');
  }
  if (m.corazones > 0) {
    for (let k = 0; k < 3; k++) {
      const p = ((2.5 - m.corazones) / 2.5 + k * 0.25) % 1;
      X.globalAlpha = 1 - p;
      glifo(CORAZON, cabeza.x - 2 + (k - 1) * 5, cabeza.y - 4 - Math.round(p * 12), '#ef476f');
      X.globalAlpha = 1;
    }
  }
  if (m.tipo === 'loro' && m.globo?.texto?.startsWith('♪')) glifo(NOTA, m.x + 5, m.y - 18 - Math.round(Math.sin(t / 200) * 2), '#fff7e6');
}

/* =========================================================== enganches de dibujo */
ganchos.suelo.push((t) => {
  // Zona soleada bajo la ventana del jefe (de día).
  if (esDeDia()) {
    for (let k = 0; k < 22; k++) {
      const y = 214 + k;
      const x0 = 30 + k * 0.6;
      R(x0, y, 70, 1, `rgba(255,236,170,${0.16 - k * 0.004})`);
    }
  }
  // La taza tumbada por el gato: se tapa la de pie con el fondo sin taza y se dibuja la volcada con su charco.
  if (tazaTumbada.hasta > Date.now()) {
    const cx = ESCRITORIOS[1];
    ctx.drawImage(bgSinTaza, cx + 16, 156, 14, 13, cx + 16, 156, 14, 13);
    R(cx + 18, 165, 6, 3, '#fefefe'); R(cx + 24, 165, 1, 2, '#fefefe'); R(cx + 17, 166, 1, 1, '#d9d4cc');
    R(cx + 12, 167, 7, 1, '#4a2a17'); R(cx + 13, 168, 2, 1, '#4a2a17');
    const gota = Math.floor(performance.now() / 400) % 6;
    R(cx + 14, 169, 1, 2 + gota, '#4a2a17');
  }
});
ganchos.dibujables.push((t) => {
  const lista = [];
  for (const m of mascotasVivas) {
    lista.push({ y: m.casa.y - (m.tipo === 'loro' ? 0 : 0.5), pintar: () => dibujarCasa(m, t) });
    const enCasa = m.tipo === 'pecera' || (m.tipo === 'hamster' && m.estado !== 'bola') || (m.tipo === 'loro' && !m.ruta.length && m.estado === 'jaula');
    const y = enCasa ? m.casa.y + 0.2 : m.y;
    lista.push({ y, pintar: () => { (DIBUJAR[m.tipo])(m, t); dibujarNecesidades(m, t); } });
  }
  if (pelota.activa && !pelota.enBoca) {
    lista.push({ y: pelota.y, pintar: () => { R(pelota.x - 2, pelota.y, 4, 1, 'rgba(60,30,10,.25)'); R(pelota.x - 1, pelota.y - 3 - pelota.z, 3, 3, '#e9f542'); R(pelota.x - 1, pelota.y - 3 - pelota.z, 1, 1, '#ffffff'); } });
  }
  return lista;
});
// El loro en su jaula: se ubica en la percha cuando está adentro.
ganchos.mover.push(() => {
  for (const m of mascotasVivas) if (m.tipo === 'loro' && m.estado === 'jaula' && !m.ruta.length) { m.x = m.casa.x; m.y = m.casa.y - 36; }
});

/* =========================================================== globos de texto (ladrido, loro, ¡ups!) */
const capaMascotas = document.getElementById('carteles');
ganchos.encima.push((t) => {
  for (const m of mascotasVivas) {
    let el = document.getElementById('globo-mascota-' + m.id);
    if (!el) { el = document.createElement('div'); el.id = 'globo-mascota-' + m.id; el.className = 'globo'; capaMascotas.appendChild(el); }
    let texto = m.globo?.texto ?? null;
    if (!texto && m.estado === 'ladra') texto = Math.floor(m.anim / 700) % 2 ? '¡Guau! ¡Guau!' : '¡GUAU!';
    if (!texto && m.estado === 'fiesta') texto = '¡Guau! 🎉';
    if (texto && el.textContent !== texto) el.textContent = texto;
    el.classList.toggle('ver', Boolean(texto));
    if (texto) {
      const ancla = m.tipo === 'loro' && m.estado === 'jaula' ? { x: m.casa.x, y: m.casa.y - 60 } : { x: m.x, y: m.y - 22 };
      el.style.left = `calc(var(--s) * ${Math.round(ancla.x - 6)}px)`;
      el.style.top = `calc(var(--s) * ${Math.round(ancla.y - 10)}px)`;
      el.style.fontWeight = m.globo?.fuerte ? 'bold' : '';
    }
  }
});

/* =========================================================== clic: acariciar */
(ganchos.clic ??= []).push((p) => {
  const m = mascotasVivas.find((x) => {
    const c = x.tipo === 'pecera' ? { x: x.casa.x, y: x.casa.y - 18 } : x.tipo === 'hamster' && x.estado !== 'bola' ? { x: x.casa.x, y: x.casa.y - 8 } : { x: x.x, y: x.y - 6 };
    return Math.abs(p.x - c.x) < 11 && Math.abs(p.y - c.y) < 11;
  });
  if (!m) return false;
  accionMascota(m.id, 'acariciar');
  return true;
});

/* =========================================================== panel desplegable (izquierda) */
const estiloMascotas = document.createElement('style');
estiloMascotas.textContent = `
  #tab-mascotas { position: absolute; left: calc(var(--s) * -1px); top: calc(var(--s) * 132px); z-index: 12; cursor: pointer; border: 0;
    font: inherit; font-size: calc(var(--s) * 7px); padding: calc(var(--s) * 2px) calc(var(--s) * 2.5px); background: #6b4630; color: #fff3da;
    box-shadow: 0 0 0 calc(var(--s) * 1px) #3b2414, calc(var(--s) * 1px) calc(var(--s) * 1px) 0 calc(var(--s) * 1px) rgba(0,0,0,.3); }
  #tab-mascotas:hover { background: #8a5a3b; }
  #panel-mascotas { position: absolute; left: 0; top: calc(var(--s) * 70px); z-index: 13; width: calc(var(--s) * 132px); max-height: calc(var(--s) * 196px);
    overflow: auto; background: var(--crema); color: #3b2414; font-size: calc(var(--s) * 4.6px); line-height: 1.35;
    padding: calc(var(--s) * 3px) calc(var(--s) * 4px); box-shadow: 0 0 0 calc(var(--s) * 1px) #5a3a22, calc(var(--s) * 3px) calc(var(--s) * 3px) 0 rgba(0,0,0,.3);
    transform: translateX(-105%); visibility: hidden; transition: transform .25s ease, visibility 0s .25s; }
  #panel-mascotas.abierto { transform: none; visibility: visible; transition: transform .25s ease; }
  #panel-mascotas h3 { margin: 0 0 calc(var(--s) * 2px); color: #6b4630; font-size: 1.15em; display: flex; justify-content: space-between; }
  #panel-mascotas .masc { padding: calc(var(--s) * 1.5px) 0; border-bottom: 1px dashed #e0c9a0; }
  #panel-mascotas .masc b { color: #3b2414; }
  #panel-mascotas .nec { display: grid; grid-template-columns: auto 1fr; gap: 1px 4px; align-items: center; margin: 2px 0; color: #8a5a3b; }
  #panel-mascotas .nec i { display: block; height: calc(var(--s) * 2.5px); background: #e7d3ae; box-shadow: inset 0 0 0 1px #c9a77a; position: relative; }
  #panel-mascotas .nec i::after { content: ""; position: absolute; left: 1px; top: 1px; bottom: 1px; width: calc(var(--v) - 2px); background: var(--c); }
  #panel-mascotas button { font: inherit; cursor: pointer; border: 0; background: #6b4630; color: #fff3da; padding: 1px 4px; margin: 1px 1px 0 0; }
  #panel-mascotas button:hover { background: #8a5a3b; }
  #panel-mascotas button:disabled { opacity: .4; cursor: not-allowed; }
  #panel-mascotas .adoptar { display: grid; grid-template-columns: 1fr 1fr; gap: 2px; margin-top: 2px; }
  #panel-mascotas .adoptar button { text-align: left; background: #c9b08a; color: #3b2414; }
  #panel-mascotas .adoptar button:hover { background: #e2cfa6; }
  #panel-mascotas .nota { color: #8a5a3b; font-size: .9em; margin-top: 3px; }
  #panel-mascotas .error { color: #b5473a; font-weight: bold; }
`;
document.head.appendChild(estiloMascotas);
const escena = document.getElementById('escena');
const tab = document.createElement('button');
tab.id = 'tab-mascotas'; tab.type = 'button'; tab.title = 'Mascotas'; tab.textContent = '🐾';
const panelM = document.createElement('div');
panelM.id = 'panel-mascotas';
escena.append(panelM, tab);
tab.addEventListener('click', () => panelM.classList.toggle('abierto'));
let errorMascotas = '';

function barra(etiqueta, valor, color) {
  return `<span>${etiqueta}</span><i style="--v:${Math.round(valor)}%;--c:${color}"></i>`;
}
function pintarPanelMascotas() {
  const n = mascotasVivas.length;
  panelM.innerHTML = `<h3><span>🐾 Mascotas ${n}/3</span><button type="button" data-cerrar-m title="Cerrar">✖</button></h3>` +
    (n ? mascotasVivas.map((m) => {
      const t = MASC_TIPOS[m.tipo];
      return `<div class="masc">${t.icono} <b>${esc(m.nombre)}</b> · ${t.nombre.toLowerCase()} <span class="nota">(${t.casa})</span>` +
        `<div class="nec">${barra('Hambre', hambreDe(m), '#e07a32')}${barra('Sueño', m.sueno, '#8e6cc9')}${barra('Cariño', carinoDe(m), '#ef476f')}</div>` +
        `<button type="button" data-m="${m.id}" data-acc="alimentar">🍖 Alimentar</button><button type="button" data-m="${m.id}" data-acc="acariciar">✋ Acariciar</button>` +
        `<button type="button" data-m="${m.id}" data-acc="quitar" title="Quitarla de la oficina">✖</button></div>`;
    }).join('') : '<p class="nota">La oficina está sin mascotas. Adopta hasta 3.</p>') +
    `<div class="nota">Adoptar:</div><div class="adoptar">${Object.entries(MASC_TIPOS).map(([k, t]) =>
      `<button type="button" data-adoptar="${k}"${n >= 3 || mascotasVivas.some((m) => m.tipo === k) ? ' disabled' : ''}>${t.icono} ${t.nombre}</button>`).join('')}</div>` +
    (errorMascotas ? `<div class="error">${esc(errorMascotas)}</div>` : '') +
    '<div class="nota">Solo es visual: no toca el flujo. Clic sobre una mascota para acariciarla.</div>';
}
async function accionMascota(id, accion) {
  const m = mascotasVivas.find((x) => x.id === id);
  if (m && accion === 'acariciar') { m.corazones = 2.5; m.acariciada = Date.now(); }
  if (m && accion === 'alimentar') { m.comio = Date.now(); if (m.estado === 'hambre') decidir(m); }
  try {
    const r = await apiOficina('/api/mascotas', { accion, id });
    errorMascotas = '';
    sincronizar(r.mascotas);
  } catch (e) { errorMascotas = e.message; }
  pintarPanelMascotas();
}
panelM.addEventListener('click', async (ev) => {
  if (ev.target.closest('[data-cerrar-m]')) return panelM.classList.remove('abierto');
  const b = ev.target.closest('button[data-acc]');
  if (b) return accionMascota(b.dataset.m, b.dataset.acc);
  const ad = ev.target.closest('button[data-adoptar]');
  if (ad) {
    try {
      const r = await apiOficina('/api/mascotas', { accion: 'poner', tipo: ad.dataset.adoptar });
      errorMascotas = '';
      sincronizar(r.mascotas);
    } catch (e) { errorMascotas = e.message; }
    pintarPanelMascotas();
  }
});

/* =========================================================== sincronía con el servidor */
function sincronizar(lista) {
  const ids = new Set(lista.map((d) => d.id));
  for (let k = mascotasVivas.length - 1; k >= 0; k--) {
    if (ids.has(mascotasVivas[k].id)) continue;
    document.getElementById('globo-mascota-' + mascotasVivas[k].id)?.remove();
    mascotasVivas.splice(k, 1);
  }
  for (const d of lista) {
    const m = mascotasVivas.find((x) => x.id === d.id);
    if (!m) mascotasVivas.push(crearMascota(d));
    else { m.comio = Math.max(m.comio, Date.parse(d.comio)); m.acariciada = Math.max(m.acariciada, Date.parse(d.acariciada)); }
  }
}
const dictamenesVistos = new Set();
ganchos.datos.push((e, primera) => {
  sincronizar(Array.isArray(e.mascotas) ? e.mascotas : []);
  for (const d of e.dictamenes ?? []) {
    const clave = `${d.id}|${d.at}`;
    if (dictamenesVistos.has(clave)) continue;
    dictamenesVistos.add(clave);
    if (!primera) decirDictamen(d.resultado);
  }
  if (panelM.classList.contains('abierto') || primera) pintarPanelMascotas();
});
// Las barras del panel se mueven solas aunque no haya refresco.
setInterval(() => { if (panelM.classList.contains('abierto')) pintarPanelMascotas(); }, 5000);
