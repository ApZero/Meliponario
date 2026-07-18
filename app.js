// app.js — Meliponario
// Vanilla JS, sin build step. Persistencia en localStorage. Clima vía Open-Meteo.

const STORAGE_KEY = 'meliponario_v1';
const CONFIG_KEY = 'meliponario_config_v1';
const APP_DATA_VERSION = 1;

const DEFAULT_LUGAR = { nombre: 'Filadelfia, Boquerón', lat: -22.35, lon: -60.03 };

let state = {
  version: APP_DATA_VERSION,
  cajas: [], // cada caja incluye .revisiones = []
  fotosEspecies: {}, // { [especieId]: [dataURL, ...] } — fotos de referencia agregadas por el usuario
};

let config = {
  autobackup: true,
  ultimoBackup: null,
  lugar: { ...DEFAULT_LUGAR },
};

let climaCache = null; // { fetchedAt, daily: [...] }

// ===================================================================
// UTILIDADES
// ===================================================================
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function hoyISO() {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}

function fechaLegible(iso) {
  if (!iso) return '—';
  const [y, m, d] = iso.split('-');
  const meses = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  return `${parseInt(d)} ${meses[parseInt(m) - 1]} ${y}`;
}

function diasEntre(iso1, iso2) {
  const a = new Date(iso1 + 'T00:00:00');
  const b = new Date(iso2 + 'T00:00:00');
  return Math.round((b - a) / 86400000);
}

function sumarDias(iso, dias) {
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() + dias);
  return d.toISOString().slice(0, 10);
}

function especiePorId(id) {
  return ESPECIES.find((e) => e.id === id) || ESPECIES[0];
}

// Enlace a Wikimedia Commons: búsqueda de imágenes libres para identificar/comparar la especie.
function enlaceFotosEspecie(especie) {
  const q = encodeURIComponent(especie.nombreCientifico.split('/')[0].trim());
  return `https://commons.wikimedia.org/w/index.php?search=${q}&title=Special:MediaSearch&type=image`;
}

// ===================================================================
// FOTOS: compresión y utilidades
// ===================================================================
const FOTO_MAX_DIM = 1000;
const FOTO_CALIDAD = 0.72;

function comprimirImagen(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > height && width > FOTO_MAX_DIM) {
          height = Math.round(height * (FOTO_MAX_DIM / width));
          width = FOTO_MAX_DIM;
        } else if (height > FOTO_MAX_DIM) {
          width = Math.round(width * (FOTO_MAX_DIM / height));
          height = FOTO_MAX_DIM;
        }
        const canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', FOTO_CALIDAD));
      };
      img.onerror = reject;
      img.src = e.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function renderFotoGrid(containerId, fotos, onQuitar) {
  const cont = document.getElementById(containerId);
  cont.innerHTML = fotos.map((f, i) => `
    <div class="foto-thumb" data-i="${i}">
      <img src="${f}" alt="Foto">
      <button class="foto-quitar" data-quitar="${i}" type="button">✕</button>
    </div>`).join('');
  cont.querySelectorAll('[data-quitar]').forEach((btn) => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      onQuitar(parseInt(btn.dataset.quitar));
    });
  });
}

function abrirLightbox(src) {
  document.getElementById('lightbox-img').src = src;
  document.getElementById('lightbox').classList.add('open');
  document.getElementById('overlay-lightbox').classList.add('open');
}
function cerrarLightbox() {
  document.getElementById('lightbox').classList.remove('open');
  document.getElementById('overlay-lightbox').classList.remove('open');
}

function renderFotoGaleria(fotos) {
  if (!fotos || !fotos.length) return '';
  return `<div class="foto-galeria">${fotos.map((f) => `<div class="foto-thumb" data-src="${f}"><img src="${f}" alt="Foto de la caja"></div>`).join('')}</div>`;
}
function renderFotoMiniRow(fotos) {
  if (!fotos || !fotos.length) return '';
  return `<div class="foto-mini-row">${fotos.map((f) => `<div class="foto-thumb" data-src="${f}"><img src="${f}" alt="Foto de la revisión"></div>`).join('')}</div>`;
}
function activarClicksGaleria(scopeEl) {
  scopeEl.querySelectorAll('[data-src]').forEach((el) => {
    el.addEventListener('click', () => abrirLightbox(el.dataset.src));
  });
}

// ===================================================================
// FOTOS DE REFERENCIA POR ESPECIE (para comparar/identificar)
// ===================================================================
const MAX_FOTOS_ESPECIE = 6;

function fotosDeEspecie(especieId) {
  return state.fotosEspecies[especieId] || [];
}

function agregarFotoEspecie(especieId, dataURL) {
  if (!state.fotosEspecies[especieId]) state.fotosEspecies[especieId] = [];
  if (state.fotosEspecies[especieId].length >= MAX_FOTOS_ESPECIE) return false;
  state.fotosEspecies[especieId].push(dataURL);
  guardarEstado();
  return true;
}

function quitarFotoEspecie(especieId, index) {
  if (!state.fotosEspecies[especieId]) return;
  state.fotosEspecies[especieId].splice(index, 1);
  guardarEstado();
}

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), 2200);
}

// ===================================================================
// PERSISTENCIA
// ===================================================================
function guardarEstado() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}
function cargarEstado() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) state = JSON.parse(raw);
    if (!state.fotosEspecies) state.fotosEspecies = {};
    if (!state.cajas) state.cajas = [];
  } catch (e) { console.error('Error cargando estado', e); }
}
function guardarConfig() {
  localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
}
function cargarConfig() {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (raw) config = { ...config, ...JSON.parse(raw) };
  } catch (e) { console.error('Error cargando config', e); }
}

// ===================================================================
// MODELO: CAJAS Y REVISIONES
// ===================================================================
function crearCaja(datos) {
  const caja = {
    id: uid(),
    nombre: datos.nombre,
    especieId: datos.especieId,
    tamanoTipo: datos.tamanoTipo,
    tamanoDetalle: datos.tamanoDetalle,
    fechaInicio: datos.fechaInicio,
    origen: datos.origen,
    cajaMadreId: datos.cajaMadreId || null,
    ubicacion: datos.ubicacion,
    info: datos.info,
    estado: datos.estado || 'activa',
    creadaEn: hoyISO(),
    fotos: datos.fotos || [],
    revisiones: [],
  };
  state.cajas.push(caja);
  guardarEstado();
  return caja;
}

function actualizarCaja(id, datos) {
  const c = state.cajas.find((x) => x.id === id);
  if (!c) return;
  Object.assign(c, datos);
  guardarEstado();
}

function eliminarCaja(id) {
  state.cajas = state.cajas.filter((c) => c.id !== id);
  // desvincular hijas
  state.cajas.forEach((c) => { if (c.cajaMadreId === id) c.cajaMadreId = null; });
  guardarEstado();
}

function agregarRevision(cajaId, datos) {
  const c = state.cajas.find((x) => x.id === cajaId);
  if (!c) return;
  c.revisiones.push({
    id: uid(),
    fecha: datos.fecha,
    estado: datos.estado,
    alertas: datos.alertas || [],
    notas: datos.notas || '',
    miel: Number(datos.miel) || 0,
    propoleo: Number(datos.propoleo) || 0,
    polen: Number(datos.polen) || 0,
    cera: Number(datos.cera) || 0,
    fotos: datos.fotos || [],
  });
  c.revisiones.sort((a, b) => a.fecha.localeCompare(b.fecha));
  guardarEstado();
}

function ultimaRevision(caja) {
  if (!caja.revisiones.length) return null;
  return caja.revisiones[caja.revisiones.length - 1];
}

function cajasHijas(id) {
  return state.cajas.filter((c) => c.cajaMadreId === id);
}

function proximaRevisionSugerida(caja) {
  const esp = especiePorId(caja.especieId);
  const ultima = ultimaRevision(caja);
  const base = ultima ? ultima.fecha : caja.fechaInicio;
  if (!base) return null;
  return sumarDias(base, esp.intervaloRevisionDias);
}

// ===================================================================
// CLIMA — Open-Meteo
// ===================================================================
async function obtenerClima(forzar = false) {
  const ahora = Date.now();
  if (!forzar && climaCache && ahora - climaCache.fetchedAt < 30 * 60 * 1000) {
    return climaCache;
  }
  const { lat, lon } = config.lugar;
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weathercode,windspeed_10m&daily=weathercode,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,windspeed_10m_max,windgusts_10m_max&timezone=auto&forecast_days=7`;
  try {
    const res = await fetch(url);
    const data = await res.json();
    climaCache = { fetchedAt: ahora, data };
    return climaCache;
  } catch (e) {
    console.error('Error obteniendo clima', e);
    return climaCache; // puede ser null
  }
}

function iconoClima(code) {
  if (code === 0) return '☀️';
  if ([1, 2].includes(code)) return '🌤️';
  if (code === 3) return '☁️';
  if ([45, 48].includes(code)) return '🌫️';
  if ([51, 53, 55, 56, 57].includes(code)) return '🌦️';
  if ([61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return '🌧️';
  if ([71, 73, 75, 77, 85, 86].includes(code)) return '🌨️';
  if ([95, 96, 99].includes(code)) return '⛈️';
  return '🌡️';
}

// Evalúa si un día es apto para abrir cajas, según reglas de manejo de meliponicultura.
function evaluarDia(dia) {
  const problemas = [];
  if (dia.precipitation_probability_max >= 55 || dia.precipitation_sum > 3) problemas.push('lluvia');
  if (dia.windspeed_10m_max >= 28) problemas.push('viento');
  if (dia.temperature_2m_max < 19) problemas.push('frio');
  if ([95, 96, 99].includes(dia.weathercode)) problemas.push('tormenta');
  return { apto: problemas.length === 0, problemas };
}

function generarAvisos(daily) {
  const avisos = [];
  const hoy = daily.time[0];
  const evalHoy = evaluarDia({
    precipitation_probability_max: daily.precipitation_probability_max[0],
    precipitation_sum: daily.precipitation_sum[0],
    windspeed_10m_max: daily.windspeed_10m_max[0],
    temperature_2m_max: daily.temperature_2m_max[0],
    weathercode: daily.weathercode[0],
  });

  if (evalHoy.problemas.includes('tormenta')) {
    avisos.push({ tipo: 'alerta', ic: '⛈️', titulo: 'Tormenta prevista hoy', texto: 'No abras las cajas. Verificá que las tapas estén bien sujetas y que las cajas no queden en zonas de acumulación de agua.' });
  }
  if (evalHoy.problemas.includes('lluvia') && !evalHoy.problemas.includes('tormenta')) {
    avisos.push({ tipo: 'aviso', ic: '🌧️', titulo: 'Alta probabilidad de lluvia', texto: 'Conviene posponer revisiones. La humedad que entra al nido puede afectar cría y reservas de miel.' });
  }
  if (evalHoy.problemas.includes('viento')) {
    avisos.push({ tipo: 'aviso', ic: '💨', titulo: 'Viento fuerte', texto: 'Asegurá cajas livianas o mal ancladas y evitá abrirlas: el viento estresa a la colonia y enfría el nido rápidamente.' });
  }
  if (evalHoy.problemas.includes('frio')) {
    avisos.push({ tipo: 'aviso', ic: '🥶', titulo: 'Temperatura baja', texto: 'Por debajo de 19°C las abejas están menos activas. Evitá abrir, sobre todo especies pequeñas como yateí o mirim.' });
  }

  // Calor extremo en los próximos días
  const maxProximos = Math.max(...daily.temperature_2m_max.slice(0, 4));
  if (maxProximos >= 36) {
    avisos.push({ tipo: 'aviso', ic: '🔥', titulo: 'Calor intenso en los próximos días', texto: 'Asegurá sombra parcial sobre las cajas, buena ventilación y un bebedero cercano con piedras para que las abejas tomen agua sin ahogarse.' });
  }

  // Frío intenso próximo (heladas)
  const minProximos = Math.min(...daily.temperature_2m_min.slice(0, 4));
  if (minProximos <= 8) {
    avisos.push({ tipo: 'alerta', ic: '❄️', titulo: 'Riesgo de helada', texto: 'Reforzá el aislamiento de las cajas (paja, cartón, ubicación protegida del viento sur) y reducí las piqueras para conservar calor.' });
  }

  // Racha seca prolongada -> riesgo de pillaje
  const sumaLluviaSemana = daily.precipitation_sum.reduce((a, b) => a + b, 0);
  if (sumaLluviaSemana < 2 && maxProximos >= 30) {
    avisos.push({ tipo: 'aviso', ic: '⚔️', titulo: 'Semana seca y calurosa', texto: 'Mayor riesgo de pillaje (robo) entre colonias. Reducí piqueras de las cajas más débiles y asegurá agua disponible cerca del meliponario.' });
  }

  if (avisos.length === 0) {
    avisos.push({ tipo: 'ok', ic: '✅', titulo: 'Condiciones favorables', texto: 'Buen momento para revisar cajas: preferí el horario de 10:00 a 15:00 con las abejas más calmas.' });
  }
  return avisos;
}

// ===================================================================
// RECORDATORIOS
// ===================================================================
function calcularRecordatorios(daily) {
  const hoy = hoyISO();
  const recordatorios = [];
  state.cajas.filter((c) => c.estado === 'activa').forEach((c) => {
    const prox = proximaRevisionSugerida(c);
    if (!prox) return;
    const dias = diasEntre(hoy, prox);
    if (dias <= 3) {
      let climaNota = '';
      let urgencia = dias < 0 ? 'alerta' : dias <= 0 ? 'aviso' : 'neutro';
      if (daily) {
        const evalHoy = evaluarDia({
          precipitation_probability_max: daily.precipitation_probability_max[0],
          precipitation_sum: daily.precipitation_sum[0],
          windspeed_10m_max: daily.windspeed_10m_max[0],
          temperature_2m_max: daily.temperature_2m_max[0],
          weathercode: daily.weathercode[0],
        });
        if (!evalHoy.apto) {
          // buscar próximo día apto en el pronóstico
          let idxBueno = -1;
          for (let i = 0; i < daily.time.length; i++) {
            const ev = evaluarDia({
              precipitation_probability_max: daily.precipitation_probability_max[i],
              precipitation_sum: daily.precipitation_sum[i],
              windspeed_10m_max: daily.windspeed_10m_max[i],
              temperature_2m_max: daily.temperature_2m_max[i],
              weathercode: daily.weathercode[i],
            });
            if (ev.apto) { idxBueno = i; break; }
          }
          if (idxBueno > 0) {
            climaNota = `Hoy no es buen día (${evalHoy.problemas.join(', ')}). Mejor esperar hasta el ${fechaLegible(daily.time[idxBueno])}.`;
          } else {
            climaNota = `Clima no favorable los próximos días (${evalHoy.problemas.join(', ')}). Revisá apenas mejore.`;
          }
        } else {
          climaNota = 'El clima de hoy es apto para revisar.';
        }
      }
      recordatorios.push({
        cajaId: c.id,
        cajaNombre: c.nombre,
        diasRetraso: dias,
        urgencia,
        climaNota,
        fechaSugerida: prox,
      });
    }
  });
  recordatorios.sort((a, b) => a.diasRetraso - b.diasRetraso);
  return recordatorios;
}

// ===================================================================
// RENDER: CAJAS
// ===================================================================
let filtroEstadoActual = 'activa';

function renderCajas() {
  const cont = document.getElementById('lista-cajas');
  let cajas = state.cajas;
  if (filtroEstadoActual !== 'todas') {
    cajas = cajas.filter((c) => c.estado === filtroEstadoActual);
  }
  if (cajas.length === 0) {
    cont.innerHTML = `<div class="empty"><span class="ic">📦</span>No hay cajas ${filtroEstadoActual === 'todas' ? '' : 'en este estado'}. Tocá el botón + para agregar una.</div>`;
    return;
  }
  cont.innerHTML = cajas.map((c) => {
    const esp = especiePorId(c.especieId);
    const ultima = ultimaRevision(c);
    const hijas = cajasHijas(c.id);
    return `
    <div class="card caja-card estado-${c.estado}" data-id="${c.id}">
      <div class="top-row">
        <div>
          <h3>${c.nombre}</h3>
          <div class="especie-tag">${esp.nombre}</div>
        </div>
        <span class="pill neutro">${c.tamanoTipo}</span>
      </div>
      <div class="meta-row">
        <span>🗓️ Desde <strong>${fechaLegible(c.fechaInicio)}</strong></span>
        <span>🔍 Última revisión <strong>${ultima ? fechaLegible(ultima.fecha) : 'sin registrar'}</strong></span>
        ${hijas.length ? `<span>🌱 ${hijas.length} caja(s) hija</span>` : ''}
      </div>
    </div>`;
  }).join('');

  cont.querySelectorAll('.caja-card').forEach((el) => {
    el.addEventListener('click', () => abrirDetalleCaja(el.dataset.id));
  });
}

function renderRecordatorios(daily) {
  const recordatorios = calcularRecordatorios(daily);
  const cont = document.getElementById('lista-recordatorios');
  const tit = document.getElementById('tit-recordatorios');
  if (recordatorios.length === 0) {
    tit.style.display = 'none';
    cont.innerHTML = '';
    return;
  }
  tit.style.display = 'block';
  cont.innerHTML = recordatorios.map((r) => {
    const tipo = r.urgencia === 'alerta' ? 'alerta' : r.urgencia === 'aviso' ? 'aviso' : 'ok';
    const texto = r.diasRetraso < 0
      ? `Revisión atrasada ${Math.abs(r.diasRetraso)} día(s). ${r.climaNota}`
      : r.diasRetraso === 0
        ? `Toca revisar hoy. ${r.climaNota}`
        : `Revisión sugerida en ${r.diasRetraso} día(s) (${fechaLegible(r.fechaSugerida)}). ${r.climaNota}`;
    return `
    <div class="aviso-card tipo-${tipo}" data-caja="${r.cajaId}" style="cursor:pointer;">
      <span class="ic">🔔</span>
      <div><b>${r.cajaNombre}</b><p>${texto}</p></div>
    </div>`;
  }).join('');
  cont.querySelectorAll('.aviso-card').forEach((el) => {
    el.addEventListener('click', () => abrirDetalleCaja(el.dataset.caja));
  });
}

// ===================================================================
// DETALLE DE CAJA
// ===================================================================
function abrirDetalleCaja(id) {
  const c = state.cajas.find((x) => x.id === id);
  if (!c) return;
  const esp = especiePorId(c.especieId);
  const hijas = cajasHijas(c.id);
  const madre = c.cajaMadreId ? state.cajas.find((x) => x.id === c.cajaMadreId) : null;

  document.getElementById('detalle-titulo').textContent = c.nombre;

  const totales = c.revisiones.reduce((acc, r) => {
    acc.miel += r.miel; acc.propoleo += r.propoleo; acc.polen += r.polen; acc.cera += r.cera;
    return acc;
  }, { miel: 0, propoleo: 0, polen: 0, cera: 0 });

  const revisionesHTML = c.revisiones.slice().reverse().map((r) => {
    const extrItems = [];
    if (r.miel) extrItems.push(`🍯 ${r.miel} g`);
    if (r.propoleo) extrItems.push(`🟤 ${r.propoleo} g propóleo`);
    if (r.polen) extrItems.push(`🌼 ${r.polen} g polen`);
    if (r.cera) extrItems.push(`🕯️ ${r.cera} g cera`);
    const estadoIcono = { normal: '✅', atencion: '⚠️', problema: '🚨' }[r.estado] || '';
    const alertaLabels = {
      forida: '🪰 Fórida', hormigas: '🐜 Hormigas', reservas_bajas: '🍯 Reservas bajas',
      humedad: '💧 Humedad', sin_reina: '👑 Sin reina', pillaje: '⚔️ Pillaje', division_natural: '🐝 Lista para dividir',
    };
    return `
    <div class="revision-item">
      <div class="fecha">${estadoIcono} ${fechaLegible(r.fecha)}</div>
      ${r.notas ? `<div class="notas">${escapeHTML(r.notas)}</div>` : ''}
      ${extrItems.length ? `<div class="extraccion">${extrItems.map((x) => `<span>${x}</span>`).join('')}</div>` : ''}
      ${r.alertas.length ? `<div class="tags">${r.alertas.map((a) => `<span class="pill aviso">${alertaLabels[a] || a}</span>`).join('')}</div>` : ''}
      ${renderFotoMiniRow(r.fotos)}
    </div>`;
  }).join('') || '<p class="hint">Todavía no hay revisiones registradas.</p>';

  document.getElementById('detalle-contenido').innerHTML = `
    <div class="stat-row">
      <span class="pill neutro">${esp.nombre}</span>
      <span class="pill neutro">${c.tamanoTipo}${c.tamanoDetalle ? ' · ' + escapeHTML(c.tamanoDetalle) : ''}</span>
      <span class="pill neutro">${c.estado}</span>
    </div>
    ${madre ? `<p class="hint">🌱 Proviene de división de <b>${escapeHTML(madre.nombre)}</b></p>` : ''}
    ${c.ubicacion ? `<p class="hint">📍 ${escapeHTML(c.ubicacion)}</p>` : ''}
    ${c.info ? `<p style="font-size:13.5px;">${escapeHTML(c.info)}</p>` : ''}
    ${renderFotoGaleria(c.fotos)}

    <div class="section-title">Totales extraídos</div>
    <div class="stat-grid" style="margin-bottom:14px;">
      <div class="stat-box"><div class="num">${totales.miel}</div><div class="lbl">g miel</div></div>
      <div class="stat-box"><div class="num">${totales.propoleo}</div><div class="lbl">g propóleo</div></div>
      <div class="stat-box"><div class="num">${totales.polen}</div><div class="lbl">g polen</div></div>
    </div>

    <div class="section-title">Consejos para ${esp.nombre}</div>
    <div class="card especie-card" style="margin-bottom:14px;">
      <ul>${esp.tips.slice(0, 3).map((t) => `<li>${t}</li>`).join('')}</ul>
    </div>

    ${hijas.length ? `
    <div class="section-title">Cajas hijas (${hijas.length})</div>
    <div style="margin-bottom:10px;">
      ${hijas.map((h) => `<span class="pill neutro" style="cursor:pointer; margin:0 6px 6px 0; display:inline-flex;" data-hija="${h.id}">${escapeHTML(h.nombre)}</span>`).join('')}
    </div>` : ''}

    <div style="display:flex; gap:8px; margin: 14px 0;">
      <button class="btn btn-primary" style="flex:1;" id="btn-nueva-revision-detalle">＋ Revisión</button>
      <button class="btn btn-secondary" style="flex:1;" id="btn-dividir-caja">🌱 Dividir</button>
      <button class="btn btn-outline btn-icon" id="btn-editar-caja">✏️</button>
    </div>

    <div class="section-title">Historial de revisiones</div>
    ${revisionesHTML}
  `;

  document.getElementById('detalle-contenido').querySelectorAll('[data-hija]').forEach((el) => {
    el.addEventListener('click', () => abrirDetalleCaja(el.dataset.hija));
  });
  activarClicksGaleria(document.getElementById('detalle-contenido'));
  document.getElementById('btn-nueva-revision-detalle').addEventListener('click', () => abrirSheetRevision(c.id));
  document.getElementById('btn-dividir-caja').addEventListener('click', () => {
    cerrarSheet('sheet-detalle');
    abrirSheetCaja(null, c.id);
  });
  document.getElementById('btn-editar-caja').addEventListener('click', () => {
    cerrarSheet('sheet-detalle');
    abrirSheetCaja(c.id);
  });

  abrirSheet('sheet-detalle');
}

function escapeHTML(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

// ===================================================================
// SHEET: NUEVA / EDITAR CAJA
// ===================================================================
function poblarSelectEspecies() {
  const sel = document.getElementById('caja-especie');
  sel.innerHTML = ESPECIES.map((e) => `<option value="${e.id}">${e.nombre}</option>`).join('');
}
function poblarSelectMadre(excluirId) {
  const sel = document.getElementById('caja-madre');
  const opciones = state.cajas.filter((c) => c.id !== excluirId);
  sel.innerHTML = '<option value="">— Ninguna —</option>' +
    opciones.map((c) => `<option value="${c.id}">${escapeHTML(c.nombre)}</option>`).join('');
}

let cajaFotosTemp = [];

function abrirSheetCaja(id, cajaMadreIdPreset) {
  poblarSelectEspecies();
  poblarSelectMadre(id);
  const esEdicion = !!id;
  document.getElementById('sheet-caja-titulo').textContent = esEdicion ? 'Editar caja' : (cajaMadreIdPreset ? 'Nueva caja (división)' : 'Nueva caja');
  document.getElementById('btn-eliminar-caja').style.display = esEdicion ? 'block' : 'none';

  if (esEdicion) {
    const c = state.cajas.find((x) => x.id === id);
    document.getElementById('caja-id').value = c.id;
    document.getElementById('caja-nombre').value = c.nombre;
    document.getElementById('caja-especie').value = c.especieId;
    document.getElementById('caja-tamano-tipo').value = c.tamanoTipo;
    document.getElementById('caja-tamano-detalle').value = c.tamanoDetalle || '';
    document.getElementById('caja-fecha-inicio').value = c.fechaInicio || '';
    document.getElementById('caja-origen').value = c.origen || 'captura';
    document.getElementById('caja-madre').value = c.cajaMadreId || '';
    document.getElementById('caja-ubicacion').value = c.ubicacion || '';
    document.getElementById('caja-info').value = c.info || '';
    document.getElementById('caja-estado').value = c.estado;
    cajaFotosTemp = (c.fotos || []).slice();
  } else {
    document.getElementById('caja-id').value = '';
    document.getElementById('caja-nombre').value = '';
    document.getElementById('caja-tamano-tipo').value = 'mediana';
    document.getElementById('caja-tamano-detalle').value = '';
    document.getElementById('caja-fecha-inicio').value = hoyISO();
    document.getElementById('caja-origen').value = cajaMadreIdPreset ? 'division' : 'captura';
    document.getElementById('caja-madre').value = cajaMadreIdPreset || '';
    document.getElementById('caja-ubicacion').value = '';
    document.getElementById('caja-info').value = '';
    document.getElementById('caja-estado').value = 'activa';
    if (cajaMadreIdPreset) {
      const madre = state.cajas.find((x) => x.id === cajaMadreIdPreset);
      if (madre) document.getElementById('caja-especie').value = madre.especieId;
    }
    cajaFotosTemp = [];
  }
  refrescarFotoGridCaja();
  abrirSheet('sheet-caja');
}

function refrescarFotoGridCaja() {
  renderFotoGrid('caja-fotos-grid', cajaFotosTemp, (i) => {
    cajaFotosTemp.splice(i, 1);
    refrescarFotoGridCaja();
  });
}

function guardarCajaDesdeForm() {
  const id = document.getElementById('caja-id').value;
  const nombre = document.getElementById('caja-nombre').value.trim();
  if (!nombre) { toast('Poné un nombre para la caja'); return; }
  const datos = {
    nombre,
    especieId: document.getElementById('caja-especie').value,
    tamanoTipo: document.getElementById('caja-tamano-tipo').value,
    tamanoDetalle: document.getElementById('caja-tamano-detalle').value.trim(),
    fechaInicio: document.getElementById('caja-fecha-inicio').value,
    origen: document.getElementById('caja-origen').value,
    cajaMadreId: document.getElementById('caja-madre').value || null,
    ubicacion: document.getElementById('caja-ubicacion').value.trim(),
    info: document.getElementById('caja-info').value.trim(),
    estado: document.getElementById('caja-estado').value,
    fotos: cajaFotosTemp.slice(),
  };
  if (id) {
    actualizarCaja(id, datos);
    toast('Caja actualizada');
  } else {
    crearCaja(datos);
    toast('Caja creada');
  }
  cerrarSheet('sheet-caja');
  renderTodo();
}

// ===================================================================
// SHEET: NUEVA REVISIÓN
// ===================================================================
let revEstadoSel = 'normal';
let revAlertasSel = new Set();
let revFotosTemp = [];

function refrescarFotoGridRev() {
  renderFotoGrid('rev-fotos-grid', revFotosTemp, (i) => {
    revFotosTemp.splice(i, 1);
    refrescarFotoGridRev();
  });
}

function abrirSheetRevision(cajaId) {
  document.getElementById('rev-caja-id').value = cajaId;
  document.getElementById('rev-fecha').value = hoyISO();
  document.getElementById('rev-notas').value = '';
  document.getElementById('rev-miel').value = '';
  document.getElementById('rev-propoleo').value = '';
  document.getElementById('rev-polen').value = '';
  document.getElementById('rev-cera').value = '';
  revEstadoSel = 'normal';
  revAlertasSel = new Set();
  revFotosTemp = [];
  document.querySelectorAll('#rev-estado-chips .chip').forEach((c) => c.classList.toggle('selected', c.dataset.val === 'normal'));
  document.querySelectorAll('#rev-alertas-chips .chip').forEach((c) => c.classList.remove('selected'));
  refrescarFotoGridRev();
  abrirSheet('sheet-revision');
}

function guardarRevisionDesdeForm() {
  const cajaId = document.getElementById('rev-caja-id').value;
  const fecha = document.getElementById('rev-fecha').value;
  if (!fecha) { toast('Elegí una fecha'); return; }
  agregarRevision(cajaId, {
    fecha,
    estado: revEstadoSel,
    alertas: Array.from(revAlertasSel),
    notas: document.getElementById('rev-notas').value.trim(),
    miel: document.getElementById('rev-miel').value,
    propoleo: document.getElementById('rev-propoleo').value,
    polen: document.getElementById('rev-polen').value,
    cera: document.getElementById('rev-cera').value,
    fotos: revFotosTemp.slice(),
  });
  toast('Revisión guardada');
  cerrarSheet('sheet-revision');
  abrirDetalleCaja(cajaId);
  renderTodo();
}

// ===================================================================
// RENDER: CLIMA
// ===================================================================
async function renderClima() {
  const cont = document.getElementById('clima-contenido');
  const resultado = await obtenerClima();
  if (!resultado || !resultado.data) {
    cont.innerHTML = '<div class="empty"><span class="ic">📡</span>No se pudo obtener el clima. Revisá tu conexión.</div>';
    return;
  }
  const { current, daily } = resultado.data;
  const avisos = generarAvisos(daily);

  const diasHTML = daily.time.map((fecha, i) => {
    const ev = evaluarDia({
      precipitation_probability_max: daily.precipitation_probability_max[i],
      precipitation_sum: daily.precipitation_sum[i],
      windspeed_10m_max: daily.windspeed_10m_max[i],
      temperature_2m_max: daily.temperature_2m_max[i],
      weathercode: daily.weathercode[i],
    });
    const nombreDia = i === 0 ? 'Hoy' : new Date(fecha + 'T12:00:00').toLocaleDateString('es-PY', { weekday: 'short' });
    return `
    <div class="dia-card ${ev.apto ? 'buen-dia' : 'mal-dia'}">
      <div class="dia-nombre">${nombreDia}</div>
      <div class="dia-ic">${iconoClima(daily.weathercode[i])}</div>
      <div class="mono">${Math.round(daily.temperature_2m_max[i])}° / ${Math.round(daily.temperature_2m_min[i])}°</div>
      <div style="font-size:10px; margin-top:2px;">${ev.apto ? '👍 apta' : '🚫 evitar'}</div>
    </div>`;
  }).join('');

  cont.innerHTML = `
    <div class="clima-hero">
      <div class="lugar">📍 ${escapeHTML(config.lugar.nombre)}</div>
      <div class="temp-actual mono">${current ? Math.round(current.temperature_2m) + '°' : '—'}</div>
      <div>${current ? iconoClima(current.weathercode) : ''} Viento ${current ? Math.round(current.windspeed_10m) : '—'} km/h</div>
    </div>

    <div class="section-title">Próximos 7 días</div>
    <div class="dias-forecast">${diasHTML}</div>

    <div class="section-title">Avisos de protección</div>
    ${avisos.map((a) => `
      <div class="aviso-card tipo-${a.tipo}">
        <span class="ic">${a.ic}</span>
        <div><b>${a.titulo}</b><p>${a.texto}</p></div>
      </div>`).join('')}
  `;

  // recordatorios dependen del clima, re-renderizar con datos frescos
  renderRecordatorios(daily);
}

// ===================================================================
// RENDER: ESPECIES
// ===================================================================
function renderEspecies() {
  document.getElementById('tips-generales-card').innerHTML =
    `<ul style="margin:0; padding-left:18px; font-size:13.5px; line-height:1.6;">${TIPS_GENERALES.map((t) => `<li style="margin-bottom:8px;">${t}</li>`).join('')}</ul>`;

  const temperamentoLabel = { muy_docil: '😌 Muy dócil', docil: '🙂 Dócil', defensiva: '😠 Defensiva', agresiva: '🔥 Agresiva' };

  document.getElementById('lista-especies').innerHTML = ESPECIES.map((e) => `
    <div class="card especie-card">
      <h3>${e.nombre}</h3>
      <div class="cientifico">${e.nombreCientifico}</div>
      <div class="stat-row">
        <span class="pill">${temperamentoLabel[e.temperamento] || e.temperamento}</span>
        <span class="pill">🎓 ${e.dificultad}</span>
        <span class="pill">🔁 cada ${e.intervaloRevisionDias} días</span>
      </div>
      <div class="stat-row">
        <span class="pill">🍯 ${e.produccionMiel}</span>
        <span class="pill">🐝 ${e.tamanoColonia}</span>
      </div>
      <p class="hint">🌡️ Ideal entre ${e.tempIdealMin}°C y ${e.tempIdealMax}°C · ${e.entrada}</p>
      <ul>${e.tips.map((t) => `<li>${t}</li>`).join('')}</ul>
      <a class="especie-foto-link" href="${enlaceFotosEspecie(e)}" target="_blank" rel="noopener">🔍 Buscar fotos en Wikimedia Commons</a>

      <div class="section-title" style="margin:14px 0 6px; font-size:11px;">Tus fotos de referencia</div>
      <div class="foto-grid especie-foto-grid" id="fotos-especie-${e.id}"></div>
      <button class="btn btn-outline btn-sm" data-add-foto-especie="${e.id}">📷 Guardar foto de referencia</button>
      <div class="hint">Guardá acá una foto propia (o una captura de pantalla de una fuente confiable) para comparar y reconocer esta especie más rápido en el campo.</div>
    </div>
  `).join('');

  ESPECIES.forEach((e) => {
    refrescarFotoGridEspecie(e.id);
  });
  document.querySelectorAll('[data-add-foto-especie]').forEach((btn) => {
    btn.addEventListener('click', () => {
      especieFotoActiva = btn.dataset.addFotoEspecie;
      document.getElementById('input-foto-especie').click();
    });
  });
}

let especieFotoActiva = null;

function refrescarFotoGridEspecie(especieId) {
  const cont = document.getElementById(`fotos-especie-${especieId}`);
  if (!cont) return;
  const fotos = fotosDeEspecie(especieId);
  if (!fotos.length) { cont.innerHTML = '<p class="hint" style="margin:2px 0 6px;">Todavía no guardaste fotos de esta especie.</p>'; return; }
  cont.innerHTML = fotos.map((f, i) => `
    <div class="foto-thumb" data-i="${i}" data-src="${f}">
      <img src="${f}" alt="Foto de referencia">
      <button class="foto-quitar" data-quitar-especie="${especieId}" data-i="${i}" type="button">✕</button>
    </div>`).join('');
  activarClicksGaleria(cont);
  cont.querySelectorAll('[data-quitar-especie]').forEach((btn) => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      quitarFotoEspecie(btn.dataset.quitarEspecie, parseInt(btn.dataset.i));
      refrescarFotoGridEspecie(especieId);
    });
  });
}

// ===================================================================
// RENDER: ESTADÍSTICAS
// ===================================================================
function renderStats() {
  const todasRev = state.cajas.flatMap((c) => c.revisiones.map((r) => ({ ...r, cajaId: c.id, cajaNombre: c.nombre, especieId: c.especieId })));
  const totales = todasRev.reduce((acc, r) => {
    acc.miel += r.miel; acc.propoleo += r.propoleo; acc.polen += r.polen;
    return acc;
  }, { miel: 0, propoleo: 0, polen: 0 });

  document.getElementById('stat-grid-totales').innerHTML = `
    <div class="stat-box"><div class="num">${state.cajas.length}</div><div class="lbl">cajas totales</div></div>
    <div class="stat-box"><div class="num">${state.cajas.filter((c) => c.estado === 'activa').length}</div><div class="lbl">activas</div></div>
    <div class="stat-box"><div class="num">${todasRev.length}</div><div class="lbl">revisiones</div></div>
    <div class="stat-box"><div class="num">${(totales.miel / 1000).toFixed(1)}</div><div class="lbl">kg miel total</div></div>
    <div class="stat-box"><div class="num">${totales.propoleo}</div><div class="lbl">g propóleo total</div></div>
    <div class="stat-box"><div class="num">${totales.polen}</div><div class="lbl">g polen total</div></div>
  `;

  // gráfico mensual del año actual (miel en gramos)
  const anio = new Date().getFullYear();
  const porMes = new Array(12).fill(0);
  todasRev.forEach((r) => {
    const [y, m] = r.fecha.split('-');
    if (parseInt(y) === anio) porMes[parseInt(m) - 1] += r.miel;
  });
  dibujarBarras(document.getElementById('chart-mensual'), porMes, ['E','F','M','A','M','J','J','A','S','O','N','D']);

  // ranking cajas
  const porCaja = {};
  todasRev.forEach((r) => {
    porCaja[r.cajaId] = porCaja[r.cajaId] || { nombre: r.cajaNombre, miel: 0 };
    porCaja[r.cajaId].miel += r.miel;
  });
  const ranking = Object.values(porCaja).sort((a, b) => b.miel - a.miel).slice(0, 8);
  document.getElementById('ranking-cajas').innerHTML = ranking.length
    ? ranking.map((r, i) => `<div class="config-row"><div class="label">#${i + 1} ${escapeHTML(r.nombre)}</div><div class="mono">${r.miel} g</div></div>`).join('')
    : '<p class="hint">Todavía no hay cosechas registradas.</p>';

  // por especie
  const porEspecie = {};
  todasRev.forEach((r) => {
    const esp = especiePorId(r.especieId);
    porEspecie[esp.id] = porEspecie[esp.id] || { nombre: esp.nombre, miel: 0, cajas: new Set() };
    porEspecie[esp.id].miel += r.miel;
    porEspecie[esp.id].cajas.add(r.cajaId);
  });
  const listaEspecie = Object.values(porEspecie).sort((a, b) => b.miel - a.miel);
  document.getElementById('stats-especie').innerHTML = listaEspecie.length
    ? listaEspecie.map((e) => `<div class="config-row"><div class="label">${e.nombre}<div class="desc">${e.cajas.size} caja(s)</div></div><div class="mono">${e.miel} g</div></div>`).join('')
    : '<p class="hint">Sin datos todavía.</p>';
}

function dibujarBarras(canvas, valores, etiquetas) {
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = 180;
  canvas.width = w * dpr; canvas.height = h * dpr;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);
  const max = Math.max(...valores, 1);
  const padBottom = 20, padTop = 10;
  const barW = (w / valores.length) * 0.6;
  const gap = (w / valores.length) * 0.4;
  ctx.font = '11px Inter, sans-serif';
  valores.forEach((v, i) => {
    const x = i * (barW + gap) + gap / 2;
    const barH = ((h - padBottom - padTop) * v) / max;
    ctx.fillStyle = v > 0 ? '#B85C38' : '#ECE0BF';
    ctx.beginPath();
    const y = h - padBottom - barH;
    const r = 4;
    ctx.moveTo(x, y + barH);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.lineTo(x + barW - r, y);
    ctx.quadraticCurveTo(x + barW, y, x + barW, y + r);
    ctx.lineTo(x + barW, y + barH);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#6B5C48';
    ctx.textAlign = 'center';
    ctx.fillText(etiquetas[i], x + barW / 2, h - 6);
  });
}

// ===================================================================
// BACKUP
// ===================================================================
function generarBackupObjeto() {
  return {
    tipo: 'meliponario-backup',
    version: APP_DATA_VERSION,
    generadoEn: new Date().toISOString(),
    state,
    config: { lugar: config.lugar },
  };
}

function descargarBackup() {
  const obj = generarBackupObjeto();
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const fecha = hoyISO();
  a.href = url;
  a.download = `meliponario-backup-${fecha}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  config.ultimoBackup = new Date().toISOString();
  guardarConfig();
  renderConfig();
}

function autobackupSiCorresponde() {
  if (!config.autobackup) return;
  const hoy = hoyISO();
  const ultimo = config.ultimoBackup ? config.ultimoBackup.slice(0, 10) : null;
  if (ultimo !== hoy) {
    descargarBackup();
    toast('Backup del día descargado');
  }
}

function importarBackup(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const obj = JSON.parse(e.target.result);
      const nuevoState = obj.state || obj; // tolerar formatos antiguos
      if (!nuevoState.cajas) throw new Error('Formato inválido');
      if (!confirm('Esto va a REEMPLAZAR todos los datos actuales por los del backup. ¿Continuar?')) return;
      state = nuevoState;
      if (obj.config && obj.config.lugar) config.lugar = obj.config.lugar;
      guardarEstado();
      guardarConfig();
      renderTodo();
      toast('Backup importado correctamente');
    } catch (err) {
      alert('No se pudo leer el archivo. Verificá que sea un backup válido de Meliponario.');
    }
  };
  reader.readAsText(file);
}

function estimarTamanoDatosKB() {
  const raw = localStorage.getItem(STORAGE_KEY) || '';
  return Math.round((raw.length * 2) / 1024); // aprox. 2 bytes/char en memoria
}

function renderConfig() {
  document.getElementById('chk-autobackup').checked = config.autobackup;
  document.getElementById('ultimo-backup-fecha').textContent = config.ultimoBackup
    ? new Date(config.ultimoBackup).toLocaleString('es-PY')
    : 'Nunca';
  document.getElementById('cfg-lugar-nombre').value = config.lugar.nombre;
  document.getElementById('cfg-lat').value = config.lugar.lat;
  document.getElementById('cfg-lon').value = config.lugar.lon;
  document.getElementById('app-version').textContent = 'v' + APP_DATA_VERSION;
  const kb = estimarTamanoDatosKB();
  const elTam = document.getElementById('tamano-datos');
  if (elTam) elTam.textContent = kb > 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${kb} KB`;
}

// ===================================================================
// NAVEGACIÓN
// ===================================================================
function cambiarVista(nombre) {
  document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
  document.getElementById('view-' + nombre).classList.add('active');
  document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === nombre));
  document.getElementById('fab-nueva-caja').style.display = nombre === 'cajas' ? 'flex' : 'none';
  if (nombre === 'clima') renderClima();
  if (nombre === 'especies') renderEspecies();
  if (nombre === 'stats') renderStats();
  if (nombre === 'config') renderConfig();
}

function abrirSheet(id) {
  document.getElementById(id).classList.add('open');
  document.getElementById('overlay-' + id.replace('sheet-', '')).classList.add('open');
}
function cerrarSheet(id) {
  document.getElementById(id).classList.remove('open');
  document.getElementById('overlay-' + id.replace('sheet-', '')).classList.remove('open');
}

function renderTodo() {
  renderCajas();
  obtenerClima().then((r) => {
    if (r && r.data) renderRecordatorios(r.data.daily);
  });
  const subt = document.getElementById('header-subt');
  const activas = state.cajas.filter((c) => c.estado === 'activa').length;
  subt.textContent = `${activas} caja${activas === 1 ? '' : 's'} activa${activas === 1 ? '' : 's'} · ${config.lugar.nombre}`;
}

// ===================================================================
// EVENTOS
// ===================================================================
function iniciarEventos() {
  document.querySelectorAll('.tab-btn').forEach((b) => {
    b.addEventListener('click', () => cambiarVista(b.dataset.view));
  });

  document.getElementById('fab-nueva-caja').addEventListener('click', () => abrirSheetCaja(null));

  document.querySelectorAll('[data-close]').forEach((b) => {
    b.addEventListener('click', () => cerrarSheet(b.dataset.close));
  });
  ['overlay-caja', 'overlay-detalle', 'overlay-revision'].forEach((id) => {
    document.getElementById(id).addEventListener('click', () => cerrarSheet('sheet-' + id.replace('overlay-', '')));
  });

  document.getElementById('btn-agregar-foto-caja').addEventListener('click', () => document.getElementById('input-foto-caja').click());
  document.getElementById('input-foto-caja').addEventListener('change', async (e) => {
    const archivos = Array.from(e.target.files).slice(0, 4 - cajaFotosTemp.length);
    for (const f of archivos) {
      try {
        const b64 = await comprimirImagen(f);
        cajaFotosTemp.push(b64);
      } catch (err) { console.error('Error procesando foto', err); }
    }
    refrescarFotoGridCaja();
    e.target.value = '';
  });

  document.getElementById('btn-agregar-foto-rev').addEventListener('click', () => document.getElementById('input-foto-rev').click());
  document.getElementById('input-foto-rev').addEventListener('change', async (e) => {
    const archivos = Array.from(e.target.files).slice(0, 3 - revFotosTemp.length);
    for (const f of archivos) {
      try {
        const b64 = await comprimirImagen(f);
        revFotosTemp.push(b64);
      } catch (err) { console.error('Error procesando foto', err); }
    }
    refrescarFotoGridRev();
    e.target.value = '';
  });

  document.getElementById('lightbox-close').addEventListener('click', cerrarLightbox);
  document.getElementById('overlay-lightbox').addEventListener('click', cerrarLightbox);

  document.getElementById('input-foto-especie').addEventListener('change', async (e) => {
    const especieId = especieFotoActiva;
    if (!especieId) return;
    const archivos = Array.from(e.target.files).slice(0, MAX_FOTOS_ESPECIE - fotosDeEspecie(especieId).length);
    for (const f of archivos) {
      try {
        const b64 = await comprimirImagen(f);
        agregarFotoEspecie(especieId, b64);
      } catch (err) { console.error('Error procesando foto', err); }
    }
    refrescarFotoGridEspecie(especieId);
    e.target.value = '';
  });

  document.getElementById('btn-guardar-caja').addEventListener('click', guardarCajaDesdeForm);
  document.getElementById('btn-eliminar-caja').addEventListener('click', () => {
    const id = document.getElementById('caja-id').value;
    if (!id) return;
    if (confirm('¿Eliminar esta caja y todo su historial de revisiones? Esta acción no se puede deshacer.')) {
      eliminarCaja(id);
      cerrarSheet('sheet-caja');
      cerrarSheet('sheet-detalle');
      renderTodo();
      toast('Caja eliminada');
    }
  });

  document.getElementById('btn-guardar-revision').addEventListener('click', guardarRevisionDesdeForm);

  document.querySelectorAll('#rev-estado-chips .chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      revEstadoSel = chip.dataset.val;
      document.querySelectorAll('#rev-estado-chips .chip').forEach((c) => c.classList.toggle('selected', c === chip));
    });
  });
  document.querySelectorAll('#rev-alertas-chips .chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      chip.classList.toggle('selected');
      if (chip.classList.contains('selected')) revAlertasSel.add(chip.dataset.val);
      else revAlertasSel.delete(chip.dataset.val);
    });
  });

  document.querySelectorAll('#filtro-estado-cajas .chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      filtroEstadoActual = chip.dataset.estado;
      document.querySelectorAll('#filtro-estado-cajas .chip').forEach((c) => c.classList.toggle('selected', c === chip));
      renderCajas();
    });
  });

  document.getElementById('chk-autobackup').addEventListener('change', (e) => {
    config.autobackup = e.target.checked;
    guardarConfig();
  });
  document.getElementById('btn-exportar-ahora').addEventListener('click', descargarBackup);
  document.getElementById('btn-importar').addEventListener('click', () => document.getElementById('input-importar').click());
  document.getElementById('input-importar').addEventListener('change', (e) => {
    if (e.target.files[0]) importarBackup(e.target.files[0]);
    e.target.value = '';
  });
  document.getElementById('btn-guardar-ubicacion').addEventListener('click', () => {
    config.lugar = {
      nombre: document.getElementById('cfg-lugar-nombre').value.trim() || DEFAULT_LUGAR.nombre,
      lat: parseFloat(document.getElementById('cfg-lat').value) || DEFAULT_LUGAR.lat,
      lon: parseFloat(document.getElementById('cfg-lon').value) || DEFAULT_LUGAR.lon,
    };
    guardarConfig();
    climaCache = null;
    toast('Ubicación guardada');
    renderTodo();
  });
}

// ===================================================================
// INICIO
// ===================================================================
function iniciar() {
  cargarEstado();
  cargarConfig();
  iniciarEventos();
  renderTodo();
  autobackupSiCorresponde();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch((e) => console.error('SW error', e));
  }
}

document.addEventListener('DOMContentLoaded', iniciar);
