// Capturas para el README y el caso de estudio. Dos tipos:
// - anotadas: un recorte con zoom de una sola zona de la pantalla, agrandado, con etiquetas
//   numeradas en una columna a la derecha (celestes = algo que funciona, ámbar = algo para mejorar)
//   y una flecha curva hacia cada punto;
// - planas: la pantalla tal cual, con marco, para las portadas.
//
// Uso, con la plataforma corriendo sobre una copia de los datos de ejemplo:
//   BUSCADOR_RAIZ=<copia> python plataforma/servidor.py --puerto 8771   (en la copia, .panel_clave = CLAVE)
//   BASE_URL=http://localhost:8771 CLAVE=123456 node anotar.mjs [carpeta-salida] [nombre]
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL ?? 'http://localhost:8771';
const CLAVE = process.env.CLAVE ?? '123456';
const OUT = process.argv[2] ?? '.';
const SOLO = process.argv[3];
mkdirSync(OUT, { recursive: true });

const ESCRITORIO = { width: 1180, height: 900 };
// Los paneles laterales ocupan todo el alto: con una ventana alta se ve cada sección sin scroll.
const ALTO = { width: 1180, height: 2600 };
const CELULAR = { width: 390, height: 844 };
// Más angosto: tarjetas y tablas se acomodan y el recorte se puede agrandar sin perder lectura.
const MEDIO = { width: 820, height: 900 };

const abrir = (id) => async (page) => {
  await page.locator(`#lista [data-id="${id}"], #enviadas [data-id="${id}"]`).first().click();
  await page.locator('#dlg-detalle[open]').waitFor();
};
const pestana = (vista) => (page) => page.locator(`[data-vista="${vista}"]`).click();
const seccion = (titulo) => ({ s: `#det-cuerpo .seccion:has(> h4:text-is("${titulo}"))` });

// zona: elementos que tiene que abarcar el recorte (+ margen).
// notas: s = selector | t = texto (parcial salvo `exacto`); n = índice (-1 = último);
// en = punto de la flecha (derecha por defecto, 'arriba', 'abajo', 'centro' o 'izquierda'); alerta = para mejorar.
const CAPTURAS = [
  // Portadas (sin etiquetas)
  { nombre: '00-portada-claro', plana: true },
  { nombre: '00-portada-oscuro', plana: true, tema: 'dark' },
  { nombre: '00-enviadas', plana: true, accion: pestana('enviadas') },
  { nombre: '00-ofertas', plana: true, accion: pestana('encontradas') },
  { nombre: '00-celular', plana: true, viewport: CELULAR },

  // 1. Producto
  {
    nombre: 'p01-nueva-oferta',
    accion: (page) => page.locator('[data-abrir-nueva]:visible').click(),
    zona: [{ t: 'Capturas de pantalla', exacto: true }, { s: '#dlg-nueva [type=submit]' }], margen: 16,
    notas: [
      { t: 'Tocá para elegir', label: 'Desde el celular se saca la foto del aviso y se sube directo' },
      { s: '#nueva-link', label: 'También sirve el link o el texto pegado: una sola entrada para cualquier oferta' },
      { s: '#dlg-nueva [type=submit]', en: 'arriba', label: 'Desde acá el asistente hace todo el análisis: la persona sólo revisa' },
    ],
  },
  {
    nombre: 'p02-analisis', viewport: ALTO,
    accion: async (page) => {
      await abrir('2')(page);
      await page.locator('#det-cuerpo summary', { hasText: 'Análisis completo' }).click();
    },
    zona: [{ s: '#det-cuerpo details:has(summary:text-is("Análisis completo")) .md table' }, { s: '#det-cuerpo details:has(summary:text-is("Análisis completo")) .md p', n: 0 }, { s: '#det-cuerpo details:has(summary:text-is("Análisis completo")) .md h1' }], margen: 12,
    notas: [
      { t: 'Puntaje: 91/100', label: 'El puntaje se explica: rol, requisitos, remoto, idioma y sueldo' },
      { t: 'Finvara, billetera digital', label: 'Cada requisito apunta a la prueba en el CV maestro' },
      { t: 'Inglés técnico de lectura', exacto: true, n: -1, label: 'Inglés técnico sí; si pidiera inglés oral, la oferta se descarta sola' },
    ],
  },

  // 2. Diseño
  {
    nombre: 'd01-tarjetas', viewport: MEDIO,
    zona: [{ s: '#lista .tarjeta[data-id="8"]' }, { s: '#lista .tarjeta[data-id="6"]' }], margen: 14,
    notas: [
      { s: '#lista .tarjeta[data-id="8"] .puntaje', label: 'El puntaje se lee de un vistazo, como un anillo que se llena' },
      { s: '#lista .tarjeta[data-id="8"] .revision', en: 'abajo', label: 'Violeta: falta revisar. El color siempre va con texto' },
      { s: '#lista .tarjeta[data-id="6"] .revision', en: 'abajo', label: 'Naranja: revisada, lista para enviar' },
    ],
  },
  {
    nombre: 'd02-envio', viewport: ALTO,
    accion: async (page) => {
      await abrir('7')(page);
      await page.locator('#det-cuerpo [data-accion="mail"]').click();
      await page.locator('#dlg-mail[open]').waitFor();
    },
    zona: [{ s: '#mail-checklist' }, { s: '#btn-enviar' }], margen: 14,
    notas: [
      { s: '#mail-checklist legend', label: 'Antes de enviar hay que tildar cuatro cosas: CV, carta, requisitos y destinatario' },
      { s: '#mail-destino', label: 'El destinatario se repite acá: un mail mal dirigido no se puede deshacer' },
      { s: '#btn-enviar', en: 'arriba', alerta: true, label: 'El botón queda apagado hasta tildar todo (y hasta configurar el correo)' },
    ],
  },
  {
    nombre: 'd03-celular', viewport: CELULAR,
    zona: [{ s: '.top' }, { s: '#lista .tarjeta[data-id="7"]' }], margen: 0,
    notas: [
      { s: '#stats', en: 'abajo', label: 'Los contadores también filtran: se deslizan de costado' },
      { s: '#lista .tarjeta[data-id="7"] h3', label: 'Cada tarjeta muestra lo justo para decidir qué revisar primero' },
    ],
  },

  // 3. Full-Stack
  {
    nombre: 'f01-avance',
    accion: (page) => page.locator('#btn-campana').click(),
    zona: [{ s: '#trabajos article.procesando' }], margen: 10,
    notas: [
      { s: '#trabajos article.procesando h3', label: 'La oferta se procesa en segundo plano, de a una por vez' },
      { s: '#trabajos article.procesando ol li', n: -1, label: 'Cada paso del asistente se traduce a una frase que se entiende' },
      { s: '#trabajos article.procesando p', label: 'Siempre dice qué oferta está preparando' },
    ],
  },
  {
    nombre: 'f02-editor-cv', viewport: ALTO,
    accion: async (page) => {
      await abrir('7')(page);
      await page.locator('#det-cuerpo [data-accion="editar-cv"]').click();
      await page.locator('#dlg-cv[open]').waitFor();
      await page.locator('#dlg-cv textarea').first().waitFor();
    },
    zona: [{ s: '#dlg-cv .dlg-cab' }, { s: '#dlg-cv textarea[name=perfil]' }], margen: 8,
    notas: [
      { s: '#dlg-cv input[name=titular]', label: 'Se edita lo que más cambia entre ofertas: titular, perfil y logros' },
      { s: '#dlg-cv textarea[name=perfil]', alerta: true, label: 'Si algún texto dice VERIFICAR, no se guarda: primero hay que confirmar el dato' },
      { s: '#dlg-cv h2', label: 'Al guardar, el PDF se rehace solo con el mismo nombre' },
    ],
  },

  // 4. Datos
  {
    nombre: 'da01-ats', viewport: ALTO,
    accion: abrir('6'),
    zona: [seccion('Coincidencia con filtros ATS')], margen: 8,
    notas: [
      { s: '#det-cuerpo .ats-cab b', label: '3 de 8 palabras de la oferta están en el CV: se mide sobre el PDF, como lo leería un ATS' },
      { t: 'impedimentos', exacto: true, alerta: true, label: 'Lo que falta no se agrega solo: primero hay que saberlo' },
      { s: '#det-cuerpo [data-lo-se]', n: 0, en: 'izquierda', label: '«Lo sé» lo suma a los conocimientos y el CV se rehace con esas palabras' },
    ],
  },
  {
    nombre: 'da02-enviadas', accion: pestana('enviadas'),
    zona: [{ s: '#enviadas table' }], margen: 10,
    notas: [
      { s: '#enviadas td.vencido', n: 0, alerta: true, label: 'Vencido: a la semana del envío toca escribir de nuevo' },
      { s: '#enviadas th', n: 3, label: 'El estado se cambia desde la tabla, sin abrir nada' },
      { s: '#enviadas th', n: 5, label: 'Las dos entrevistas son de las de puntaje más alto: 86 y 91' },
    ],
  },
  {
    nombre: 'da03-ofertas', accion: pestana('encontradas'),
    zona: [{ s: '#encontradas table', n: 0 }], margen: 10, alto: 520,
    notas: [
      { s: '#encontradas td[data-et="Encaje"] .pill', n: 0, label: 'El encaje resume el puntaje: alto, medio o bajo' },
      { t: 'Brecha:', n: 0, en: 'izquierda', label: 'Cada oferta dice qué falta y cómo cubrirlo antes de postularse' },
      { s: '#encontradas .celda-accion', n: 0, en: 'abajo', label: '«Postularme» lanza el análisis; «Descartar» la saca de la lista para siempre' },
    ],
  },

  // 5. Gestión
  {
    nombre: 'g01-embudo', viewport: MEDIO,
    zona: [{ s: '#stats' }], margen: 12,
    notas: [
      { s: '#stats > *', n: 1, en: 'abajo', label: 'Revisar → pendiente → enviado: el embudo de la búsqueda' },
      { s: '#stats > *', n: 4, en: 'abajo', label: 'Entrevista y segunda entrevista: 2 de las 5 enviadas avanzaron' },
      { s: '#stats > *', n: 0, en: 'abajo', label: 'Cada contador es también un filtro de la lista' },
    ],
  },
  {
    nombre: 'g02-reintento',
    accion: (page) => page.locator('#btn-campana').click(),
    zona: [{ s: '#trabajos article.error' }], margen: 10,
    notas: [
      { s: '#trabajos article.error p', alerta: true, label: 'Si se corta la luz o se cierra la terminal, el trabajo no se pierde…' },
      { s: '[data-reintentar-trabajo]', en: 'abajo', label: '…se retoma desde donde quedó, con el mismo link y las mismas capturas' },
    ],
  },
];

function locator(page, nota) {
  const loc = nota.s ? page.locator(nota.s) : page.getByText(nota.t, { exact: Boolean(nota.exacto) });
  return nota.n === -1 ? loc.last() : loc.nth(nota.n ?? 0);
}

async function rect(page, nota) {
  const loc = locator(page, nota);
  const visible = await loc.isVisible().catch(() => false);
  if (!visible) return null;
  return loc.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  });
}

const ANCHO_IMAGEN = 640;
const ANCHO_ETIQUETA = 360;
// Paleta del portfolio: marco lila y celeste claro, sombra violeta, etiquetas celestes y ámbar.
const FONDO = 'linear-gradient(135deg,#F5F3FF,#E0F2FE)';
const SOMBRA = '0 20px 50px rgba(124,58,237,.22),0 0 0 1px rgba(192,132,252,.35)';

async function enMarco(browser, png, ancho, alto, notas, file) {
  const k = Math.min(1.6, ANCHO_IMAGEN / ancho);
  const pad = 40;
  const imgW = ancho * k;
  const imgH = alto * k;
  const lx = pad + imgW + 70;
  const W = Math.ceil(notas.length ? lx + ANCHO_ETIQUETA + pad : pad * 2 + imgW);
  // Cada nota marca su elemento con un recuadro; la flecha llega al borde de la imagen, a la altura
  // del recuadro, así nunca cruza por encima del contenido.
  const pts = notas.map((n) => {
    const bx = pad + Math.max(0, n.cx - 4) * k;
    const by = pad + Math.max(0, n.cy - 4) * k;
    const bw = (Math.min(ancho, n.cx + n.w + 4) - Math.max(0, n.cx - 4)) * k;
    const bh = (Math.min(alto, n.cy + n.h + 4) - Math.max(0, n.cy - 4)) * k;
    return { label: n.label, color: n.alerta ? '#F59E0B' : '#0EA5E9', bx, by, bw, bh, tx: pad + imgW + 6, ty: by + bh / 2 };
  });
  pts.sort((a, b) => a.ty - b.ty).forEach((p, i) => (p.i = i + 1));
  console.log(pts.map((p) => `    ${p.i}. ${p.label}`).join('\n'));
  const page = await browser.newPage({ viewport: { width: W, height: 400 }, deviceScaleFactor: 2 });
  await page.setContent(`<!doctype html><html><head><style>
    body{margin:0;width:${W}px;background:${FONDO};font-family:Inter,system-ui,sans-serif;position:relative}
    img{position:absolute;left:${pad}px;top:${pad}px;width:${imgW}px;border-radius:18px;box-shadow:${SOMBRA}}
    .tag{position:absolute;left:${lx}px;width:${ANCHO_ETIQUETA}px;box-sizing:border-box;display:flex;align-items:flex-start;gap:12px;padding:14px 18px;border-radius:20px;color:#fff;font-weight:600;font-size:22px;line-height:1.3;box-shadow:0 8px 20px rgba(15,23,42,.18)}
    .n{flex:none;width:32px;height:32px;border-radius:50%;background:#fff;display:grid;place-items:center;font-size:18px;font-weight:800}
    svg{position:absolute;left:0;top:0;overflow:visible}
  </style></head><body>
    <img src="data:image/png;base64,${png.toString('base64')}" />
    ${pts.map((p) => `<div class="tag" style="background:${p.color}"><span class="n" style="color:${p.color}">${p.i}</span><span>${p.label}</span></div>`).join('')}
    <svg id="flechas"></svg>
  </body></html>`);
  await page.evaluate(({ pts, pad, imgH, lx }) => {
    const tags = [...document.querySelectorAll('.tag')];
    const orden = pts.map((p, i) => ({ ...p, el: tags[i] })).sort((a, b) => a.ty - b.ty);
    let piso = pad;
    for (const p of orden) {
      const h = p.el.offsetHeight;
      p.top = Math.max(piso, p.ty - h / 2);
      p.el.style.top = `${p.top}px`;
      p.sy = p.top + Math.min(h / 2, 30);
      piso = p.top + h + 16;
    }
    const H = Math.ceil(Math.max(pad * 2 + imgH, piso + pad - 16));
    document.body.style.height = `${H}px`;
    const svg = document.getElementById('flechas');
    svg.setAttribute('width', document.body.offsetWidth);
    svg.setAttribute('height', H);
    svg.innerHTML = orden
      .map((p) => {
        const sx = lx - 4;
        const mx = (sx + p.tx) / 2;
        const caja = `<rect x="${p.bx}" y="${p.by}" width="${p.bw}" height="${p.bh}" rx="10" fill="none" stroke="${p.color}" stroke-width="4"/>`;
        return caja + `<path d="M${sx},${p.sy} C${mx},${p.sy} ${mx},${p.ty} ${p.tx},${p.ty}" stroke="${p.color}" stroke-width="4" fill="none" stroke-linecap="round"/><circle cx="${p.tx}" cy="${p.ty}" r="9" fill="${p.color}" stroke="#fff" stroke-width="3"/>`;
      })
      .join('');
  }, { pts, pad, imgH, lx });
  const H = await page.evaluate(() => document.body.offsetHeight);
  await page.setViewportSize({ width: W, height: H });
  await page.screenshot({ path: file });
  await page.close();
}

// Código del servidor como tarjeta oscura con resaltado simple.
async function codigo(browser, archivo, desde, hasta, titulo, file) {
  const crudas = readFileSync(archivo, 'utf8').split('\n').slice(desde - 1, hasta);
  const sangria = Math.min(...crudas.filter((l) => l.trim()).map((l) => l.match(/^ */)[0].length));
  const lineas = crudas.map((l) => l.slice(sangria));
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const resaltar = (l) => /^\s*#/.test(l) ? `<i class="c">${esc(l)}</i>` : esc(l)
    .replace(/("[^"]*")/g, '<i class="s">$1</i>')
    .replace(/\b(def|return|if|not|for|in|with|try|except|as|is|True|and|or)\b/g, '<i class="k">$1</i>')
    .replace(/(@app\.\w+)/g, '<i class="d">$1</i>');
  const page = await browser.newPage({ viewport: { width: 1300, height: 400 }, deviceScaleFactor: 2 });
  await page.setContent(`<!doctype html><html><head><style>
    body{margin:0;padding:40px;background:${FONDO};font-family:Inter,system-ui,sans-serif;display:inline-block}
    .card{background:#1E1B2E;border-radius:18px;box-shadow:${SOMBRA};overflow:hidden;width:max-content;max-width:1150px}
    .bar{padding:12px 18px;color:#C4B5FD;font-size:15px;border-bottom:1px solid #2E2A44}
    pre{margin:0;padding:18px 22px;white-space:pre-wrap;color:#E9E7F5;font:15px/1.6 "JetBrains Mono",ui-monospace,monospace}
    .n{display:inline-block;width:2.6em;color:#6B6789;user-select:none}
    i{font-style:normal}.k{color:#C084FC}.s{color:#7DD3FC}.c{color:#8B87A8}.d{color:#FBBF24}
  </style></head><body><div class="card"><div class="bar">${esc(titulo)}</div><pre>${lineas
    .map((l, i) => `<span class="n">${desde + i}</span>${resaltar(l)}`).join('\n')}</pre></div></body></html>`);
  const caja = await page.locator('body').boundingBox();
  await page.setViewportSize({ width: Math.ceil(caja.width), height: Math.ceil(caja.height) });
  await page.screenshot({ path: file });
  await page.close();
}

const browser = await chromium.launch();
for (const cap of CAPTURAS) {
  if (SOLO && cap.nombre !== SOLO) continue;
  const ctx = await browser.newContext({ viewport: cap.viewport ?? ESCRITORIO, deviceScaleFactor: 2, locale: 'es-AR' });
  await ctx.addCookies([{ name: 'clave', value: CLAVE, url: BASE }]);
  await ctx.addInitScript((tema) => {
    localStorage.setItem('tema', tema);
    localStorage.setItem('avisosVistos', '[]');
  }, cap.tema ?? 'light');
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.locator('#lista .tarjeta').first().waitFor();
  if (cap.accion) {
    await cap.accion(page);
    await page.waitForTimeout(1500);
  }
  let clip = { x: 0, y: 0, width: page.viewportSize().width, height: Math.min(page.viewportSize().height, 900) };
  if (cap.zona) {
    const rs = [];
    for (const z of cap.zona) {
      const r = await rect(page, z);
      if (!r) throw new Error(`${cap.nombre}: no encontré la zona ${z.s ?? z.t}`);
      rs.push(r);
    }
    const m = cap.margen ?? 16;
    const x = Math.max(0, Math.min(...rs.map((r) => r.x)) - m);
    const y = Math.max(0, Math.min(...rs.map((r) => r.y)) - m);
    const x2 = Math.max(...rs.map((r) => r.x + r.w)) + m;
    const y2 = Math.max(...rs.map((r) => r.y + r.h)) + m;
    clip = { x, y, width: Math.min(cap.ancho ?? Infinity, x2 - x), height: Math.min(cap.alto ?? Infinity, y2 - y) };
  }
  clip = { x: Math.round(clip.x), y: Math.round(clip.y), width: Math.round(clip.width), height: Math.round(clip.height) };
  const notas = [];
  for (const n of cap.notas ?? []) {
    const r = await rect(page, n);
    if (r) notas.push({ ...n, ...r, cx: r.x - clip.x, cy: r.y - clip.y });
    else console.warn('  sin elemento:', cap.nombre, n.label);
  }
  const png = await page.screenshot({ clip });
  await enMarco(browser, png, clip.width, clip.height, notas, join(OUT, `${cap.nombre}.png`));
  console.log('ok', cap.nombre, `${notas.length}/${(cap.notas ?? []).length}`, `${clip.width}×${clip.height}`);
  await ctx.close();
}
// Tarjetas de código: [nombre, línea donde empieza, cuántas líneas, título].
const servidor = new URL('../../plataforma/servidor.py', import.meta.url).pathname;
const fuente = readFileSync(servidor, 'utf8').split('\n');
const linea = (inicio) => fuente.findIndex((l) => l.trimStart().startsWith(inicio)) + 1;
const CODIGO = [
  ['f03-envio-codigo', linea('@app.post("/api/postulaciones/<id_>/enviar")'), 13, 'plataforma/servidor.py · el envío exige confirmación'],
  ['f04-permisos-codigo', linea('# Sin subagentes'), 6, 'plataforma/servidor.py · qué puede hacer el asistente y qué no'],
];
for (const [nombre, desde, cuantas, titulo] of CODIGO) {
  if (SOLO && SOLO !== nombre) continue;
  await codigo(browser, servidor, desde, desde + cuantas - 1, titulo, join(OUT, `${nombre}.png`));
  console.log('ok', nombre);
}
await browser.close();
