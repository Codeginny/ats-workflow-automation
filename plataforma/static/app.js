"use strict";

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (t) => String(t ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const items = (t) => String(t || "").split(";").map((s) => s.trim()).filter(Boolean);
const normal = (t) => String(t || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
// "CRM: HubSpot CRM gratis (…)" → "CRM"
const temaCorto = (t) => String(t).split(/[:(]/)[0].trim();

const estado = {
  postulaciones: [], estados: [], smtp: false, filtro: "", busqueda: "",
  trabajos: [], abierta: null, plan: { items: [] }, conocimientos: [], vista: "postulaciones", avisosSinVer: 0,
};

// ---------------------------------------------------------------- utilidades

async function api(url, opciones = {}) {
  const r = await fetch(url, opciones);
  if (r.status === 401) { location.href = "/login"; throw new Error("Sin acceso"); }
  const datos = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(datos.error || `Error ${r.status}`);
  return datos;
}
const json = (method, body) => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

let toastTimer;
function toast(texto) {
  const t = $("#toast");
  t.textContent = texto;
  t.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("visible"), 3600);
}

function markdown(md) {
  if (window.marked && window.DOMPurify) return DOMPurify.sanitize(marked.parse(md || ""));
  return `<pre class="carta">${esc(md)}</pre>`;
}

const sinEmoji = (etiqueta) => etiqueta.replace(/^\S+\s/, "");
function pill(clave, etiqueta) {
  return `<span class="pill" style="color:var(--st-${clave});background:var(--st-${clave}-bg)">${esc(sinEmoji(etiqueta))}</span>`;
}

function fecha(iso) {
  if (!iso) return "";
  const [a, m, d] = iso.split("-").map(Number);
  return new Date(a, m - 1, d || 1).toLocaleDateString("es-AR", d ? { day: "numeric", month: "short" } : { month: "short", year: "numeric" });
}

function yaLoSabe(texto) {
  const t = normal(temaCorto(texto));
  return estado.conocimientos.some((c) => normal(c.tema) === t);
}

// ---------------------------------------------------------------- avisos (cuando una postulación queda lista)

const tituloBase = document.title;
function avisar(texto) {
  toast(texto);
  if (document.hidden) {
    estado.avisosSinVer += 1;
    document.title = `(${estado.avisosSinVer}) ✔ Lista para revisar · ${tituloBase}`;
  }
  try { navigator.vibrate?.([120, 60, 120]); } catch (e) {}
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    [660, 880].forEach((f, i) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = f; o.connect(g); g.connect(ctx.destination);
      g.gain.setValueAtTime(0.12, ctx.currentTime + i * 0.18);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i * 0.18 + 0.25);
      o.start(ctx.currentTime + i * 0.18); o.stop(ctx.currentTime + i * 0.18 + 0.26);
    });
  } catch (e) {}
  if ("Notification" in window && Notification.permission === "granted") {
    try { new Notification("Postulaciones de Caro", { body: texto, icon: "/static/icono.svg" }); } catch (e) {}
  }
}
function pedirPermisoAvisos() {
  if ("Notification" in window && window.isSecureContext && Notification.permission === "default") {
    Notification.requestPermission().catch(() => {});
  }
}

// ---------------------------------------------------------------- tema

function aplicarTema(tema) {
  document.documentElement.dataset.theme = tema;
  try { localStorage.setItem("tema", tema); } catch (e) {}
  const oscuro = tema === "dark";
  const btn = $("#btn-tema");
  btn.setAttribute("aria-label", oscuro ? "Cambiar a modo claro" : "Cambiar a modo oscuro");
  btn.innerHTML = `<svg class="icono"><use href="#${oscuro ? "i-sol" : "i-luna"}"/></svg>`;
  $('meta[name="theme-color"]').content = oscuro ? "#0e1116" : "#3a5bd9";
}

// ---------------------------------------------------------------- vistas

const VISTAS_ESTUDIO = ["estudiar", "cursos", "diccionario"];

function mostrarVista(vista) {
  estado.vista = vista;
  const area = VISTAS_ESTUDIO.includes(vista) ? "estudio" : "trabajo";
  document.body.classList.toggle("modo-estudio", area === "estudio");
  $$(".area").forEach((b) => b.setAttribute("aria-pressed", b.dataset.area === area));
  $$("[data-tabs]").forEach((g) => { g.hidden = g.dataset.tabs !== area; });
  $$(".tab").forEach((x) => x.setAttribute("aria-selected", x.dataset.vista === vista));
  ["postulaciones", "enviadas", "estudiar", "cursos", "diccionario", "encontradas"].forEach((v) => $(`#vista-${v}`).classList.toggle("oculto", v !== vista));
  if (vista === "encontradas") cargarEncontradas().catch((e) => toast(e.message));
  if (vista === "enviadas") pintarEnviadas();
  if (vista === "cursos") cargarCursos().catch((e) => toast(e.message));
  if (vista === "diccionario") cargarDiccionario().catch((e) => toast(e.message));
  if (vista === "estudiar") cargarEstudio().catch((e) => toast(e.message));
  window.scrollTo({ top: 0 });
}

// ---------------------------------------------------------------- postulaciones

async function cargarPostulaciones() {
  const d = await api("/api/postulaciones");
  Object.assign(estado, { postulaciones: d.postulaciones, estados: d.estados, smtp: d.smtp, firma: d.firma || "", estudioActivo: d.estudio_activo });
  document.body.classList.toggle("sin-estudio", !d.estudio_activo);
  pintarStats();
  pintarLista();
  if (estado.vista === "enviadas") pintarEnviadas();
  if (estado.abierta && $("#dlg-detalle").open) {
    const p = estado.postulaciones.find((x) => x.id === estado.abierta);
    if (p) pintarDetalle(p);
  }
}

function pintarStats() {
  const total = estado.postulaciones.length;
  const cuenta = (c) => estado.postulaciones.filter((p) => p.estado_clave === c).length;
  const botones = [{ clave: "", etiqueta: "Todas", n: total }]
    .concat(estado.estados.map((e) => ({ clave: e.clave, etiqueta: e.etiqueta, n: cuenta(e.clave) })))
    .filter((b) => b.clave === "" || b.n > 0);
  $("#stats").innerHTML = botones.map((b) => `
    <button class="stat" type="button" data-filtro="${b.clave}" aria-pressed="${estado.filtro === b.clave}">
      <b>${b.n}</b><span>${esc(b.etiqueta)}</span>
    </button>`).join("");
  const enviadas = total - cuenta("preparada") - cuenta("pendiente_envio") - cuenta("descartada");
  $("#subtitulo").textContent = `${total} postulaciones · ${enviadas} enviadas`;
}

function colorRevision(p) {
  if (p.enviada) return { clase: "verde", texto: "Enviada" };
  if (p.revisada_bool) return { clase: "naranja", texto: "Revisada · falta enviar" };
  return { clase: "rojo", texto: "Falta revisar y mejorar" };
}

function tarjeta(p) {
  const estudiar = items(p.para_estudiar).length;
  const hechos = (p.estudiado || []).length;
  const color = colorRevision(p);
  return `
    <button class="tarjeta borde-${color.clase}" type="button" data-id="${esc(p.id)}">
      <div class="tarjeta-cab">
        <div>
          <h3>${esc(p.puesto)}</h3>
          <div class="empresa">${esc(p.empresa)}</div>
        </div>
        ${p.puntaje_match ? `<div class="puntaje" style="--p:${Number(p.puntaje_match) || 0}" title="Puntaje de match"><span>${esc(p.puntaje_match)}</span></div>` : ""}
      </div>
      ${p.a_que_se_dedica ? `<p class="dedica">${esc(p.a_que_se_dedica)}</p>` : ""}
      <div class="tarjeta-pie">
        ${p.enviada ? pill(p.estado_clave, p.estado) : `<span class="revision ${color.clase}">${color.texto}</span>`}
        <span>${fecha(p.fecha)}</span>
        ${p.ats ? `<span>· ATS ${p.ats.cobertura}%</span>` : ""}
        ${estudiar && estado.estudioActivo ? `<span>· 📚 ${hechos}/${estudiar}</span>` : ""}
        ${p.seguimiento_vencido ? `<span class="aviso">· Hacer seguimiento</span>` : ""}
      </div>
    </button>`;
}

function pintarLista() {
  const q = normal(estado.busqueda);
  const lista = estado.postulaciones.filter((p) =>
    (estado.filtro === "descartada" || p.estado_clave !== "descartada") &&
    (!estado.filtro || p.estado_clave === estado.filtro) &&
    (!q || normal([p.empresa, p.puesto, p.requisitos_clave, p.a_que_se_dedica].join(" ")).includes(q)));

  if (!estado.postulaciones.length) {
    $("#lista").innerHTML = `<div class="vacio"><h3>Todavía no hay postulaciones</h3>
      <p>Tocá <b>Nueva oferta</b> y pegá una publicación o una captura.</p></div>`;
    return;
  }
  if (!lista.length) {
    $("#lista").innerHTML = `<div class="vacio"><h3>Sin resultados</h3><p>Probá con otra búsqueda o estado.</p></div>`;
    return;
  }
  // Para enviar: primero las que faltan revisar (rojo), después las revisadas (naranja); a igualdad, mejor puntaje.
  const porEnviar = lista.filter((p) => !p.enviada && (p.estado_clave !== "descartada" || estado.filtro === "descartada"))
    .sort((a, b) => (a.revisada_bool - b.revisada_bool) || (Number(b.puntaje_match) - Number(a.puntaje_match)));
  const enviadas = lista.filter((p) => p.enviada);
  const grupo = (titulo, ayuda, ps) => ps.length ? `
    <section class="grupo">
      <div class="grupo-cab"><h2>${titulo} (${ps.length})</h2><span>${ayuda}</span></div>
      <div class="grilla">${ps.map(tarjeta).join("")}</div>
    </section>` : "";
  $("#lista").innerHTML =
    grupo("Para enviar", "Revisalas, mejoralas y mandalas", porEnviar) +
    (enviadas.length ? `<section class="grupo">
      <div class="grupo-cab"><h2>Enviadas (${enviadas.length})</h2><span>Esperando respuesta o en proceso · cambiá el estado cuando respondan</span></div>
      ${tablaEnviadas(enviadas)}</section>` : "");
}

function selectorEstado(p) {
  return `<select class="estado-rapido st-${esc(p.estado_clave)}" data-estado-rapido="${esc(p.id)}" aria-label="Estado de ${esc(p.empresa)}">
    ${estado.estados.map((e) => `<option value="${e.clave}"${e.clave === p.estado_clave ? " selected" : ""}>${esc(e.etiqueta)}</option>`).join("")}
  </select>`;
}

function tablaEnviadas(ps) {
  ps = [...ps].sort((a, b) => (b.fecha || "").localeCompare(a.fecha || ""));
  return `<div class="tabla-wrap"><table class="tabla">
      <thead><tr><th>Enviada</th><th>Empresa</th><th>Puesto</th><th>Estado</th><th>Seguimiento</th><th>Puntaje</th><th></th></tr></thead>
      <tbody>${ps.map((p) => `<tr>
        <td data-et="Enviada">${fecha(p.fecha)}</td>
        <td data-et="Empresa"><b>${esc(p.empresa)}</b></td>
        <td data-et="Puesto">${esc(p.puesto)}</td>
        <td data-et="Estado">${selectorEstado(p)}</td>
        <td data-et="Seguimiento" class="${p.seguimiento_vencido ? "vencido" : ""}">${p.proximo_seguimiento ? fecha(p.proximo_seguimiento) + (p.seguimiento_vencido ? " · ¡ya toca!" : "") : "—"}</td>
        <td data-et="Puntaje">${esc(p.puntaje_match || "—")}</td>
        <td><button class="btn btn-chico" type="button" data-id="${esc(p.id)}">Revisar</button></td>
      </tr>`).join("")}</tbody>
    </table></div>`;
}

function pintarEnviadas() {
  const ps = estado.postulaciones.filter((p) => p.enviada);
  $("#enviadas").innerHTML = ps.length ? tablaEnviadas(ps)
    : `<div class="vacio"><h3>Todavía no enviaron ninguna</h3><p>Cuando manden un mail desde la plataforma (o toquen «CV enviado»), aparece acá.</p></div>`;
}

function botonLoSe(texto) {
  return yaLoSabe(texto)
    ? `<span class="ya-sumado">✔ En su base</span>`
    : `<span class="lo-se-botones"><button class="btn btn-mini" type="button" data-lo-se="${esc(texto)}" title="Se suma directo al CV">Lo sé</button><button class="btn btn-mini" type="button" data-lo-se="${esc(texto)}" data-prueba-antes="1" title="Una prueba corta antes de sumarlo">Hacer prueba</button></span>`;
}

function pintarDetalle(p) {
  estado.abierta = p.id;
  $("#det-titulo").textContent = p.puesto;
  $("#det-empresa").textContent = [p.empresa, p.fecha && `cargada el ${fecha(p.fecha)}`].filter(Boolean).join(" · ");
  const pt = $("#det-puntaje");
  pt.style.setProperty("--p", Number(p.puntaje_match) || 0);
  pt.querySelector("span").textContent = p.puntaje_match || "–";

  const requisitos = items(p.requisitos_clave);
  const estudiar = items(p.para_estudiar);
  const hechos = new Set(p.estudiado || []);
  const pct = estudiar.length ? Math.round((hechos.size / estudiar.length) * 100) : 0;
  const notas = items((p.notas || "").replaceAll("|", ";"));
  const actualizando = estado.trabajos.some((t) => t.tipo === "cv" && t.postulacion === p.id && ["en_cola", "procesando"].includes(t.estado));

  $("#det-cuerpo").innerHTML = `
    <div class="acciones">
      ${p.pdfs.map((ruta) => `<a class="btn" href="/archivos/${encodeURI(ruta)}?v=${estado.versionCv || 0}" target="_blank" rel="noopener"><svg class="icono"><use href="#i-pdf"/></svg> Ver CV</a>`).join("")}
      ${p.pdfs.length ? `<button class="btn" type="button" data-accion="editar-cv"><svg class="icono"><use href="#i-lapiz"/></svg> Editar CV</button>` : ""}
      ${p.correo && p.correo.para ? `<button class="btn btn-primario" type="button" data-accion="mail"><svg class="icono"><use href="#i-mail"/></svg> Enviar mail</button>` : ""}
      ${!p.enviada && p.estado_clave !== "descartada" ? `<button class="btn btn-primario" type="button" data-accion="ya-enviado"><svg class="icono"><use href="#i-check"/></svg> CV enviado</button>` : ""}
      ${p.link_oferta ? `<a class="btn" href="${esc(p.link_oferta)}" target="_blank" rel="noopener"><svg class="icono"><use href="#i-link"/></svg> Ver oferta</a>` : ""}
      <button class="btn" type="button" data-accion="actualizar-cv" ${actualizando ? "disabled" : ""} title="Rehace el CV sumando los conocimientos nuevos de Caro">
        <svg class="icono"><use href="#i-rayo"/></svg> ${actualizando ? "Actualizando CV…" : "Actualizar CV"}</button>
      ${p.estado_clave === "descartada"
        ? `<button class="btn" type="button" data-accion="recuperar">↩ Recuperar</button>`
        : `<button class="btn btn-peligro" type="button" data-accion="descartar">🗑️ Descartar</button>`}
    </div>

    <div class="seccion">
      <h4>Estado</h4>
      <div class="estados">
        ${estado.estados.map((e) => `<button type="button" class="pill" data-estado="${e.clave}" aria-pressed="${e.clave === p.estado_clave}"
            style="color:var(--st-${e.clave});background:var(--st-${e.clave}-bg)">${esc(e.etiqueta)}</button>`).join("")}
      </div>
      ${p.proximo_seguimiento ? `<p class="ayuda" style="margin-top:8px">Próximo seguimiento: <b>${fecha(p.proximo_seguimiento)}</b>${p.seguimiento_vencido ? " — ¡ya toca escribir!" : ""}</p>` : ""}
    </div>

    ${!p.enviada ? `<div class="seccion"><h4>Revisión</h4>
      <div class="revision-caja">
        <span class="revision ${colorRevision(p).clase}">${colorRevision(p).texto}</span>
        ${p.revisada_bool
          ? `<button class="btn btn-chico" type="button" data-revisada="0">Volver a «falta revisar»</button>`
          : `<button class="btn btn-chico" type="button" data-revisada="1"><svg class="icono"><use href="#i-check"/></svg> Ya la revisamos y mejoramos</button>`}
      </div></div>` : ""}

    ${pintarAts(p)}

    ${p.a_que_se_dedica ? `<div class="seccion"><h4>A qué se dedica la empresa</h4><p>${esc(p.a_que_se_dedica)}</p></div>` : ""}

    ${requisitos.length ? `<div class="seccion"><h4>Qué pide el puesto</h4>
      <p class="ayuda" style="margin-bottom:8px">¿Caro sabe algo de esto que no está en el CV? Sumalo y después tocá «Actualizar CV».</p>
      <ul class="filas-accion">${requisitos.map((r) => `<li class="fila-accion"><span>${esc(r)}</span>${botonLoSe(r)}</li>`).join("")}</ul></div>` : ""}

    ${estudiar.length && estado.estudioActivo ? `<div class="seccion"><h4>Para estudiar mientras esperamos · ${hechos.size}/${estudiar.length}</h4>
      <div class="barra"><i style="width:${pct}%"></i></div>
      <ul class="filas-accion">${estudiar.map((t, i) => `<li class="fila-accion">
        <label><input type="checkbox" data-estudio="${i}" ${hechos.has(i) ? "checked" : ""}><span>${esc(t)}</span></label>
        ${botonLoSe(t)}</li>`).join("")}</ul>
      <button class="btn btn-chico" type="button" data-accion="estudiar" style="margin-top:10px"><svg class="icono"><use href="#i-gorro"/></svg> Estudiar</button></div>` : ""}

    <div class="seccion"><h4>Contacto</h4><p>${esc(p.contacto || "—")}${p.canal ? ` · ${esc(p.canal)}` : ""}</p>
      ${p.fuente ? `<p class="ayuda">Fuente: ${esc(p.fuente)}</p>` : ""}</div>

    ${p.carta_texto ? `<details class="seccion" ${estado.editandoCarta ? "open" : ""}><summary>Carta de presentación</summary>
      ${estado.editandoCarta ? `<form data-form="carta">
          <label class="sr" for="carta-edit">Carta</label>
          <textarea id="carta-edit" class="carta-edit" rows="14">${esc(p.carta_texto)}</textarea>
          <div class="fila-botones"><button class="btn btn-primario" type="submit">Guardar carta</button>
          <button class="btn" type="button" data-accion="cancelar-carta">Cancelar</button></div></form>`
        : `<pre class="carta">${esc(p.carta_texto)}</pre>
          <button class="btn btn-chico" type="button" data-accion="editar-carta"><svg class="icono"><use href="#i-lapiz"/></svg> Editar carta</button>`}
      </details>` : ""}
    ${p.analisis ? `<details class="seccion"><summary>Análisis completo</summary><div class="md">${markdown(p.analisis)}</div></details>` : ""}

    <div class="seccion"><h4>Notas</h4>
      <div class="notas">${notas.map((n) => `<div class="nota">${esc(n)}</div>`).join("") || `<p class="ayuda">Sin notas todavía.</p>`}</div>
      <form class="fila-nota" data-form="nota">
        <label class="sr" for="nota-nueva">Nueva nota</label>
        <input id="nota-nueva" type="text" placeholder="Ej.: Me llamaron, entrevista el jueves 10 h" required>
        <button class="btn" type="submit">Agregar</button>
      </form>
    </div>`;
}

// ---------------------------------------------------------------- editar CV

async function abrirEditorCv(p) {
  let cv;
  try { cv = await api(`/api/postulaciones/${p.id}/cv`); } catch (e) { toast(e.message); return; }
  $("#cv-empresa").textContent = `${p.puesto} · ${p.empresa}`;
  $("#cv-campos").innerHTML = `
    <label>Titular (debajo del nombre)<input name="titular" value="${esc(cv.titular)}"></label>
    <label>Perfil<textarea name="perfil" rows="6">${esc(cv.perfil)}</textarea></label>
    ${cv.experiencia.map((e, i) => `<fieldset class="cv-exp" data-exp="${i}">
      <legend>${esc(e.empresa)}</legend>
      <label>Puesto<input data-campo="puesto" value="${esc(e.puesto)}"></label>
      <label>Período<input data-campo="periodo" value="${esc(e.periodo)}"></label>
      <label>Logros (uno por renglón)<textarea data-campo="logros" rows="${Math.min(10, e.logros.length + 2)}">${esc(e.logros.join("\n"))}</textarea></label>
    </fieldset>`).join("")}
    <label>Remuneración pretendida <span class="ayuda">(dejala vacía si la publicación no dice nada de sueldo)</span>
      <input name="pretension" value="${esc(cv.pretension)}" placeholder="Ej.: USD 2.500 mensuales"></label>`;
  $("#dlg-cv").showModal();
}

async function guardarCv(ev) {
  ev.preventDefault();
  const f = ev.target, btn = $("button[type=submit]", f);
  const datos = {
    titular: f.titular.value, perfil: f.perfil.value, pretension: f.pretension.value,
    experiencia: $$(".cv-exp", f).map((fs) => ({
      puesto: $('[data-campo="puesto"]', fs).value, periodo: $('[data-campo="periodo"]', fs).value,
      logros: $('[data-campo="logros"]', fs).value.split("\n"),
    })),
  };
  btn.disabled = true;
  try {
    const p = await api(`/api/postulaciones/${estado.abierta}/cv`, json("PUT", datos));
    estado.versionCv = Date.now();
    estado.postulaciones = estado.postulaciones.map((x) => (x.id === p.id ? p : x));
    $("#dlg-cv").close(); pintarDetalle(p); toast("CV guardado y PDF regenerado");
  } catch (e) { toast(e.message); }
  btn.disabled = false;
}

function pintarAts(p) {
  if (!p.ats) return "";
  const a = p.ats;
  const nivel = a.cobertura >= 75 ? "alto" : a.cobertura >= 50 ? "medio" : "bajo";
  const sumadas = a.faltan.filter((k) => yaLoSabe(k));
  return `<div class="seccion ats-${nivel}"><h4>Coincidencia con filtros ATS</h4>
    <div class="ats-cab"><b>${a.cobertura}%</b><div class="barra"><i style="width:${a.cobertura}%"></i></div></div>
    <p class="ayuda" style="margin-bottom:10px">${a.total - a.faltan.length} de ${a.total} palabras clave de la oferta están en el CV.
      ${a.faltan.length ? "Estas faltan: si Caro las sabe, sumalas y el porcentaje sube." : "¡Están todas!"}</p>
    ${a.faltan.length ? `<ul class="filas-accion">${a.faltan.map((k) => `<li class="fila-accion"><span>${esc(k)}</span>${
      yaLoSabe(k) ? `<span class="ya-sumado">✔ Lista para agregar</span>`
                  : `<span class="lo-se-botones"><button class="btn btn-mini" type="button" data-lo-se="${esc(k)}" data-ats="1">Lo sé</button><button class="btn btn-mini" type="button" data-lo-se="${esc(k)}" data-ats="1" data-prueba-antes="1">Hacer prueba</button></span>`}</li>`).join("")}</ul>` : ""}
    ${sumadas.length ? `<div class="aplicar-ats"><span>Hay ${sumadas.length} ${sumadas.length === 1 ? "palabra lista" : "palabras listas"} para sumar. Rehacé el CV para que el ATS las encuentre.</span>
      <button class="btn btn-primario btn-chico" type="button" data-accion="actualizar-cv"><svg class="icono"><use href="#i-rayo"/></svg> Agregar al CV ahora</button></div>` : ""}
  </div>`;
}

async function actualizar(id, cambios, mensaje) {
  try {
    const p = await api(`/api/postulaciones/${id}`, json("PATCH", cambios));
    const i = estado.postulaciones.findIndex((x) => x.id === id);
    estado.postulaciones[i] = p;
    pintarStats(); pintarLista(); pintarDetalle(p);
    if (estado.vista === "enviadas") pintarEnviadas();
    if (mensaje) toast(mensaje);
  } catch (e) { toast(e.message); }
}

// ---------------------------------------------------------------- trabajos del asistente

const TEXTOS_TRABAJO = {
  oferta: { en_cola: "En cola", procesando: "Preparando la postulación…", listo: "¡Postulación lista para revisar!", descartada: "No conviene postular", error: "Algo salió mal" },
  cv: { en_cola: "En cola", procesando: "Actualizando el CV…", listo: "CV actualizado", error: "No se pudo actualizar el CV" },
  plan: { en_cola: "En cola", procesando: "Recalculando qué estudiar…", listo: "Plan de estudio actualizado", error: "No se pudo recalcular" },
  curso: { en_cola: "En cola", procesando: "Analizando el curso…", listo: "Curso guardado", error: "No se pudo guardar el curso" },
  busqueda: { en_cola: "En cola", procesando: "Buscando ofertas nuevas…", listo: "Búsqueda lista: mirá Ofertas encontradas", error: "No se pudo terminar la búsqueda" },
  palabras: { en_cola: "En cola", procesando: "Sumando 50 palabras al diccionario…", listo: "Diccionario más grande", error: "No se pudieron sumar las palabras" },
  palabra: { en_cola: "En cola", procesando: "Completando la palabra…", listo: "Palabra lista para practicar", error: "No se pudo completar la palabra" },
};

async function cargarTrabajos() {
  let d;
  try { d = await api("/api/trabajos"); } catch (e) { return; }
  const antes = new Map((estado.todosTrabajos || []).map((t) => [t.id, t.estado]));
  estado.todosTrabajos = d.trabajos;
  estado.trabajos = d.trabajos.filter((t) => !t.oculto && !["palabras", "palabra", "preguntas"].includes(t.tipo));
  // Nada de avisos sueltos: todo queda en la campanita. Las palabras del diccionario se suman en silencio.
  for (const t of d.trabajos) {
    const previo = antes.get(t.id);
    if (!previo || previo === t.estado || !["en_cola", "procesando"].includes(previo)) continue;
    if (t.tipo === "plan") cargarEstudio();
    if (t.tipo === "curso") cargarCursos();
    if (["palabras", "palabra"].includes(t.tipo) && estado.vista === "diccionario") cargarDiccionario(false);
    if (t.tipo === "busqueda" && estado.vista === "encontradas") cargarEncontradas();
    cargarPostulaciones();
  }
  pintarTrabajos();
  if (estado.vista === "encontradas") marcarPostuladas();
}

function avisosVistos() {
  try { return new Set(JSON.parse(localStorage.getItem("avisosVistos") || "[]")); } catch (e) { return new Set(); }
}

function pintarCampana() {
  const vistos = avisosVistos();
  const activos = estado.trabajos.filter((t) => ["en_cola", "procesando"].includes(t.estado)).length;
  const nuevos = estado.trabajos.filter((t) => !["en_cola", "procesando"].includes(t.estado) && !vistos.has(t.id)).length;
  const badge = $("#campana-badge");
  badge.hidden = !activos && !nuevos;
  badge.textContent = nuevos || "";
  badge.classList.toggle("trabajando", !nuevos && activos > 0);
  $("#btn-campana").setAttribute("aria-label", nuevos ? `Avisos: ${nuevos} nuevos` : "Avisos");
  $("#avisos-vacio").hidden = estado.trabajos.length > 0;
  if (!$("#panel-avisos").hidden) marcarAvisosVistos();
}

function marcarAvisosVistos() {
  const vistos = avisosVistos();
  estado.trabajos.filter((t) => !["en_cola", "procesando"].includes(t.estado)).forEach((t) => vistos.add(t.id));
  try { localStorage.setItem("avisosVistos", JSON.stringify([...vistos].slice(-200))); } catch (e) {}
  const badge = $("#campana-badge");
  if (badge.textContent) { badge.textContent = ""; badge.hidden = !estado.trabajos.some((t) => ["en_cola", "procesando"].includes(t.estado)); badge.classList.add("trabajando"); }
}

function abrirCampana(abrir) {
  $("#panel-avisos").hidden = !abrir;
  $("#btn-campana").setAttribute("aria-expanded", abrir);
  if (abrir) marcarAvisosVistos();
}

function pintarTrabajos() {
  pintarCampana();
  $("#trabajos").innerHTML = estado.trabajos.map((t) => {
    const tipo = t.tipo || "oferta";
    const activo = t.estado === "en_cola" || t.estado === "procesando";
    const seg = Math.round(((t.fin || Date.now() / 1000) - (t.inicio || t.creado)) || 0);
    const tiempo = seg > 0 ? `${Math.floor(seg / 60)}:${String(seg % 60).padStart(2, "0")}` : "";
    return `
    <article class="trabajo ${t.estado}">
      <div class="trabajo-cab">
        ${activo ? `<div class="girando" aria-hidden="true"></div>` : ""}
        <h3>${(TEXTOS_TRABAJO[tipo] || TEXTOS_TRABAJO.oferta)[t.estado] || t.estado}</h3>
        <span class="ayuda">${tiempo}</span>
      </div>
      <p>${esc(t.mensaje || t.vista || "")}</p>
      ${activo && t.pasos && t.pasos.length ? `<ol>${t.pasos.slice(-4).map((p) => `<li>${esc(p)}</li>`).join("")}</ol>` : ""}
      ${!activo ? `<div class="trabajo-acciones">
        ${t.postulacion && t.estado === "listo" ? `<button class="btn btn-primario btn-chico" type="button" data-ver="${esc(t.postulacion)}">Revisar</button>` : ""}
        ${t.estado === "error" ? `<button class="btn btn-primario btn-chico" type="button" data-reintentar-trabajo="${esc(t.id)}">Volver a intentarlo</button>` : ""}
        <button class="btn btn-chico" type="button" data-ocultar="${esc(t.id)}">Borrar</button></div>` : ""}
    </article>`;
  }).join("");
}

function bucleTrabajos() {
  const activo = estado.trabajos.some((t) => t.estado === "en_cola" || t.estado === "procesando");
  setTimeout(async () => { await cargarTrabajos(); bucleTrabajos(); }, activo ? 3000 : 15000);
}

// ---------------------------------------------------------------- nueva oferta

let capturas = [];

function pintarMiniaturas() {
  $("#miniaturas").innerHTML = capturas.map((f, i) => `
    <div class="mini"><img src="${URL.createObjectURL(f)}" alt="Captura ${i + 1}">
      <button type="button" data-quitar="${i}" aria-label="Quitar captura ${i + 1}">✕</button></div>`).join("");
}

function sumarCapturas(lista) {
  capturas = capturas.concat([...lista].filter((f) => f.type.startsWith("image/")));
  pintarMiniaturas();
}

async function mandarOferta({ texto = "", link = "", titulo = "", imagenes = [] }) {
  const datos = new FormData();
  datos.append("texto", texto);
  datos.append("link", link);
  datos.append("titulo", titulo);
  imagenes.forEach((f) => datos.append("capturas", f, f.name || "captura.png"));
  pedirPermisoAvisos();
  await api("/api/ofertas", { method: "POST", body: datos });
  await cargarTrabajos();
}

async function enviarOferta(ev) {
  ev.preventDefault();
  const texto = $("#nueva-texto").value.trim();
  const link = $("#nueva-link").value.trim();
  if (!texto && !capturas.length && !link) { toast("Pegá el texto, subí una captura o poné el link."); return; }
  const btn = $("#btn-procesar");
  btn.disabled = true; btn.textContent = "Preparando postulación…";
  try {
    await mandarOferta({ texto, link, imagenes: capturas });
    $("#form-nueva").reset(); capturas = []; pintarMiniaturas();
    $("#dlg-nueva").close();
    mostrarVista("postulaciones");
    toast("Recibida. Te aviso cuando esté lista, Caro.");
  } catch (e) { toast(e.message); }
  finally { btn.disabled = false; btn.textContent = "Preparar postulación"; }
}

// ---------------------------------------------------------------- mail

function abrirMail(p, para = "") {
  $("#mail-para").value = para || p.correo.para || "";
  $("#mail-asunto").value = p.correo.asunto || `Postulación ${p.puesto}`;
  $("#mail-cuerpo").value = p.carta_texto || "";
  $("#mail-firma").textContent = estado.firma;
  $("#mail-adjuntos").innerHTML = (p.correo.adjuntos || p.pdfs).map((a) => `<span class="chip">📎 ${esc(a.split("/").pop())}</span>`).join("");
  $$("#mail-checklist [data-check]").forEach((c) => (c.checked = false));
  $("#mail-ver-cv").href = p.pdfs[0] ? `/archivos/${encodeURI(p.pdfs[0])}` : "#";
  $("#mail-destino").textContent = `${$("#mail-para").value} — ${p.empresa} (${p.puesto})`;
  $("#mail-requisitos .chips").innerHTML = items(p.requisitos_clave).map((r) => `<span class="chip">${esc(r)}</span>`).join("") || "<span class='ayuda'>Sin requisitos cargados</span>";
  $("#mail-sin-smtp").classList.toggle("oculto", estado.smtp);
  $("#btn-enviar").disabled = true;
  $("#dlg-mail").showModal();
}

async function enviarMail(ev) {
  ev.preventDefault();
  const btn = $("#btn-enviar");
  btn.disabled = true;
  try {
    await api(`/api/postulaciones/${estado.abierta}/enviar`, json("POST", {
      confirmo: todoRevisado(), para: $("#mail-para").value.trim(),
      asunto: $("#mail-asunto").value.trim(), cuerpo: $("#mail-cuerpo").value,
    }));
    $("#dlg-mail").close();
    toast("Mail enviado ✔ — quedó en Pendiente");
    await cargarPostulaciones();
  } catch (e) { toast(e.message); btn.disabled = false; }
}


document.addEventListener("change", (ev) => {
  const sel = ev.target.closest("select[data-estado-rapido]");
  if (sel) {
    sel.className = `estado-rapido st-${sel.value}`;
    actualizar(sel.dataset.estadoRapido, { estado: sel.value }, "Estado actualizado");
  }
});

// ---------------------------------------------------------------- prueba «¿lo sabés?»

const todoRevisado = () => $$("#mail-checklist [data-check]").every((c) => c.checked);

function verificarSaber(tema) {
  return new Promise((resolver) => {
    const dlg = $("#dlg-prueba");
    let preguntas = [], resuelto = false;
    const terminar = (ok) => { if (resuelto) return; resuelto = true; dlg.close(); resolver(ok); };
    const pie = (html) => { $("#prueba-pie").innerHTML = html; };
    $("#prueba-titulo").textContent = "¿Estás seguro que lo sabés?";
    $("#prueba-tema").textContent = `«${tema}» se va a sumar al CV de Caro.`;
    $("#prueba-cuerpo").innerHTML = `<p>Hacé una prueba de 3 casos de entrevista para confirmarlo: hay que acertar al menos 2. Si lo tocaste sin querer, cancelá y no se agrega nada.</p>`;
    pie(`<button class="btn" type="button" data-prueba="cancelar">Cancelar</button>
         <button class="btn btn-primario" type="button" data-prueba="empezar">Hacer prueba</button>`);
    dlg.oncancel = (ev) => { ev.preventDefault(); terminar(false); };
    dlg.onclick = async (ev) => {
      if (ev.target === dlg) return terminar(false);
      const b = ev.target.closest("[data-prueba]");
      if (!b) return;
      const accion = b.dataset.prueba;
      if (accion === "cancelar") return terminar(false);
      if (accion === "listo") return terminar(true);
      if (accion === "empezar") {
        $("#prueba-cuerpo").innerHTML = `<div class="cargando"><div class="girando"></div> Armando la prueba… (unos segundos)</div>`;
        pie(`<button class="btn" type="button" data-prueba="cancelar">Cancelar</button>`);
        try {
          preguntas = (await api("/api/prueba", json("POST", { tema }))).preguntas;
        } catch (e) {
          if (resuelto) return;
          $("#prueba-cuerpo").innerHTML = `<p>${esc(e.message)}</p>`;
          pie(`<button class="btn" type="button" data-prueba="cancelar">Cancelar</button>
               <button class="btn btn-primario" type="button" data-prueba="empezar">Probar de nuevo</button>`);
          return;
        }
        if (resuelto) return;
        $("#prueba-titulo").textContent = `Prueba: ${tema}`;
        $("#prueba-cuerpo").innerHTML = preguntas.map((q, i) => `
          <div class="pregunta"><h3>${i + 1}. ${esc(q.pregunta)}</h3>
            ${q.opciones.map((o, j) => `<label><input type="radio" name="p${i}" value="${j}"> <span>${esc(o)}</span></label>`).join("")}
          </div>`).join("");
        pie(`<button class="btn" type="button" data-prueba="cancelar">Cancelar</button>
             <button class="btn btn-primario" type="button" data-prueba="corregir">Corregir</button>`);
      }
      if (accion === "corregir") {
        if (preguntas.some((_, i) => !$(`#prueba-cuerpo input[name="p${i}"]:checked`))) { toast("Respondé las 3 preguntas"); return; }
        let bien = 0;
        preguntas.forEach((q, i) => {
          const elegida = Number($(`#prueba-cuerpo input[name="p${i}"]:checked`).value);
          if (elegida === q.correcta) bien += 1;
          $$(`#prueba-cuerpo input[name="p${i}"]`).forEach((inp) => {
            inp.disabled = true;
            const l = inp.closest("label"), j = Number(inp.value);
            if (j === q.correcta) l.classList.add("correcta"); else if (j === elegida) l.classList.add("incorrecta");
          });
          $$(".pregunta", $("#prueba-cuerpo"))[i].insertAdjacentHTML("beforeend", `<p class="ayuda">${esc(q.explicacion || "")}</p>`);
        });
        const aprobo = bien >= 2;
        $("#prueba-cuerpo").insertAdjacentHTML("afterbegin", `<div class="resultado ${aprobo ? "bien" : "mal"}">
          <h4>${aprobo ? `¡${bien} de 3! Lo sabés, Caro 💪` : `${bien} de 3: todavía no`}</h4>
          <p>${aprobo ? "Lo sumamos a tu base para el CV." : "Mejor estudialo un poco antes de ponerlo en el CV: en la entrevista te lo pueden preguntar."}</p></div>`);
        $("#prueba-cuerpo").scrollTop = 0;
        pie(aprobo ? `<button class="btn btn-primario" type="button" data-prueba="listo">Agregar al CV</button>`
                   : `<button class="btn" type="button" data-prueba="cancelar">Cerrar</button>`);
      }
    };
    dlg.showModal();
  });
}

// ---------------------------------------------------------------- estudiar y conocimientos

async function cargarEstudio() {
  const [plan, con] = await Promise.all([api("/api/estudio"), api("/api/conocimientos")]);
  estado.plan = plan;
  estado.conocimientos = con.conocimientos;
  estado.tiposConocimiento = con.tipos;
  pintarEstudio();
}

function pintarEstudio() {
  const todos = estado.plan.items || [];
  const pendientes = todos.filter((i) => i.estado !== "certificado");
  const hechos = todos.filter((i) => i.estado === "certificado");
  const pct = todos.length ? Math.round((hechos.length / todos.length) * 100) : 0;
  $("#estudio-criterio").textContent = estado.plan.criterio
    ? `Orden de prioridad: ${estado.plan.criterio}` : "Se arma con lo que piden los puestos a los que se postula.";
  $("#estudio-progreso").innerHTML = `<b>${hechos.length ? `¡Vas ${hechos.length} de ${todos.length}, Caro!` : `Tenés ${todos.length} temas para potenciar tu perfil, Caro`}</b>
    <div class="barra"><i style="width:${pct}%"></i></div>`;

  $("#estudio-lista").innerHTML = pendientes.length ? pendientes.map((it, n) => `
    <li class="tema ${it.estado}">
      <div class="tema-num" aria-label="Prioridad ${n + 1}">${n + 1}</div>
      <h3>${esc(it.tema)}</h3>
      <p>${esc(it.por_que || "")}</p>
      <div class="tema-meta">
        ${it.estado === "estudiando" ? `<span class="pill etiqueta-estudiando">Estudiando</span>` : ""}
        ${(it.puestos || []).map((p) => `<span class="chip">${esc(p.empresa)}</span>`).join("")}
      </div>
      ${it.recurso ? `<p class="recurso" style="grid-column:1/-1;margin-top:6px">📘 ${esc(it.recurso)}</p>` : ""}
      <div class="tema-acciones">
        ${it.estado === "estudiando"
          ? `<button class="btn btn-chico" type="button" data-plan="${esc(it.id)}" data-plan-estado="pendiente">Pausar</button>`
          : `<button class="btn btn-chico" type="button" data-plan="${esc(it.id)}" data-plan-estado="estudiando"><svg class="icono"><use href="#i-gorro"/></svg> Empezar a estudiar</button>`}
        <button class="btn btn-chico" type="button" data-ya-sabia="${esc(it.id)}">Ya lo sabía</button>
        <button class="btn btn-primario btn-chico" type="button" data-certificado="${esc(it.id)}"><svg class="icono"><use href="#i-check"/></svg> ¡Ya tengo certificado!</button>
      </div>
    </li>`).join("")
    : `<li class="vacio"><h3>¡No queda nada pendiente!</h3><p>Cuando se sumen postulaciones nuevas aparecen más temas.</p></li>`;

  $("#estudio-hechos").innerHTML = hechos.length
    ? `<summary>Completados (${hechos.length})</summary><ul>${hechos.map((i) => `<li>${esc(i.tema)}</li>`).join("")}</ul>` : "";

  const tipos = estado.tiposConocimiento || {};
  $("#conocimientos").innerHTML = estado.conocimientos.length
    ? [...estado.conocimientos].reverse().map((c) => `<div class="conocimiento"><b>${esc(c.tema)}</b>
        <span>${esc(tipos[c.tipo] || c.tipo)}${c.institucion ? ` · ${esc(c.institucion)}` : ""}${c.fecha ? ` · ${fecha(c.fecha)}` : ""}</span></div>`).join("")
    : `<p class="ayuda">Todavía no sumaste conocimientos nuevos. Lo que está en el CV maestro ya cuenta.</p>`;
}

function abrirConocimiento({ tema = "", tipo = "certificado", estudioId = "", cursoId = "", institucion = "" } = {}) {
  const f = $("#form-conocimiento");
  f.reset();
  $("#con-tema").value = tema;
  $("#con-estudio").value = estudioId;
  $("#con-curso").value = cursoId;
  $("#con-institucion").value = institucion;
  $(`#con-tipos input[value="${tipo}"]`).checked = true;
  alternarCamposTipo();
  $("#dlg-conocimiento").showModal();
  setTimeout(() => (tema ? (institucion ? $("#con-fecha") : $("#con-institucion")) : $("#con-tema")).focus(), 50);
}

function alternarCamposTipo() {
  const experiencia = $('#con-tipos input:checked').value === "experiencia";
  $("#con-grupo-inst").classList.toggle("oculto", experiencia);
  $("#con-grupo-fecha").classList.toggle("oculto", experiencia);
}

async function guardarConocimiento(datos, { festejar = true, prueba = true } = {}) {
  // Lo que «ya sabe» va directo al CV; con «Hacer prueba», antes una prueba corta para no sumarlo por error.
  if (datos.tipo === "experiencia" && prueba && !(await verificarSaber(datos.tema))) return false;
  const r = await api("/api/conocimientos", json("POST", datos));
  estado.conocimientos.push(r.conocimiento);
  if (festejar) festejo(r.conocimiento, r.total);
  else toast(`${prueba ? "¡Aprobado! " : ""}Sumado a la base de Caro: ${r.conocimiento.tema}`);
  if (estado.vista === "estudiar") cargarEstudio();
  if (estado.abierta && $("#dlg-detalle").open) {
    const p = estado.postulaciones.find((x) => x.id === estado.abierta);
    if (p) pintarDetalle(p);
  }
}

async function enviarConocimiento(ev) {
  ev.preventDefault();
  const tipo = $('#con-tipos input:checked').value;
  try {
    const guardado = await guardarConocimiento({
      tema: $("#con-tema").value.trim(), tipo,
      institucion: tipo === "experiencia" ? "" : $("#con-institucion").value.trim(),
      fecha: tipo === "experiencia" ? "" : $("#con-fecha").value,
      detalle: $("#con-detalle").value.trim(), estudio_id: $("#con-estudio").value, curso_id: $("#con-curso").value,
    });
    if (guardado === false) return;
    if ($("#con-curso").value) cargarCursos();
    $("#dlg-conocimiento").close();
  } catch (e) { toast(e.message); }
}

function festejo(c, total) {
  $("#festejo-texto").textContent = `«${c.tema}» ya está en tu base (${total} ${total === 1 ? "conocimiento nuevo" : "conocimientos nuevos"}). Lo vamos a usar en los próximos CV. Para sumarlo a una postulación ya armada, abrila y tocá «Actualizar CV».`;
  $("#dlg-festejo").showModal();
  confeti();
}

function confeti() {
  const canvas = $("#confeti");
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const ctx = canvas.getContext("2d");
  const W = (canvas.width = canvas.offsetWidth * devicePixelRatio);
  const H = (canvas.height = canvas.offsetHeight * devicePixelRatio);
  const colores = ["#3a5bd9", "#f5c451", "#5fd68a", "#a78bda", "#ff8a80", "#7b97ff"];
  const piezas = Array.from({ length: 140 }, () => ({
    x: W / 2, y: H * 0.35, vx: (Math.random() - 0.5) * 18 * devicePixelRatio, vy: (-Math.random() * 16 - 4) * devicePixelRatio,
    r: (4 + Math.random() * 5) * devicePixelRatio, c: colores[(Math.random() * colores.length) | 0], a: Math.random() * 6, va: (Math.random() - 0.5) * 0.4,
  }));
  const inicio = performance.now();
  (function cuadro(t) {
    ctx.clearRect(0, 0, W, H);
    piezas.forEach((p) => {
      p.vy += 0.45 * devicePixelRatio; p.vx *= 0.99; p.x += p.vx; p.y += p.vy; p.a += p.va;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.a); ctx.fillStyle = p.c; ctx.fillRect(-p.r / 2, -p.r / 4, p.r, p.r / 2); ctx.restore();
    });
    if (t - inicio < 2600 && $("#dlg-festejo").open) requestAnimationFrame(cuadro); else ctx.clearRect(0, 0, W, H);
  })(inicio);
}


// ---------------------------------------------------------------- cursos

let cursoCapturas = [];

async function cargarCursos() {
  const d = await api("/api/cursos");
  estado.cursos = d.items;
  estado.config = d.config;
  pintarCursos();
}

const pesos = (n) => "$" + Math.round(n).toLocaleString("es-AR");
const dinero = (moneda, monto) => moneda === "ARS" ? pesos(monto) : `${moneda} ${Number(monto).toLocaleString("es-AR")}`;

function tasaArs(moneda) {
  const cfg = estado.config || {};
  if (moneda === "ARS") return 1;
  if (moneda === "USD") return Number(cfg.dolar_oficial_venta) || 0;
  return Number((cfg.tasas_ars || {})[moneda]) || 0;
}

function precioCurso(c) {
  const p = c.precio;
  if (!p) return c.costo ? `<span class="chip">${esc(c.costo)}</span>` : "";
  if (p.gratis) return `<span class="precio gratis">¡GRATIS!</span>`;
  if (p.monto == null) return `<span class="precio pago">Pago · precio a confirmar</span>`;
  const tasa = tasaArs(p.moneda);
  // Lo que más importa es cuánto sale en pesos: va grande; la moneda original, al lado.
  const monto = (m) => p.moneda === "ARS" ? pesos(m)
    : tasa ? `${pesos(m * tasa)} <small>(${dinero(p.moneda, m)})</small>` : `${dinero(p.moneda, m)} <small>(conversión a confirmar)</small>`;
  const periodo = p.periodo === "mes" ? " por mes" : p.cuotas && p.cuotas.monto ? " en un pago" : "";
  let html = `<span class="precio pago">${monto(p.monto)}${periodo}</span>`;
  const q = p.cuotas;
  if (q && q.monto) {
    const inicial = q.inicial ? `inscripción + 1ª cuota ${monto(q.inicial)} y ` : "";
    html += `<span class="precio cuotas">o en cuotas: ${inicial}${q.cantidad ? `${q.cantidad} cuotas` : "cuotas"} de ${monto(q.monto)}</span>`;
  }
  return html;
}

function datosCurso(c) {
  return precioCurso(c) + [c.plataforma, c.duracion, c.certificado && (c.certificado === true ? "Con certificado" : c.certificado)]
    .filter(Boolean).map((d) => `<span class="chip">${esc(d)}</span>`).join("");
}

function notaPrecio(c) {
  const p = c.precio || {};
  const dolar = (estado.config || {}).dolar_oficial_venta;
  const partes = [];
  if (p.moneda === "USD" && !p.gratis && dolar) partes.push(`En pesos, al dólar oficial de ${pesos(dolar)}.`);
  else if (p.moneda && !["USD", "ARS"].includes(p.moneda) && !p.gratis && tasaArs(p.moneda)) partes.push(`Convertido a pesos a ${tasaArs(p.moneda)} ARS por ${p.moneda}.`);
  if (p.detalle) partes.push(p.detalle);
  return partes.length ? `<p class="ayuda">💳 ${esc(partes.join(" "))}</p>` : "";
}

function pintarCursos() {
  const todos = estado.cursos || [];
  const activos = todos.filter((c) => c.estado !== "terminado");
  const hechos = todos.filter((c) => c.estado === "terminado");
  const cont = $("#cursos");
  if (!todos.length) {
    cont.innerHTML = `<div class="vacio"><h3>Todavía no hay cursos guardados</h3>
      <p>Tocá <b>Guardar curso</b> y pegá el link o una captura. El asistente te cuenta de qué se trata y para qué te sirve.</p></div>`;
    return;
  }
  const actual = activos[0];
  const pct = Math.round((hechos.length / todos.length) * 100);
  const cfg = estado.config || {};
  cont.innerHTML = `
    <p class="dolar">Dólar oficial (venta): <b>${cfg.dolar_oficial_venta ? pesos(cfg.dolar_oficial_venta) : "—"}</b>
      ${cfg.dolar_fecha ? `<span class="ayuda">· actualizado ${fecha(cfg.dolar_fecha)}</span>` : ""}
      <button class="btn btn-mini" type="button" data-dolar>Actualizar</button></p>
    <div class="estudio-progreso"><b>${hechos.length ? `¡Terminaste ${hechos.length} de ${todos.length} cursos, Caro!` : `Tenés ${todos.length} ${todos.length === 1 ? "curso" : "cursos"} para hacer, Caro`}</b>
      <div class="barra"><i style="width:${pct}%"></i></div></div>
    ${actual ? `
    <article class="curso-actual">
      <span class="curso-etiqueta">${actual.estado === "en_curso" ? "Lo estás haciendo" : "Tu próximo curso"}</span>
      <h3>${esc(actual.nombre)}</h3>
      <div class="curso-datos">${datosCurso(actual)}</div>
      ${notaPrecio(actual)}
      ${actual.descripcion ? `<p>${esc(actual.descripcion)}</p>` : ""}
      ${actual.para_que ? `<p class="para-que"><b>Para qué te sirve:</b> ${esc(actual.para_que)}</p>` : ""}
      ${actual.motivacion ? `<p class="motivacion">${esc(actual.motivacion)}</p>` : ""}
      <div class="curso-acciones">
        ${actual.link ? `<a class="btn" href="${esc(actual.link)}" target="_blank" rel="noopener"><svg class="icono"><use href="#i-link"/></svg> Ir al curso</a>` : ""}
        ${actual.estado === "en_curso" ? "" : `<button class="btn" type="button" data-curso="${esc(actual.id)}" data-curso-estado="en_curso"><svg class="icono"><use href="#i-libro"/></svg> Empezar</button>`}
        <button class="btn btn-primario" type="button" data-curso-fin="${esc(actual.id)}"><svg class="icono"><use href="#i-check"/></svg> ¡Lo terminé!</button>
      </div>
      <button class="btn btn-mini" type="button" data-curso-quitar="${esc(actual.id)}" style="justify-self:start">Quitar de la lista</button>
    </article>` : `<div class="vacio" style="margin-bottom:18px"><h3>¡Terminaste todos los cursos! 🎓</h3><p>Guardá uno nuevo para seguir creciendo.</p></div>`}
    ${activos.length > 1 ? `<h2 style="font-size:16px;margin:0 0 10px">Después</h2>
    <ol class="cursos-siguientes">${activos.slice(1).map((c, i) => `
      <li class="curso">
        <div class="tema-num">${i + 2}</div>
        <h3>${esc(c.nombre)}</h3>
        <div class="curso-datos">${datosCurso(c)}</div>
        ${notaPrecio(c)}
        ${c.descripcion ? `<p class="ayuda">${esc(c.descripcion)}</p>` : ""}
        ${c.motivacion ? `<p class="motivacion">${esc(c.motivacion)}</p>` : ""}
        <div class="curso-acciones">
          ${c.link ? `<a class="btn btn-chico" href="${esc(c.link)}" target="_blank" rel="noopener">Ver curso</a>` : ""}
          <button class="btn btn-chico" type="button" data-curso="${esc(c.id)}" data-curso-estado="en_curso">Hacer este ahora</button>
          <button class="btn btn-chico" type="button" data-curso-quitar="${esc(c.id)}">Quitar</button>
        </div>
      </li>`).join("")}</ol>` : ""}
    ${hechos.length ? `<details class="seccion-plegable"><summary>Terminados (${hechos.length})</summary>
      <ul>${hechos.map((c) => `<li>${esc(c.nombre)}${c.plataforma ? ` · ${esc(c.plataforma)}` : ""}</li>`).join("")}</ul></details>` : ""}`;
}

function pintarCursoMiniaturas() {
  $("#curso-miniaturas").innerHTML = cursoCapturas.map((f, i) => `
    <div class="mini"><img src="${URL.createObjectURL(f)}" alt="Captura ${i + 1}">
      <button type="button" data-quitar="${i}" aria-label="Quitar captura ${i + 1}">✕</button></div>`).join("");
}

async function guardarCurso(ev) {
  ev.preventDefault();
  const link = $("#curso-link").value.trim(), texto = $("#curso-texto").value.trim();
  if (!link && !texto && !cursoCapturas.length) { toast("Pegá el link, una descripción o una captura."); return; }
  const datos = new FormData();
  datos.append("link", link); datos.append("texto", texto);
  cursoCapturas.forEach((f) => datos.append("capturas", f, f.name || "captura.png"));
  const btn = $("#btn-guardar-curso");
  btn.disabled = true;
  try {
    await api("/api/cursos", { method: "POST", body: datos });
    pedirPermisoAvisos();
    $("#form-curso").reset(); cursoCapturas = []; pintarCursoMiniaturas();
    $("#dlg-curso").close();
    toast("Analizando el curso. Te aviso cuando esté, Caro.");
    await cargarTrabajos();
  } catch (e) { toast(e.message); }
  finally { btn.disabled = false; }
}

// ---------------------------------------------------------------- diccionario PM (juego)

const juego = { palabras: [], progreso: {}, stats: null, repaso: [], ultima: null, actual: null };
const ELOGIOS = ["¡Sos una Project Manager excelente! 🏆", "¡Excelente, Caro! Hablás como una PM de verdad 💼", "¡Bien ahí! Ese término ya es tuyo ✨"];

async function cargarDiccionario(reiniciar = true) {
  const d = await api("/api/diccionario");
  juego.palabras = d.palabras;
  juego.progreso = d.progreso;
  juego.stats = d.juego;
  if (!juego.repaso.length) try { juego.repaso = JSON.parse(localStorage.getItem("repasoDiccionario") || "[]"); } catch (e) {}
  pintarGlosario();
  pintarStatsJuego();
  if (reiniciar || !juego.actual) nuevaPregunta();
}

const jugables = () => juego.palabras.filter((p) => p.significado);
const caja = (id) => (juego.progreso[id] || {}).caja || 0;

function elegirPalabra() {
  const lista = jugables();
  if (!lista.length) return null;
  juego.repaso.forEach((r) => (r.en -= 1));
  const toca = juego.repaso.findIndex((r) => r.en <= 0);
  if (toca >= 0) {
    const [r] = juego.repaso.splice(toca, 1);
    const p = lista.find((x) => x.id === r.id);
    if (p) return { palabra: p, verificando: r.motivo };
  }
  const pesos = lista.map((p) => (p.id === juego.ultima ? 0 : juego.progreso[p.id] ? (6 - caja(p.id)) ** 2 : 12));
  let r = Math.random() * pesos.reduce((a, b) => a + b, 0);
  const i = pesos.findIndex((w) => (r -= w) < 0);
  return { palabra: lista[i >= 0 ? i : 0], verificando: null };
}

function mezclar(arr) { for (let i = arr.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [arr[i], arr[j]] = [arr[j], arr[i]]; } return arr; }

function armarOpciones(p, inverso) {
  const otras = jugables().filter((x) => x.id !== p.id);
  const mismas = mezclar(otras.filter((x) => x.categoria === p.categoria));
  const distractores = mismas.concat(mezclar(otras.filter((x) => x.categoria !== p.categoria))).slice(0, 2);
  return mezclar([p, ...distractores]).map((x) => ({ id: x.id, texto: inverso ? x.termino : x.significado }));
}

function nuevaPregunta(repetir = null) {
  const elegido = repetir ? { palabra: repetir, verificando: "reintento" } : elegirPalabra();
  if (!elegido) {
    $("#juego").innerHTML = `<div class="vacio"><h3>No hay palabras todavía</h3><p>Agregá la primera con el botón de arriba.</p></div>`;
    return;
  }
  const p = elegido.palabra;
  const inverso = !repetir && caja(p.id) >= 2 && Math.random() < 0.35;
  juego.actual = { palabra: p, inverso, opciones: armarOpciones(p, inverso), verificando: elegido.verificando };
  juego.ultima = p.id;
  const aviso = elegido.verificando === "verificar" ? `<span class="pill etiqueta-estudiando">¿La sabías o adivinaste? 🤔</span>`
    : elegido.verificando === "repasar" ? `<span class="pill" style="color:var(--st-pendiente);background:var(--st-pendiente-bg)">Repaso</span>`
    : elegido.verificando === "reintento" ? `<span class="pill" style="color:var(--st-pendiente);background:var(--st-pendiente-bg)">Segundo intento</span>` : "";
  $("#juego").innerHTML = `
    <div class="juego-cab"><span class="chip">${esc(p.categoria || "Mis palabras")}</span>${aviso}</div>
    <p class="juego-pregunta">${inverso ? "¿Qué palabra en inglés significa esto?" : "¿Qué significa…"}</p>
    <div class="juego-termino ${inverso ? "inverso" : ""}">
      <h3>${esc(inverso ? p.significado : p.termino)}</h3>
      ${inverso ? "" : `<button class="btn btn-icono" type="button" data-hablar="${esc(p.termino)}" aria-label="Escuchar cómo se pronuncia"><svg class="icono"><use href="#i-audio"/></svg></button>
        ${p.pronunciacion ? `<button class="pronuncia" type="button" data-hablar="${esc(p.termino)}">Se pronuncia «${esc(p.pronunciacion)}» 🔊</button>` : ""}`}
    </div>
    <div class="opciones">${juego.actual.opciones.map((o, i) => `
      <button class="opcion" type="button" data-opcion="${esc(o.id)}"><b>${"ABC"[i]}</b><span>${esc(o.texto)}</span></button>`).join("")}</div>
    <div id="juego-resultado"></div>`;
}

async function responder(idElegido, boton) {
  const { palabra: p, inverso, verificando } = juego.actual;
  const bien = idElegido === p.id;
  $$(".opcion").forEach((b) => {
    b.disabled = true;
    if (b.dataset.opcion === p.id) b.classList.add("correcta");
  });
  if (!bien) boton.classList.add("incorrecta");
  const antes = caja(p.id);
  try {
    const r = await api(`/api/diccionario/${p.id}/respuesta`, json("POST", { correcta: bien }));
    juego.progreso[p.id] = r.palabra; juego.stats = r.juego;
  } catch (e) {}

  if (bien) {
    // Si la acertó de primera, se la vuelvo a preguntar más adelante para ver si la sabía o adivinó.
    if (antes === 0 && verificando !== "verificar" && !juego.repaso.some((r) => r.id === p.id)) juego.repaso.push({ id: p.id, en: 4 + ((Math.random() * 3) | 0), motivo: "verificar" });
  } else {
    if (!juego.repaso.some((r) => r.id === p.id)) juego.repaso.push({ id: p.id, en: 3, motivo: "repasar" });
  }
  pintarStatsJuego();
  try { localStorage.setItem("repasoDiccionario", JSON.stringify(juego.repaso)); } catch (e) {}
  const elegidaTexto = !bien && inverso ? juego.palabras.find((x) => x.id === idElegido)?.termino : "";
  $("#juego-resultado").innerHTML = bien ? `
    <div class="resultado bien">
      <h4>${ELOGIOS[(Math.random() * ELOGIOS.length) | 0]}</h4>
      <p><b>${esc(p.termino)}</b>: ${esc(p.significado)}</p>
      ${p.ejemplo ? `<p>${esc(p.ejemplo)}</p>` : ""}
      ${verificando === "verificar" ? `<p>✔ Confirmado: no fue suerte, ¡la sabés!</p>` : ""}
      ${preguntasEntrevista(p)}
      <div class="resultado-acciones"><button class="btn btn-primario" type="button" data-siguiente>Siguiente palabra →</button></div>
    </div>` : `
    <div class="resultado mal">
      <h4>Tenés que repasar 📚</h4>
      ${elegidaTexto ? `<p>Elegiste «${esc(elegidaTexto)}», pero la respuesta era «${esc(p.termino)}».</p>` : ""}
      <p>Recordá que <b>«${esc(p.termino)}»</b> en criollo argentino es ${esc(p.criollo || `«${p.significado}»`)}${p.por_que ? `, pero en el área empresarial se dice así porque ${esc(p.por_que.charAt(0).toLowerCase() + p.por_que.slice(1))}` : "."}</p>
      ${p.ejemplo ? `<p>Ejemplo: ${esc(p.ejemplo)}</p>` : ""}
      ${preguntasEntrevista(p)}
      <p><b>¡Volvé a intentarlo!</b> Te la vuelvo a preguntar en un ratito.</p>
      <div class="resultado-acciones">
        <button class="btn btn-primario" type="button" data-reintentar>Volver a intentarlo</button>
        <button class="btn" type="button" data-siguiente>Siguiente palabra</button>
      </div>
    </div>`;
  $("#juego-resultado [data-siguiente], #juego-resultado [data-reintentar]")?.focus();
}

function preguntasEntrevista(p) {
  const qs = p.preguntas_entrevista || (p.pregunta_entrevista ? [p.pregunta_entrevista] : []);
  if (!qs.length) return "";
  return `<div class="entrevista">🎤 <b>Te pueden preguntar en la entrevista:</b>
    <ol>${qs.map((q) => `<li>${esc(q)}</li>`).join("")}</ol></div>`;
}

function pintarStatsJuego() {
  const lista = jugables();
  const dominadas = lista.filter((p) => caja(p.id) >= 3).length;
  const s = { racha: 0, mejor_racha: 0, aciertos_hoy: 0, jugadas_hoy: 0, aciertos_total: 0, jugadas_total: 0, ...(juego.stats || {}) };
  $("#juego-stats").innerHTML = `
    <div class="stat"><b>${dominadas}/${lista.length}</b><span>Palabras dominadas</span></div>
    <div class="stat"><b>${s.racha}${s.racha >= 3 ? " 🔥" : ""}</b><span>Racha (récord ${s.mejor_racha})</span></div>
    <div class="stat"><b>${s.aciertos_hoy}/${s.jugadas_hoy}</b><span>Aciertos hoy</span></div>
    <div class="stat"><b>${s.aciertos_total}/${s.jugadas_total}</b><span>Aciertos en total</span></div>`;
}

function pintarGlosario() {
  const q = normal($("#buscar-palabra").value);
  const lista = [...juego.palabras].sort((a, b) => a.termino.localeCompare(b.termino))
    .filter((p) => !q || normal(`${p.termino} ${p.significado} ${p.criollo || ""}`).includes(q));
  $("#glosario-titulo").textContent = `Ver todas las palabras (${juego.palabras.length})`;
  $("#glosario").innerHTML = lista.map((p) => {
    const c = caja(p.id);
    return `<div class="palabra">
      <div class="palabra-cab"><b>${esc(p.termino)}</b>
        ${p.origen === "propia" ? `<span class="nueva">Tuya</span>` : ""}
        ${p.completando ? `<span class="girando" title="El asistente la está completando"></span>` : `<span class="nivel" title="Nivel ${c} de 5">${"●".repeat(c)}${"○".repeat(5 - c)}</span>`}
        <button class="btn btn-icono btn-mini" type="button" data-hablar="${esc(p.termino)}" aria-label="Escuchar ${esc(p.termino)}"><svg class="icono"><use href="#i-audio"/></svg></button>
      </div>
      ${p.pronunciacion ? `<p>«${esc(p.pronunciacion)}»</p>` : ""}
      <p>${esc(p.significado || "El asistente la está completando…")}</p>
      ${p.criollo ? `<p>En criollo: ${esc(p.criollo)}</p>` : ""}
      ${p.nota ? `<p>📝 ${esc(p.nota)}</p>` : ""}
    </div>`;
  }).join("") || `<p class="ayuda">No hay palabras con esa búsqueda.</p>`;
}

// La voz es la del navegador: no depende de ningún servicio externo.
function hablar(texto) {
  if (!("speechSynthesis" in window) || !speechSynthesis.getVoices().length) { toast("Este navegador no tiene voz en inglés para leer la palabra."); return; }
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(texto);
  u.lang = "en-US"; u.rate = 0.85;
  const voz = speechSynthesis.getVoices().find((v) => v.lang && v.lang.startsWith("en"));
  if (voz) u.voice = voz;
  speechSynthesis.speak(u);
}

async function agregarPalabra(ev) {
  ev.preventDefault();
  try {
    const r = await api("/api/diccionario", json("POST", {
      termino: $("#palabra-termino").value.trim(), significado: $("#palabra-significado").value.trim(),
      ejemplo: $("#palabra-ejemplo").value.trim(), completar: $("#palabra-completar").checked,
    }));
    $("#form-palabra").reset();
    $("#dlg-palabra").close();
    juego.palabras.push(r.palabra);
    pintarGlosario(); pintarStatsJuego();
    toast(r.palabra.completando ? `¡Bien, Caro! «${r.palabra.termino}» se suma al juego en un ratito` : `¡«${r.palabra.termino}» ya está en el juego!`);
    if (r.palabra.completando) cargarTrabajos();
  } catch (e) { toast(e.message); }
}

// ---------------------------------------------------------------- ofertas encontradas

async function cargarBusqueda() {
  const cfg = await api("/api/config");
  const b = cfg.busqueda_diaria || { activa: true, hora: "09:00" };
  $("#busqueda-activa").checked = b.activa !== false;
  $("#busqueda-hora").value = b.hora || "09:00";
  $("#busqueda-info").textContent = (b.activa !== false
    ? `El asistente busca ofertas nuevas solo, todos los días a las ${b.hora || "09:00"} (si la compu está apagada, apenas se prenda la plataforma).`
    : "La búsqueda automática está apagada.") + (b.ultima ? ` Última: ${b.ultima}.` : "");
}

async function configurarBusqueda(cambios) {
  try { await api("/api/busqueda", json("PATCH", cambios)); await cargarBusqueda(); toast("Búsqueda diaria actualizada"); }
  catch (e) { toast(e.message); }
}

// Ofertas mandadas a preparar (se guardan en el navegador para que no vuelvan a aparecer al recargar).
function marcarPreparando(clave, si) {
  estado.preparando ||= new Set(leerPreparando());
  si ? estado.preparando.add(clave) : estado.preparando.delete(clave);
  try { localStorage.setItem("ofertasPreparando", JSON.stringify([...estado.preparando])); } catch (e) {}
}
function leerPreparando() {
  try { return JSON.parse(localStorage.getItem("ofertasPreparando") || "[]"); } catch (e) { return []; }
}

// De «qué calza / qué falta» muestra sólo lo que falta (la brecha que puede hacer rebotar el CV).
function soloBrecha(texto) {
  // Sin brechas (vacío, «ninguna» o el aviso de que cumple todo) → mensaje positivo.
  if (/cumpl[íi]s con todo/i.test(texto)) return texto;
  if (!texto.trim() || /brechas?:?\*{0,2}\s*(ninguna|no hay|—|-)\s*(\.|\||$)/i.test(texto)) return "**¡Cumplís con todo, postulate!**";
  const i = texto.search(/\*{0,2}brechas?\b/i);
  return i >= 0 ? texto.slice(i) : texto;
}

const enLinea = (md) => window.marked && window.DOMPurify ? DOMPurify.sanitize(marked.parseInline(md || "")) : esc(md);

// Lee todas las tablas de ofertas_encontradas.md y las junta en una sola lista (sin repetir por link).
function leerOfertas(md) {
  const filas = [], vistos = new Set();
  let descartadasAsistente = 0, enDescartadas = false;
  const lineas = (md || "").split("\n");
  for (let n = 0; n < lineas.length; n++) {
    const l = lineas[n].trim();
    if (/^#/.test(l)) { enDescartadas = /descartad/i.test(l); continue; }
    if (enDescartadas && /^[-*] /.test(l)) { descartadasAsistente += 1; continue; }
    const tot = l.match(/^descartadas:\s*(\d+)/i);
    if (tot) { descartadasAsistente += Number(tot[1]); continue; }
    if (!l.startsWith("|") || !/^\|[\s|:-]+\|$/.test((lineas[n + 1] || "").trim())) continue;
    const cab = l.split("|").slice(1, -1).map((c) => c.trim().toLowerCase());
    n += 2;
    for (; n < lineas.length && lineas[n].trim().startsWith("|"); n++) {
      const celdas = lineas[n].trim().split("|").slice(1, -1).map((c) => c.trim());
      const f = Object.fromEntries(cab.map((c, i) => [c, celdas[i] || ""]));
      const link = (f.link || "").match(/\((https?:[^)\s]+)\)/)?.[1] || (f.link || "").match(/https?:\/\/[^\s|)]+/)?.[0] || "";
      const clave = link || `${f.puesto}|${f.empresa}`;
      if (vistos.has(clave)) continue;
      vistos.add(clave);
      filas.push({ ...f, link, clave, puntaje: Number(f.puntaje) || 0 });
    }
    n -= 1;
  }
  filas.sort((a, b) => b.puntaje - a.puntaje);
  return { filas, descartadasAsistente };
}

function encaje(puntaje) {
  if (!puntaje) return `<span class="pill encaje-medio">—</span>`;
  return puntaje >= 70 ? `<span class="pill encaje-alto">Alto</span>`
    : puntaje >= 50 ? `<span class="pill encaje-medio">Medio</span>` : `<span class="pill encaje-bajo">Bajo</span>`;
}

function postulacionDe(link) {
  if (!link) return null;
  const base = link.split("?")[0];
  return estado.postulaciones.find((p) => p.link_oferta && (p.link_oferta === link || p.link_oferta.includes(base) || link.includes(p.link_oferta))) || null;
}

function tablaOfertas(filas, accion) {
  return `<div class="tabla-wrap"><table class="tabla tabla-ofertas">
    <thead><tr>${accion ? '<th class="col-accion">Acción</th>' : ""}<th class="col-encaje">Encaje</th><th class="col-puesto">Puesto</th><th>Empresa</th><th>País</th><th>Modalidad</th><th>Idioma</th><th>Salario</th><th>Publicada</th><th class="col-larga">Qué te falta</th></tr></thead>
    <tbody>${filas.map((f) => `<tr class="${accion && (estado.enCurso?.has(f.clave) || (f.link && estado.enCurso?.has(f.link))) ? "fila-preparando" : ""}">
      ${accion ? `<td class="celda-accion" data-link="${esc(f.link)}" data-clave="${esc(f.clave)}" data-titulo="${esc(`${f.puesto} — ${f.empresa}`)}"
          data-texto="${esc(Object.values(f).join(" | "))}">${accion(f)}</td>` : ""}
      <td data-et="Encaje">${encaje(f.puntaje)}</td>
      <td data-et="Puesto"><b>${!accion && postulacionDe(f.link)
        ? `<a href="#" data-abrir-post="${esc(postulacionDe(f.link).id)}">${enLinea(f.puesto)}</a>`
        : f.link ? `<a href="${esc(f.link)}" target="_blank" rel="noopener">${enLinea(f.puesto)}</a>` : enLinea(f.puesto)}</b></td>
      <td data-et="Empresa">${enLinea(f.empresa)}</td>
      <td data-et="País">${enLinea(f["país"] || f.pais || "—")}</td>
      <td data-et="Modalidad">${enLinea(f.modalidad)}</td>
      <td data-et="Idioma">${enLinea(f.idioma)}</td>
      <td data-et="Salario">${enLinea(f.salario || "no dice")}</td>
      <td data-et="Publicada">${enLinea(f.publicada || f.fecha || "")}</td>
      <td data-et="Qué te falta" class="celda-larga">${enLinea(soloBrecha(f["qué falta y tip"] || f["encaje / brecha"] || f["por qué encaja / qué falta"] || ""))}</td>
    </tr>`).join("")}</tbody></table></div>`;
}

async function cargarEncontradas() {
  cargarBusqueda().catch(() => {});
  estado.ofertasDatos = await api("/api/ofertas-encontradas");
  pintarEncontradas();
}

function pintarEncontradas() {
  const d = estado.ofertasDatos;
  if (!d) return;
  const cont = $("#encontradas");
  const { filas, descartadasAsistente } = leerOfertas(d.markdown);
  filas.sort((a, b) => b.puntaje - a.puntaje);
  const mias = d.descartadas || {};
  if (!filas.length) {
    $('[data-vista="encontradas"]').textContent = "Ofertas encontradas (0)";
    cont.innerHTML = `<div class="vacio"><h3>Sin búsquedas todavía</h3><p>Tocá «Buscar ahora» y el asistente busca ofertas nuevas.</p></div>`;
    return;
  }
  const enCurso = new Set(estado.trabajos.filter((t) => ["en_cola", "procesando"].includes(t.estado)).map((t) => t.link).filter(Boolean));
  (estado.preparando ||= new Set(leerPreparando())).forEach((c) => enCurso.add(c));
  estado.enCurso = enCurso;
  const visibles = filas.filter((f) => !mias[f.clave]);
  const preparadas = visibles.filter((f) => postulacionDe(f.link));
  // Las que se mandaron a preparar salen del cuadro: el aviso de que están listas llega a la campanita.
  const nuevas = visibles.filter((f) => !postulacionDe(f.link) && !enCurso.has(f.clave) && !(f.link && enCurso.has(f.link)));
  const tab = $('[data-vista="encontradas"]');
  if (tab) tab.textContent = `Ofertas encontradas (${nuevas.length})`;
  const descartadas = Object.entries(mias).map(([link, x]) => {
    const f = filas.find((o) => o.clave === link);
    return f ? { ...f } : { link: /^https?:/.test(link) ? link : "", clave: link, puesto: x.titulo || link, empresa: "", puntaje: 0 };
  });
  cont.innerHTML = `
    <section class="bloque-ofertas"><h2>Ofertas encontradas (${nuevas.length})</h2>
      ${nuevas.length ? tablaOfertas(nuevas, (f) => (f.link && enCurso.has(f.link)) || enCurso.has(f.clave)
        ? `<div class="preparando-oferta" role="status"><div class="girando"></div><span>Preparando tu postulación…</span></div>`
        : `<button class="btn btn-chico" type="button" data-descartar>Descartar</button>
           <button class="btn btn-primario btn-chico" type="button" data-postularme>Postularme</button>`)
        : `<p class="ayuda">No hay ofertas nuevas sin revisar. Tocá «Buscar ahora» para buscar más.</p>`}
    </section>
    <section class="bloque-ofertas"><h2>Ofertas preparadas (${preparadas.length})</h2>
      ${preparadas.length ? tablaOfertas(preparadas, null)
        : `<p class="ayuda">Todavía no preparaste ninguna de esta lista.</p>`}
    </section>
    ${descartadas.length ? `<section class="bloque-ofertas"><h2>Las que descartamos (${descartadas.length})</h2>
      ${tablaOfertas(descartadas, (f) => `<button class="btn btn-chico" type="button" data-recuperar="${esc(f.clave)}">Recuperar</button>`)}
    </section>` : ""}
    ${descartadasAsistente ? `<p class="ayuda conteo-descartadas">El asistente revisó y descartó ${descartadasAsistente} ${descartadasAsistente === 1 ? "aviso" : "avisos"} más (en inglés, híbridos, sueldo bajo, etc.).</p>` : ""}`;
}

function marcarPostuladas() {
  const firma = JSON.stringify([estado.postulaciones.map((p) => p.link_oferta + p.estado_clave),
    estado.trabajos.filter((t) => ["en_cola", "procesando"].includes(t.estado)).map((t) => t.link)]);
  if (firma !== estado.firmaOfertas) { estado.firmaOfertas = firma; pintarEncontradas(); }
}

// ---------------------------------------------------------------- eventos

function iniciar() {
  aplicarTema(document.documentElement.dataset.theme === "dark" ? "dark" : "light");
  $("#btn-tema").addEventListener("click", () =>
    aplicarTema(document.documentElement.dataset.theme === "dark" ? "light" : "dark"));

  $$("[data-abrir-nueva]").forEach((b) => b.addEventListener("click", () => $("#dlg-nueva").showModal()));
  $$("[data-abrir-conocimiento]").forEach((b) => b.addEventListener("click", () => abrirConocimiento()));
  $$("[data-cerrar]").forEach((b) => b.addEventListener("click", () => b.closest("dialog").close()));
  $$("dialog").forEach((d) => d.addEventListener("click", (ev) => { if (ev.target === d) d.close(); }));
  $("#dlg-detalle").addEventListener("close", () => { estado.abierta = null; estado.editandoCarta = false; });

  $$(".tab").forEach((t) => t.addEventListener("click", () => mostrarVista(t.dataset.vista)));
  $("#btn-campana").addEventListener("click", (ev) => { ev.stopPropagation(); abrirCampana($("#panel-avisos").hidden); });
  document.addEventListener("click", (ev) => { if (ev.target.isConnected && !ev.target.closest(".campana-cont, dialog") && !$("#panel-avisos").hidden) abrirCampana(false); });
  document.addEventListener("keydown", (ev) => { if (ev.key === "Escape" && !$("#panel-avisos").hidden) abrirCampana(false); });
  $("#btn-limpiar-avisos").addEventListener("click", async () => {
    const terminados = estado.trabajos.filter((t) => !["en_cola", "procesando"].includes(t.estado));
    await Promise.all(terminados.map((t) => api(`/api/trabajos/${t.id}`, { method: "DELETE" }).catch(() => {})));
    cargarTrabajos();
  });
  $$(".area").forEach((b) => b.addEventListener("click", () => mostrarVista(b.dataset.area === "estudio" ? "estudiar" : "postulaciones")));
  $("#busqueda-activa").addEventListener("change", (ev) => configurarBusqueda({ activa: ev.target.checked }));
  $("#busqueda-hora").addEventListener("change", (ev) => configurarBusqueda({ hora: ev.target.value }));
  $("#btn-buscar-ahora").addEventListener("click", async (ev) => {
    const btn = ev.currentTarget; btn.disabled = true;
    try { await api("/api/busqueda", { method: "POST" }); pedirPermisoAvisos(); toast("Buscando ofertas nuevas. El resultado aparece en la campanita 🔔"); cargarTrabajos(); }
    catch (e) { toast(e.message); }
    btn.disabled = false;
  });

  $("#stats").addEventListener("click", (ev) => {
    const b = ev.target.closest("[data-filtro]");
    if (!b) return;
    estado.filtro = b.dataset.filtro === estado.filtro ? "" : b.dataset.filtro;
    pintarStats(); pintarLista();
  });
  $("#buscar").addEventListener("input", (ev) => { estado.busqueda = ev.target.value; pintarLista(); });

  $("#enviadas").addEventListener("click", (ev) => {
    const t = ev.target.closest("[data-id]");
    if (!t) return;
    pintarDetalle(estado.postulaciones.find((p) => p.id === t.dataset.id));
    $("#dlg-detalle").showModal();
  });
  $("#lista").addEventListener("click", (ev) => {
    const t = ev.target.closest("[data-id]");
    if (!t) return;
    pintarDetalle(estado.postulaciones.find((p) => p.id === t.dataset.id));
    $("#dlg-detalle").showModal();
  });

  $("#trabajos").addEventListener("click", async (ev) => {
    const ver = ev.target.closest("[data-ver]");
    if (ver) abrirCampana(false);
    const ocultar = ev.target.closest("[data-ocultar]");
    if (ver) {
      await cargarPostulaciones();
      const p = estado.postulaciones.find((x) => x.id === ver.dataset.ver);
      if (p) { pintarDetalle(p); $("#dlg-detalle").showModal(); }
    }
    if (ocultar) {
      await api(`/api/trabajos/${ocultar.dataset.ocultar}`, { method: "DELETE" });
      cargarTrabajos();
    }
    const reintentar = ev.target.closest("[data-reintentar-trabajo]");
    if (reintentar) {
      reintentar.disabled = true;
      try { await api(`/api/trabajos/${reintentar.dataset.reintentarTrabajo}/reintentar`, { method: "POST" }); toast("¡Vamos de nuevo! Uso el mismo link y las mismas fotos que mandaste"); }
      catch (e) { toast(e.message); }
      cargarTrabajos();
    }
  });

  $("#det-cuerpo").addEventListener("click", async (ev) => {
    const p = estado.postulaciones.find((x) => x.id === estado.abierta);
    const est = ev.target.closest("[data-estado]");
    if (est && est.dataset.estado !== p.estado_clave) actualizar(p.id, { estado: est.dataset.estado }, "Estado actualizado");
    if (ev.target.closest('[data-accion="mail"]')) abrirMail(p);
    if (ev.target.closest('[data-accion="descartar"]')
        && confirm(`¿Descartar la postulación a ${p.empresa}?\n\nSe saca de la lista. La podés recuperar desde el filtro «Descartada».`)) {
      await actualizar(p.id, { estado: "descartada" }, "Postulación descartada");
      $("#dlg-detalle").close();
    }
    if (ev.target.closest('[data-accion="recuperar"]')) actualizar(p.id, { estado: "preparada" }, "Recuperada: volvió a «Revisar»");
    if (ev.target.closest('[data-accion="ya-enviado"]')
        && confirm(`¿Ya enviaste el CV a ${p.empresa} por otro lado (el link de la oferta, la web de la empresa, otro mail)?\n\nAceptar = Sí, ya lo envié · Cancelar = No`))
      actualizar(p.id, { estado: "enviado" }, "Listo: quedó en Enviadas");
    if (ev.target.closest('[data-accion="editar-cv"]')) abrirEditorCv(p);
    if (ev.target.closest('[data-accion="editar-carta"]')) { estado.editandoCarta = true; pintarDetalle(p); $("#carta-edit").focus(); }
    if (ev.target.closest('[data-accion="cancelar-carta"]')) { estado.editandoCarta = false; pintarDetalle(p); }
    if (ev.target.closest('[data-accion="estudiar"]')) { $("#dlg-detalle").close(); mostrarVista("estudiar"); }
    if (ev.target.closest('[data-accion="actualizar-cv"]')) {
      try {
        await api(`/api/postulaciones/${p.id}/actualizar-cv`, { method: "POST" });
        pedirPermisoAvisos();
        toast("Actualizando el CV. Cuando esté, lo ves en la campanita 🔔");
        await cargarTrabajos(); pintarDetalle(p);
      } catch (e) { toast(e.message); }
    }
    const rev = ev.target.closest("[data-revisada]");
    if (rev) actualizar(p.id, { revisada: rev.dataset.revisada === "1" }, rev.dataset.revisada === "1" ? "¡Bien! Quedó lista para enviar 🟠" : "Vuelve a «falta revisar»");
    const loSe = ev.target.closest("[data-lo-se]");
    if (loSe) {
      loSe.disabled = true;
      try {
        await guardarConocimiento({ tema: loSe.dataset.ats ? loSe.dataset.loSe : temaCorto(loSe.dataset.loSe), tipo: "experiencia",
          detalle: `Lo pedía el puesto ${p.puesto} en ${p.empresa}: ${loSe.dataset.loSe}` }, { festejar: false, prueba: !!loSe.dataset.pruebaAntes });
      } catch (e) { toast(e.message); }
      loSe.disabled = false;
    }
  });
  $("#det-cuerpo").addEventListener("change", (ev) => {
    if (!ev.target.matches("[data-estudio]")) return;
    const marcados = $$("[data-estudio]:checked", $("#det-cuerpo")).map((c) => Number(c.dataset.estudio));
    actualizar(estado.abierta, { estudiado: marcados });
  });
  $("#det-cuerpo").addEventListener("submit", async (ev) => {
    if (ev.target.matches('[data-form="carta"]')) {
      ev.preventDefault();
      try {
        const p = await api(`/api/postulaciones/${estado.abierta}/carta`, json("PUT", { texto: $("#carta-edit").value }));
        estado.postulaciones = estado.postulaciones.map((x) => (x.id === p.id ? p : x));
        estado.editandoCarta = false; pintarDetalle(p); toast("Carta guardada. El mail sale con esta versión.");
      } catch (e) { toast(e.message); }
      return;
    }
    if (!ev.target.matches('[data-form="nota"]')) return;
    ev.preventDefault();
    actualizar(estado.abierta, { nota: $("#nota-nueva").value }, "Nota guardada");
  });

  // Estudiar
  $("#estudio-lista").addEventListener("click", async (ev) => {
    const cambio = ev.target.closest("[data-plan]");
    const cert = ev.target.closest("[data-certificado]");
    const sabia = ev.target.closest("[data-ya-sabia]");
    if (cambio) {
      estado.plan = await api(`/api/estudio/${cambio.dataset.plan}`, json("PATCH", { estado: cambio.dataset.planEstado }));
      pintarEstudio();
      if (cambio.dataset.planEstado === "estudiando") toast("¡A estudiar, Caro! 💪");
    }
    if (cert) {
      const it = estado.plan.items.find((i) => i.id === cert.dataset.certificado);
      abrirConocimiento({ tema: it.tema.split("(")[0].trim(), tipo: "certificado", estudioId: it.id });
    }
    if (sabia) {
      const it = estado.plan.items.find((i) => i.id === sabia.dataset.yaSabia);
      abrirConocimiento({ tema: it.tema.split("(")[0].trim(), tipo: "experiencia", estudioId: it.id });
    }
  });
  $("#btn-recalcular").addEventListener("click", async () => {
    try {
      await api("/api/estudio/recalcular", { method: "POST" });
      toast("Recalculando con todas las postulaciones…");
      mostrarVista("postulaciones");
      await cargarTrabajos();
    } catch (e) { toast(e.message); }
  });
  $("#con-tipos").addEventListener("change", alternarCamposTipo);
  $("#form-conocimiento").addEventListener("submit", enviarConocimiento);


  // Cursos
  $("#btn-nuevo-curso").addEventListener("click", () => $("#dlg-curso").showModal());
  $("#form-curso").addEventListener("submit", guardarCurso);
  $("#curso-capturas").addEventListener("change", (ev) => { cursoCapturas = cursoCapturas.concat([...ev.target.files]); pintarCursoMiniaturas(); ev.target.value = ""; });
  $("#curso-zona").addEventListener("dragover", (ev) => { ev.preventDefault(); ev.currentTarget.classList.add("arrastrando"); });
  $("#curso-zona").addEventListener("dragleave", (ev) => ev.currentTarget.classList.remove("arrastrando"));
  $("#curso-zona").addEventListener("drop", (ev) => { ev.preventDefault(); ev.currentTarget.classList.remove("arrastrando");
    cursoCapturas = cursoCapturas.concat([...ev.dataTransfer.files].filter((f) => f.type.startsWith("image/"))); pintarCursoMiniaturas(); });
  $("#curso-miniaturas").addEventListener("click", (ev) => {
    const b = ev.target.closest("[data-quitar]");
    if (b) { cursoCapturas.splice(Number(b.dataset.quitar), 1); pintarCursoMiniaturas(); }
  });
  $("#cursos").addEventListener("click", async (ev) => {
    const cambio = ev.target.closest("[data-curso]");
    const fin = ev.target.closest("[data-curso-fin]");
    if (cambio) {
      // Sólo un curso «en curso» a la vez: el anterior vuelve a pendiente.
      const previo = (estado.cursos || []).find((c) => c.estado === "en_curso" && c.id !== cambio.dataset.curso);
      if (previo) await api(`/api/cursos/${previo.id}`, json("PATCH", { estado: "pendiente" }));
      estado.cursos = (await api(`/api/cursos/${cambio.dataset.curso}`, json("PATCH", { estado: cambio.dataset.cursoEstado }))).items;
      const elegido = estado.cursos.find((c) => c.id === cambio.dataset.curso);
      if (elegido) estado.cursos = [elegido, ...estado.cursos.filter((c) => c !== elegido)];
      pintarCursos();
      toast("¡A darle, Caro! 💪");
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
    const quitar = ev.target.closest("[data-curso-quitar]");
    if (quitar) {
      const c = estado.cursos.find((x) => x.id === quitar.dataset.cursoQuitar);
      if (!confirm(`¿Quitar «${c.nombre}» de la lista?`)) return;
      estado.cursos = (await api(`/api/cursos/${c.id}`, { method: "DELETE" })).items;
      pintarCursos(); toast("Curso quitado");
    }
    if (ev.target.closest("[data-dolar]")) {
      const valor = prompt("Dólar oficial (venta) de hoy, en pesos. Lo podés ver en lanacion.com.ar/dolar-hoy", (estado.config || {}).dolar_oficial_venta || "");
      if (valor) {
        try { estado.config = await api("/api/config", json("PATCH", { dolar_oficial_venta: valor })); pintarCursos(); toast("Dólar actualizado"); }
        catch (e) { toast(e.message); }
      }
    }
    if (fin) {
      const c = estado.cursos.find((x) => x.id === fin.dataset.cursoFin);
      abrirConocimiento({ tema: c.nombre, tipo: c.certificado && c.certificado !== "No" ? "certificado" : "curso", cursoId: c.id, institucion: c.plataforma || "" });
    }
  });

  // Diccionario PM
  $("#btn-nueva-palabra").addEventListener("click", () => $("#dlg-palabra").showModal());
  $("#form-palabra").addEventListener("submit", agregarPalabra);
  $("#buscar-palabra").addEventListener("input", pintarGlosario);
  $("#vista-diccionario").addEventListener("click", (ev) => {
    const op = ev.target.closest("[data-opcion]");
    const h = ev.target.closest("[data-hablar]");
    if (op && !op.disabled) responder(op.dataset.opcion, op);
    if (h) hablar(h.dataset.hablar);
    if (ev.target.closest("[data-siguiente]")) nuevaPregunta();
    if (ev.target.closest("[data-reintentar]")) {
      const p = juego.actual.palabra;
      juego.repaso = juego.repaso.filter((r) => r.id !== p.id);
      juego.repaso.push({ id: p.id, en: 5, motivo: "repasar" });
      nuevaPregunta(p);
    }
  });

  // Ofertas encontradas → Postularme
  $("#encontradas").addEventListener("click", async (ev) => {
    const desc = ev.target.closest("[data-descartar], [data-recuperar]");
    if (desc) {
      const td = desc.closest("td");
      const cuerpo = desc.dataset.recuperar
        ? { link: desc.dataset.recuperar, descartar: false }
        : { link: td.dataset.clave || td.dataset.link, titulo: td.dataset.titulo, descartar: true };
      // Se mueve al instante de cuadro; después se guarda.
      const lista = estado.ofertasDatos.descartadas ||= {};
      if (cuerpo.descartar) lista[cuerpo.link] = { titulo: cuerpo.titulo, fecha: new Date().toISOString().slice(0, 10) };
      else delete lista[cuerpo.link];
      pintarEncontradas();
      try { await api("/api/ofertas-descartadas", json("POST", cuerpo)); }
      catch (e) { toast(e.message); await cargarEncontradas(); }
      return;
    }
    const ver = ev.target.closest("[data-abrir-post]");
    if (ver) {
      ev.preventDefault();
      mostrarVista("postulaciones");
      pintarDetalle(estado.postulaciones.find((p) => p.id === ver.dataset.abrirPost));
      $("#dlg-detalle").showModal();
      return;
    }
    const b = ev.target.closest("[data-postularme]");
    if (!b) return;
    const td = b.closest("td");
    const clave = td.dataset.clave || td.dataset.link;
    const datos = { link: td.dataset.link, titulo: td.dataset.titulo,
      texto: `Oferta tomada de ofertas_encontradas.md. Datos de la fila: ${td.dataset.texto}\nLink: ${td.dataset.link}\nLeé el link para obtener la publicación completa.` };
    marcarPreparando(clave, true);
    pintarEncontradas();
    try { await mandarOferta(datos); }
    catch (e) { toast(e.message); marcarPreparando(clave, false); pintarEncontradas(); }
  });

  // Nueva oferta
  const zona = $("#zona");
  $("#nueva-capturas").addEventListener("change", (ev) => { sumarCapturas(ev.target.files); ev.target.value = ""; });
  zona.addEventListener("dragover", (ev) => { ev.preventDefault(); zona.classList.add("arrastrando"); });
  zona.addEventListener("dragleave", () => zona.classList.remove("arrastrando"));
  zona.addEventListener("drop", (ev) => { ev.preventDefault(); zona.classList.remove("arrastrando"); sumarCapturas(ev.dataTransfer.files); });
  $("#nueva-texto").addEventListener("paste", (ev) => {
    const imgs = [...(ev.clipboardData?.files || [])].filter((f) => f.type.startsWith("image/"));
    if (imgs.length) { ev.preventDefault(); sumarCapturas(imgs); toast("Captura pegada"); }
  });
  $("#miniaturas").addEventListener("click", (ev) => {
    const b = ev.target.closest("[data-quitar]");
    if (b) { capturas.splice(Number(b.dataset.quitar), 1); pintarMiniaturas(); }
  });
  $("#form-nueva").addEventListener("submit", enviarOferta);

  // Mail
  $("#mail-checklist").addEventListener("change", () => { $("#btn-enviar").disabled = !(todoRevisado() && estado.smtp); });
  $("#form-mail").addEventListener("submit", enviarMail);
  $("#form-cv").addEventListener("submit", guardarCv);
  $("#btn-copiar").addEventListener("click", async () => {
    const texto = `Para: ${$("#mail-para").value}\nAsunto: ${$("#mail-asunto").value}\n\n${$("#mail-cuerpo").value.trim()}\n\n${estado.firma}`;
    try { await navigator.clipboard.writeText(texto); toast("Texto copiado"); }
    catch (e) { $("#mail-cuerpo").select(); toast("Seleccioné el texto: copialo con el menú"); }
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    estado.avisosSinVer = 0; document.title = tituloBase;
    cargarPostulaciones(); cargarTrabajos();
  });

  api("/api/conocimientos").then((c) => { estado.conocimientos = c.conocimientos; estado.tiposConocimiento = c.tipos; }).catch(() => {});
  cargarPostulaciones().then(() => cargarEncontradas()).catch((e) => toast(e.message));
  cargarTrabajos().then(bucleTrabajos);
  // Por si cargaron algo desde otro dispositivo.
  setInterval(() => { if (!document.hidden && !$("dialog[open]")) cargarPostulaciones().catch(() => {}); }, 30000);
}

document.addEventListener("DOMContentLoaded", iniciar);
