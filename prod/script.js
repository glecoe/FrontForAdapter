// Два источника:
//  - список клиентов берём напрямую из Портфеля (это его база);
//  - проверки по спискам запрашиваем через Адаптер, он говорит с Кредитным бюро.
const PORTFOLIO_URL = "http://localhost:8081/api/v1/clients";
const ADAPTER_URL   = "http://localhost:8083/api/v1/clients";

const CLIENTS_URL = PORTFOLIO_URL;
const checkUrl = id => `${ADAPTER_URL}/${id}/check`;

const MAX_ATTEMPTS = 5;
const BLOCK_MS = 5 * 60 * 1000;
const PAGE_SIZE = 10;
// Бюро отвечает до 5 сек, адаптер делает до 5 попыток -> запас 60 сек.
const REQUEST_TIMEOUT_MS = 60000;

let clients = [];
let query = "";
let page = 1;

async function loadClients() {
  try {
    const resp = await request(CLIENTS_URL);
    const data = await resp.json();

    // Портфель отдаёт ФИО тремя полями, регион — объектом,
    // а время проверки называет lastAmlCheck. Приводим к виду, удобному таблице.
    clients = data.map(c => ({
      id: Number(c.id),
      fio: [c.lastName, c.firstName, c.patronymic].filter(Boolean).join(" ").trim(),
      inn: String(c.inn ?? ""),
      snils: String(c.snils ?? ""),
      region: String(c.region?.name ?? ""),
      amlStatus: c.amlStatus === true ? true : c.amlStatus === false ? false : null,
      lastCheckAt: c.lastAmlCheck ?? null,
      attempts: 0,
      blockedUntil: blockUntilFrom(c.lastAmlCheck),
      checking: false,
      open: false
    }));

    page = 1;
    render();
    setConn(true, "подключено");
    setLastUpdate(new Date());
  } catch (e) {
    setConn(false, "нет связи с сервером");
    document.getElementById("tbody").innerHTML =
      `<tr><td colspan="3" class="empty">Не удалось загрузить список клиентов.
       Нажмите «Обновить список» или обратитесь в поддержку.</td></tr>`;
    document.getElementById("pager").innerHTML = "";
  }
}

async function check(id) {
  const c = clients.find(x => x.id === id);
  if (!c || c.checking || Date.now() < c.blockedUntil) return;

  c.checking = true;
  render();

  try {
    const resp = await rawRequest(checkUrl(c.id), { method: "POST" });
    const result = await resp.json().catch(() => ({}));

    if (resp.ok) {
      // amlStatus === true  -> клиента НЕТ в запрещённых списках
      // amlStatus === false -> клиент НАЙДЕН в списках
      c.amlStatus = result.amlStatus === true;
      c.lastCheckAt = new Date().toISOString();
      c.attempts = 0;
      c.blockedUntil = Date.now() + BLOCK_MS;

      toast(
        c.amlStatus ? `${shortName(c)}: не в списках` : `${shortName(c)}: найден в списках`,
        !c.amlStatus
      );
    } else if (resp.status === 429) {
      // Повторная проверка раньше, чем через 5 минут
      c.blockedUntil = Date.now() + (result.retryAfter ?? 300) * 1000;
      c.attempts = 0;
      toast(`${shortName(c)}: проверять можно не чаще раза в 5 минут`, true);
    } else if (resp.status === 404) {
      toast(`${shortName(c)}: клиент не найден в Портфеле`, true);
    } else if (result.retryAfter) {
      // Бюро не ответило, адаптер уже записал попытку -> ждём
      c.blockedUntil = Date.now() + result.retryAfter * 1000;
      c.attempts = 0;
      toast(`${shortName(c)}: результат не определён. Повторите через 5 минут`, true);
    } else {
      failedAttempt(c);
    }
  } catch (e) {
    setConn(false, "нет связи с сервером");
    failedAttempt(c);
  } finally {
    c.checking = false;
    render();
  }
}

// Бросает ошибку на любой не-2xx ответ (для загрузки списка)
function request(url, options = {}) {
  return rawRequest(url, options).then(resp => {
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    return resp;
  });
}

// Возвращает ответ как есть — код статуса разбираем сами
function rawRequest(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(timer));
}

function failedAttempt(c) {
  c.attempts++;

  if (c.attempts >= MAX_ATTEMPTS) {
    c.blockedUntil = Date.now() + BLOCK_MS;
    c.attempts = 0;
    toast(`${shortName(c)}: результат не определён. Повторите через 5 минут`, true);
  } else {
    toast(`${shortName(c)}: проверка не удалась. Попробуйте ещё раз`, true);
  }
}

function toggle(id) {
  const c = clients.find(x => x.id === id);
  if (c) {
    c.open = !c.open;
    render();
  }
}

function filtered() {
  const q = query.trim().toLowerCase();
  if (!q) return clients;

  const digits = q.replace(/\D/g, "");

  return clients.filter(c => {
    if (c.fio.toLowerCase().includes(q)) return true;
    if (!digits) return false;
    return (c.inn + c.snils).replace(/\D/g, "").includes(digits);
  });
}

function render() {
  const list = filtered();
  const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  if (page > pages) page = pages;

  const slice = list.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const tb = document.getElementById("tbody");

  document.getElementById("countHint").textContent =
    query.trim() ? `найдено ${list.length} из ${clients.length}` : `${clients.length} чел.`;

  if (!slice.length) {
    tb.innerHTML = `<tr><td colspan="3" class="empty">Никого не нашлось. Попробуйте изменить запрос.</td></tr>`;
    document.getElementById("pager").innerHTML = "";
    return;
  }

  tb.innerHTML = slice.map(c => row(c) + (c.open ? card(c) : "")).join("");
  renderPager(list.length, pages);
}

function row(c) {
  const blocked = Date.now() < c.blockedUntil;

  let badge;
  if (c.checking) {
    badge = `<span class="badge pending"><span class="spinner"></span>Проверка в процессе</span>`;
  } else if (blocked && c.amlStatus === null) {
    badge = `<span class="badge retry">Повторите позже</span>`;
  } else if (c.amlStatus === true) {
    badge = `<span class="badge clean">Не в списках</span>`;
  } else if (c.amlStatus === false) {
    badge = `<span class="badge flagged">В списке</span>`;
  } else {
    badge = `<span class="badge unknown">Не проверялся</span>`;
  }

  let btn;
  if (blocked) {
    // Пока действует блокировка — в кнопке тикает обратный отсчёт
    btn = `<button class="btn-check blocked" disabled
             title="Повторная проверка будет доступна через ${mmss(c.blockedUntil)}"
           >через ${mmss(c.blockedUntil)}</button>`;
  } else if (c.checking) {
    btn = `<button class="btn-check" disabled>Проверяем…</button>`;
  } else {
    btn = `<button class="btn-check" onclick="event.stopPropagation(); check(${c.id})">Проверить</button>`;
  }

  return `<tr class="row${c.open ? " open" : ""}" onclick="toggle(${c.id})">
    <td><div class="name"><span class="caret">▶</span>${esc(shortName(c))}</div></td>
    <td>${badge}</td>
    <td>${btn}</td>
  </tr>`;
}

function card(c) {
  const fields = [
    ["ФИО", c.fio],
    ["ИНН", c.inn],
    ["СНИЛС", c.snils],
    ["Регион", c.region],
    ["Последняя проверка", c.lastCheckAt ? fmt(c.lastCheckAt) : "—"]
  ];

  return `<tr class="card-row"><td colspan="3"><div class="card">
    ${fields.map(([label, value]) => `<div>
      <div class="field-label">${label}</div>
      <div class="field-value">${esc(value) || "—"}</div>
    </div>`).join("")}
  </div></td></tr>`;
}

function renderPager(total, pages) {
  const p = document.getElementById("pager");
  if (pages < 2) {
    p.innerHTML = "";
    return;
  }

  const from = (page - 1) * PAGE_SIZE + 1;
  const to = Math.min(page * PAGE_SIZE, total);

  let html = `<span class="info">${from}–${to} из ${total}</span>`;
  html += `<button onclick="go(${page - 1})" ${page === 1 ? "disabled" : ""}>Назад</button>`;
  for (let i = 1; i <= pages; i++) {
    html += `<button class="${i === page ? "active" : ""}" onclick="go(${i})">${i}</button>`;
  }
  html += `<button onclick="go(${page + 1})" ${page === pages ? "disabled" : ""}>Вперёд</button>`;

  p.innerHTML = html;
}

function go(n) {
  page = n;
  render();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

document.getElementById("search").addEventListener("input", e => {
  query = e.target.value;
  page = 1;
  render();
});

// Тикаем обратный отсчёт в кнопках. hadBlocked нужен, чтобы сделать
// ещё один render после истечения блокировки — иначе кнопка так и
// останется висеть с «через 0:01» и неактивной.
let hadBlocked = false;
setInterval(() => {
  const nowBlocked = clients.some(c => Date.now() < c.blockedUntil);
  if (nowBlocked || hadBlocked) render();
  hadBlocked = nowBlocked;
}, 1000);

function blockUntilFrom(lastCheckAt) {
  if (!lastCheckAt) return 0;
  const t = Date.parse(lastCheckAt);
  return Number.isNaN(t) ? 0 : t + BLOCK_MS;
}

function shortName(c) {
  const parts = c.fio.split(/\s+/).filter(Boolean);
  if (!parts.length) return "Без имени";

  const initials = parts.slice(1, 3).map(w => w[0] + ".").join(" ");
  return initials ? `${parts[0]} ${initials}` : parts[0];
}

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function mmss(until) {
  const s = Math.max(0, Math.ceil((until - Date.now()) / 1000));
  return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
}

function fmt(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";

  return d.toLocaleDateString("ru-RU") + " " +
         d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}

// Отметка времени под кнопкой «Обновить список».
// Живёт только в браузере: перезагрузил страницу — сбросилась.
function setLastUpdate(date) {
  const el = document.getElementById("lastUpdate");
  if (!el) return;

  const time = date.toLocaleTimeString("ru-RU", {
    hour: "2-digit", minute: "2-digit", second: "2-digit"
  });
  el.textContent = `обновлено в ${time}`;
}

function setConn(ok, text) {
  document.getElementById("connDot").className = "dot" + (ok ? "" : " off");
  document.getElementById("connText").textContent = text;
}

let toastTimer;
function toast(msg, isErr) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.className = "toast show" + (isErr ? " err" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.className = "toast", 3500);
}

loadClients();
