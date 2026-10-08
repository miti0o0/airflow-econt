/* AirFlow – Товарителници Еконт (версия за телефон).
   Работи изцяло в браузъра и ползва официалното JSON API на Еконт без вход,
   както формата на econt.com. Настройките и историята се пазят в localStorage. */
"use strict";

const BASE_URLS = {
  test: "https://demo.econt.com/ee/services",
  real: "https://ee.econt.com/services",
};
// Публичният тестов акаунт от документацията на Еконт – само за demo.econt.com.
const DEMO_AUTH = "Basic " + btoa("iasp-dev:1Asp-dev");

const STATUS_CREATED = "Създадена";
const STATUS_CANCELLED = "Анулирана";
const STATUS_ABANDONED = "Отказана";
const CLOSED = [STATUS_CANCELLED, STATUS_ABANDONED];
const ENV_NAMES = { test: "Тестова", real: "Реална" };

const DEFAULTS = {
  environment: "test",
  sender: { name: "", phone: "", email: "", city: "Правец", officeCode: { test: "", real: "" } },
  shipment: { type: "pack", packCount: 1, weightKg: 1, lengthCm: 61, widthCm: 44, heightCm: 37,
              descriptions: ["Слушалки", "Джаджи", "Техника", "Устройство"] },
  services: { cdCurrency: "EUR", review: true, reviewAndTest: false, deliveryPayer: "receiver",
              returnPayer: "receiver", smsNotification: true, emailNotification: true },
};

const $ = (id) => document.getElementById(id);

/* ---------- съхранение ---------- */
function load(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) {
    return fallback;
  }
}
function save(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}
function merge(defaults, saved) {
  const result = Array.isArray(defaults) ? defaults.slice() : { ...defaults };
  for (const [key, value] of Object.entries(saved || {})) {
    const isObject = value && typeof value === "object" && !Array.isArray(value);
    result[key] = isObject && result[key] && typeof result[key] === "object" ? merge(result[key], value) : value;
  }
  return result;
}

let settings = merge(DEFAULTS, load("af_settings", {}));
let history = load("af_history", []);
let offices = [];
let officesUpdated = "";
let selectedOffice = null;
let description = "";
let busy = false;

const env = () => settings.environment;
const saveSettings = () => save("af_settings", settings);
const saveHistory = () => save("af_history", history);

/* ---------- API ---------- */
function collectMessages(error, prefix = "") {
  const message = (error.message || "").trim();
  const inner = (error.innerErrors || []).filter((e) => e && typeof e === "object");
  if (inner.length) {
    let label = (prefix + message).trim();
    if (label && !label.endsWith(":")) label += ":";
    const lines = inner.flatMap((child) => collectMessages(child, label ? label + " " : ""));
    if (lines.length) return lines;
  }
  return message ? [prefix + message] : [];
}

function errorText(data, status) {
  if (data && typeof data === "object" && ("type" in data || "message" in data)) {
    const lines = [...new Set(collectMessages(data))];
    return lines.join("\n") || "Еконт отказа заявката без обяснение.";
  }
  if (status >= 500) return `Системата на Еконт върна грешка (${status}). Опитай отново след малко.`;
  return `Неочакван отговор от Еконт (код ${status}).`;
}

async function api(path, body, environment = env()) {
  const headers = { "Content-Type": "application/json" };
  if (environment === "test") headers.Authorization = DEMO_AUTH;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  let response;
  try {
    response = await fetch(`${BASE_URLS[environment]}/${path}`, {
      method: "POST", headers, body: JSON.stringify(body), signal: controller.signal,
    });
  } catch (e) {
    throw new Error(e.name === "AbortError"
      ? "Еконт не отговори навреме. Провери интернет връзката и опитай отново."
      : "Няма връзка с интернет или системата на Еконт е недостъпна.");
  } finally {
    clearTimeout(timer);
  }
  let data = null;
  try { data = await response.json(); } catch (e) { /* не е JSON */ }
  if (!response.ok || !data || typeof data !== "object") throw new Error(errorText(data, response.status));
  return data;
}

/* ---------- валидации ---------- */
class ValidationError extends Error {}

function validateName(value) {
  const name = value.trim().split(/\s+/).filter(Boolean);
  if (name.length < 2 || name[0].length < 2 || name[1].length < 2) {
    throw new ValidationError("Въведи име и фамилия на получателя.");
  }
  return name.join(" ");
}

function normalizePhone(value, who = "получателя") {
  let phone = value.trim().replace(/[\s\-()./]/g, "");
  if (!phone) throw new ValidationError(`Въведи телефон на ${who}.`);
  if (phone.startsWith("+359")) phone = "0" + phone.slice(4);
  else if (phone.startsWith("00359")) phone = "0" + phone.slice(5);
  if (!/^0[1-9]\d{7,8}$/.test(phone)) {
    throw new ValidationError("Невалиден телефон. Очаква се български номер: 08XXXXXXXX, +3598XXXXXXXX или 003598XXXXXXXX.");
  }
  if (/^0[89]/.test(phone) && !/^0[89]\d{8}$/.test(phone)) {
    throw new ValidationError("Мобилният номер трябва да е с 10 цифри (напр. 0887123456).");
  }
  return phone;
}

function validateEmail(value, who = "получателя") {
  const email = value.trim();
  if (!email) throw new ValidationError(`Въведи имейл на ${who}.`);
  if (!/^[A-Za-z0-9._%+\-]+@[A-Za-z0-9\-]+(\.[A-Za-z0-9\-]+)*\.[A-Za-z]{2,}$/.test(email) || email.includes("..")) {
    throw new ValidationError("Невалиден имейл адрес (напр. ime@domain.bg).");
  }
  return email;
}

function parseAmount(value) {
  const text = value.trim().replace(/\s/g, "");
  if (!text) throw new ValidationError("Въведи сума за наложен платеж.");
  if (!/^\d+([.,]\d{1,2})?$/.test(text)) {
    throw new ValidationError("Сумата трябва да е положително число с до 2 знака след запетаята (напр. 49,90).");
  }
  const amount = Number(text.replace(",", "."));
  if (!(amount > 0)) throw new ValidationError("Сумата за наложен платеж трябва да е по-голяма от 0.");
  return amount;
}

const money = (value) => Number(value).toFixed(2).replace(".", ",");

/* ---------- заявка към Еконт ---------- */
function pickDescription(previous = "") {
  let choices = settings.shipment.descriptions.map((d) => d.trim()).filter(Boolean);
  if (!choices.length) return "Пратка";
  if (previous && choices.length > 1) choices = choices.filter((c) => c !== previous);
  return choices[Math.floor(Math.random() * choices.length)];
}

function buildLabel(recipient, descriptionText) {
  const { sender, shipment, services } = settings;
  const receiverClient = { name: recipient.name, phones: [recipient.phone] };
  if (services.emailNotification && recipient.email) receiverClient.email = recipient.email;
  const label = {
    senderClient: { name: sender.name, phones: [sender.phone], email: sender.email },
    senderOfficeCode: sender.officeCode[env()],
    receiverClient,
    receiverOfficeCode: recipient.officeCode,
    packCount: Number(shipment.packCount),
    shipmentType: shipment.type,
    weight: Number(shipment.weightKg),
    shipmentDimensionsL: Number(shipment.lengthCm),
    shipmentDimensionsW: Number(shipment.widthCm),
    shipmentDimensionsH: Number(shipment.heightCm),
    shipmentDescription: descriptionText,
    payAfterAccept: Boolean(services.review),
    payAfterTest: Boolean(services.reviewAndTest),
    services: {
      cdAmount: recipient.amount,
      cdType: "get",
      cdCurrency: services.cdCurrency,
      smsNotification: Boolean(services.smsNotification),
    },
    instructions: [{
      type: "return",
      returnInstructionParams: {
        // Без rejectAction Еконт не записва кой плаща при отказ (проверено в тестовата среда).
        rejectAction: "return_to_sender",
        rejectOriginalParcelPaySide: services.returnPayer,
        rejectReturnParcelPaySide: services.returnPayer,
      },
    }],
  };
  if (services.deliveryPayer === "receiver") label.paymentReceiverMethod = "cash";
  else label.paymentSenderMethod = "cash";
  return label;
}

/* ---------- офиси ---------- */
function officeDisplay(office) {
  return `${office.city} – ${office.name}${office.aps ? " [Еконтомат]" : ""} (${office.code})`;
}

function setOffices(list, updated) {
  offices = list.slice().sort((a, b) => (a.city + a.name).localeCompare(b.city + b.name, "bg"));
  officesUpdated = updated;
}

function loadOfficesFromCache() {
  const cached = load(`af_offices_${env()}`, null);
  setOffices(cached ? cached.offices : [], cached ? cached.updated : "");
  return offices.length > 0;
}

async function refreshOffices() {
  const environment = env();
  $("officesInfo").textContent = "Зареждане на офисите…";
  $("refreshOffices").disabled = true;
  try {
    const data = await api("Nomenclatures/NomenclaturesService.getOffices.json", { countryCode: "BGR" }, environment);
    const list = (data.offices || []).map((raw) => {
      const address = raw.address || {};
      const city = address.city || {};
      return {
        code: String(raw.code || "").trim(), name: (raw.name || "").trim(), city: (city.name || "").trim(),
        address: (address.fullAddress || "").replace(/\s+/g, " ").trim(), aps: Boolean(raw.isAPS),
      };
    }).filter((o) => o.code && o.city);
    if (!list.length) throw new Error("Еконт върна празен списък с офиси.");
    const updated = new Date().toLocaleString("bg-BG", { dateStyle: "short", timeStyle: "short" });
    save(`af_offices_${environment}`, { updated, offices: list });
    if (environment === env()) {
      setOffices(list, updated);
      ensureSenderOffice();
    }
  } catch (e) {
    showMessage(`Офисите не можаха да се заредят. ${e.message}`, "error");
  } finally {
    $("refreshOffices").disabled = false;
    renderOfficesInfo();
    fillSenderOffices();
    renderSummary();
  }
}

function officesInCity(city) {
  const wanted = city.trim().toLowerCase();
  return offices.filter((o) => o.city.toLowerCase() === wanted);
}
const officeByCode = (code) => offices.find((o) => o.code === code) || null;

function searchOffices(query, limit = 40) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return offices.slice(0, limit);
  const text = (o) => `${o.city} ${o.name} ${o.code} ${o.address}`.toLowerCase();
  const title = (o) => `${o.city} ${o.name} ${o.code}`.toLowerCase();
  const rank = (o) => [
    words.every((w) => title(o).includes(w)) ? 0 : 1,
    o.city.toLowerCase().startsWith(words[0]) ? 0 : 1,
    o.name.toLowerCase().startsWith(words[0]) ? 0 : 1,
  ].join("");
  return offices.filter((o) => words.every((w) => text(o).includes(w)))
    .sort((a, b) => rank(a).localeCompare(rank(b)) || (a.city + a.name).localeCompare(b.city + b.name, "bg"))
    .slice(0, limit);
}

function ensureSenderOffice() {
  const current = settings.sender.officeCode[env()];
  if (current && officeByCode(current)) return;
  const candidates = officesInCity(settings.sender.city);
  settings.sender.officeCode[env()] = candidates.length ? candidates[0].code : "";
  saveSettings();
  if (candidates.length > 1) {
    showMessage(`В гр. ${settings.sender.city} има ${candidates.length} офиса. Избран е първият – провери го в „Настройки“.`, "warn");
  } else if (!candidates.length && offices.length) {
    showMessage(`Не е намерен офис на Еконт в гр. ${settings.sender.city}. Провери града в „Настройки“.`, "error");
  }
}

/* ---------- екран „Нова“ ---------- */
function showMessage(text, kind = "") {
  const element = $("message");
  element.textContent = text;
  element.className = "message" + (kind ? " " + kind : "");
}

function renderOfficesInfo() {
  $("officesInfo").textContent = offices.length
    ? `${offices.length} офиса · обновени на ${officesUpdated}` : "Офисите не са заредени";
}

function renderSummary() {
  const senderOffice = officeByCode(settings.sender.officeCode[env()]);
  const amount = $("amount").value.trim();
  const rows = [
    ["Получател", $("name").value.trim().replace(/\s+/g, " ") || "—"],
    ["Телефон", $("phone").value.trim() || "—"],
    ["Офис", selectedOffice ? officeDisplay(selectedOffice) : "—"],
    ["Наложен платеж", amount ? `${amount} ${settings.services.cdCurrency}` : "—"],
    ["Описание", description],
    ["Изпраща се от", senderOffice ? officeDisplay(senderOffice) : `няма избран офис в гр. ${settings.sender.city}`],
  ];
  const list = $("summary");
  list.replaceChildren();
  for (const [title, value] of rows) {
    const dt = document.createElement("dt");
    dt.textContent = title;
    const dd = document.createElement("dd");
    dd.textContent = value;
    if (title === "Описание") {
      const again = document.createElement("button");
      again.type = "button";
      again.className = "link";
      again.style.marginLeft = "12px";
      again.textContent = "↻ друго";
      again.onclick = () => { description = pickDescription(description); renderSummary(); };
      dd.append(again);
    }
    list.append(dt, dd);
  }
  const notes = [];
  if (selectedOffice && selectedOffice.aps && (settings.services.review || settings.services.reviewAndTest)) {
    notes.push("Еконтомат: услугата „Преглед“ не се прилага при автоматична станция.");
  }
  notes.push(env() === "test" ? "Тестова среда – товарителниците не са истински."
    : "Без вход в е-Еконт – товарителницата не може да се анулира от тук.");
  $("summaryNote").textContent = notes.join("\n");
}

function renderOfficeList() {
  const list = $("officeList");
  const matches = searchOffices($("office").value);
  list.replaceChildren();
  if (!matches.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = offices.length ? "Няма офис с такова име" : "Офисите не са заредени – натисни „Обнови офисите“";
    list.append(li);
  }
  for (const office of matches) {
    const li = document.createElement("li");
    li.textContent = officeDisplay(office);
    const small = document.createElement("small");
    small.textContent = office.address;
    li.append(small);
    li.onclick = () => chooseOffice(office);
    list.append(li);
  }
  list.hidden = false;
}

function chooseOffice(office) {
  selectedOffice = office;
  $("office").value = office ? officeDisplay(office) : "";
  $("officeList").hidden = true;
  renderSummary();
}

function collectRecipient() {
  const steps = [
    ["name", () => validateName($("name").value)],
    ["phone", () => normalizePhone($("phone").value)],
    ["email", () => validateEmail($("email").value)],
    ["office", () => {
      if (!selectedOffice) throw new ValidationError("Избери офис на Еконт от списъка (напиши град или име на офис).");
      return selectedOffice.code;
    }],
    ["amount", () => parseAmount($("amount").value)],
  ];
  const values = {};
  for (const [id, check] of steps) {
    try {
      values[id] = check();
    } catch (e) {
      showMessage(e.message, "error");
      $(id).focus();
      return null;
    }
  }
  if (!settings.sender.name || !settings.sender.phone || !settings.sender.email) {
    showMessage("Въведи данните на подателя в „Настройки“.", "error");
    return null;
  }
  if (!settings.sender.officeCode[env()]) {
    showMessage(`Не е избран офис на подателя в гр. ${settings.sender.city}. Обнови офисите и го избери в „Настройки“.`, "error");
    return null;
  }
  return { name: values.name, phone: values.phone, email: values.email, officeCode: values.office, amount: values.amount };
}

function setBusy(value, text = "") {
  busy = value;
  $("calcBtn").disabled = value;
  $("createBtn").disabled = value;
  if (value) showMessage(text, "muted");
}

function quoteFrom(response) {
  const label = response.label;
  return {
    total: label.totalPrice || 0, currency: label.currency || "",
    receiverDue: label.receiverDueAmount || 0, senderDue: label.senderDueAmount || 0,
    services: (label.services || []).map((s) => [s.description || s.type || "", s.price || 0, s.currency || ""]),
    reviewIgnored: response.payAfterAcceptIgnored || "",
  };
}

async function onCalculate() {
  if (busy) return;
  const recipient = collectRecipient();
  if (!recipient) return;
  setBusy(true, "Изчисляване на цената…");
  try {
    const response = await api("Shipments/LabelService.createLabel.json",
      { label: buildLabel(recipient, description), mode: "calculate" });
    const quote = quoteFrom(response);
    const lines = [`Цена на доставката: ${money(quote.total)} ${quote.currency}`];
    for (const [name, price, currency] of quote.services) lines.push(`   • ${name}: ${money(price)} ${currency}`);
    lines.push(`Плаща получателят: ${money(quote.receiverDue)}  ·  плаща подателят: ${money(quote.senderDue)}`);
    if (quote.reviewIgnored) lines.push(quote.reviewIgnored);
    showMessage(lines.join("\n"));
  } catch (e) {
    showMessage(e.message, "error");
  } finally {
    setBusy(false);
  }
}

const httpsUrl = (url) => (url || "").replace(/^http:\/\//, "https://");

async function onCreate() {
  if (busy) return;
  const recipient = collectRecipient();
  if (!recipient) return;
  const usedDescription = description;
  const office = selectedOffice;
  setBusy(true, "Създаване на товарителницата…");
  try {
    const response = await api("Shipments/LabelService.createLabel.json",
      { label: buildLabel(recipient, usedDescription), mode: "create" });
    const number = String(response.label.shipmentNumber || "").trim();
    if (!number) throw new Error("Еконт не върна номер на товарителница.");
    const quote = quoteFrom(response);
    const pdfUrl = httpsUrl(response.label.pdfURL);
    history.unshift({
      id: Date.now(), createdAt: new Date().toISOString(), env: env(), number,
      name: recipient.name, phone: recipient.phone, email: recipient.email,
      officeCode: office.code, officeName: officeDisplay(office), amount: recipient.amount,
      currency: settings.services.cdCurrency, description: usedDescription, price: quote.total,
      status: STATUS_CREATED, pdfUrl,
    });
    saveHistory();

    $("resultNumber").textContent = number;
    const info = [`Доставка: ${money(quote.total)} ${quote.currency} (получател: ${money(quote.receiverDue)})`];
    if (quote.reviewIgnored) info.push(quote.reviewIgnored);
    $("resultInfo").textContent = info.join("\n");
    $("pdfLink").href = pdfUrl;
    $("pdfLink").hidden = !pdfUrl;
    $("result").hidden = false;
    showMessage("Товарителницата е създадена.", "ok");
    for (const id of ["name", "phone", "email", "amount"]) $(id).value = "";
    chooseOffice(null);
    description = pickDescription(usedDescription);
    renderSummary();
    window.scrollTo({ top: Math.max(0, $("result").offsetTop - 120), behavior: "smooth" });
  } catch (e) {
    showMessage(e.message, "error");
  } finally {
    setBusy(false);
  }
}

async function copyText(text, button) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (e) {
    const area = document.createElement("textarea");
    area.value = text;
    document.body.append(area);
    area.select();
    document.execCommand("copy");
    area.remove();
  }
  if (button) {
    const original = button.textContent;
    button.textContent = "Копирано ✓";
    setTimeout(() => { button.textContent = original; }, 1500);
  }
}

/* ---------- история ---------- */
function formatDate(iso) {
  return new Date(iso).toLocaleString("bg-BG", { dateStyle: "short", timeStyle: "short" });
}

function renderHistory() {
  const needle = $("search").value.trim().toLowerCase();
  const rows = history.filter((r) => !needle || r.name.toLowerCase().includes(needle)
    || r.phone.includes(needle) || r.number.includes(needle));
  $("historyCount").textContent = `${rows.length} товарителници`;
  const container = $("historyList");
  container.replaceChildren();
  for (const row of rows) {
    const closed = CLOSED.includes(row.status);
    const item = document.createElement("div");
    item.className = "item" + (closed ? " closed" : "");

    const top = document.createElement("div");
    top.className = "top";
    const number = document.createElement("span");
    number.textContent = row.number;
    const amount = document.createElement("span");
    amount.textContent = `${money(row.amount)} ${row.currency}`;
    top.append(number, amount);

    const who = document.createElement("div");
    who.textContent = `${row.name} · ${row.phone}`;
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = `${row.officeName}\n${formatDate(row.createdAt)} · ${row.description} · ${row.status} · ${ENV_NAMES[row.env]}`;
    meta.style.whiteSpace = "pre-line";

    const actions = document.createElement("div");
    actions.className = "actions";
    if (row.pdfUrl) {
      const pdf = document.createElement("a");
      pdf.className = "button outline";
      pdf.href = row.pdfUrl;
      pdf.target = "_blank";
      pdf.rel = "noopener";
      pdf.textContent = "PDF";
      actions.append(pdf);
    }
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "outline";
    copy.textContent = "Копирай №";
    copy.onclick = () => copyText(row.number, copy);
    actions.append(copy);
    if (!closed) {
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "danger";
      cancel.textContent = "Анулирай";
      cancel.onclick = () => cancelShipment(row, cancel);
      actions.append(cancel);
    }
    item.append(top, who, meta, actions);
    container.append(item);
  }
}

async function cancelShipment(row, button) {
  if (!confirm(`Да анулирам ли товарителница № ${row.number}?\n\nПолучател: ${row.name}\nСума: ${money(row.amount)} ${row.currency}`)) return;
  button.disabled = true;
  try {
    const data = await api("Shipments/LabelService.deleteLabels.json", { shipmentNumbers: [row.number] }, row.env);
    const failed = (data.results || []).map((r) => r.error).find(Boolean);
    if (failed && failed.type === "ExAccessDenied") {
      const mark = confirm(`Еконт не позволява товарителница № ${row.number} да се анулира от тук – така е за товарителници, създадени без вход.\n\nДокато не я предадеш в офиса, тя не се изпраща.\nДа я отбележа ли като „Отказана“ в историята?`);
      if (mark) row.status = STATUS_ABANDONED;
    } else if (failed) {
      throw new Error(collectMessages(failed).join(" ") || "Неуспешно анулиране.");
    } else {
      row.status = STATUS_CANCELLED;
    }
    saveHistory();
  } catch (e) {
    alert(e.message);
  }
  renderHistory();
}

async function refreshStatuses() {
  const button = $("refreshStatuses");
  button.disabled = true;
  try {
    for (const environment of ["test", "real"]) {
      const rows = history.filter((r) => r.env === environment && !CLOSED.includes(r.status));
      for (let start = 0; start < rows.length; start += 50) {
        const chunk = rows.slice(start, start + 50);
        const data = await api("Shipments/ShipmentService.getShipmentStatuses.json",
          { shipmentNumbers: chunk.map((r) => r.number) }, environment);
        for (const item of data.shipmentStatuses || []) {
          const status = item.status;
          const row = status && chunk.find((r) => r.number === String(status.shipmentNumber));
          if (row && (status.shortDeliveryStatus || "").trim()) row.status = status.shortDeliveryStatus.trim();
        }
      }
    }
    saveHistory();
  } catch (e) {
    alert(e.message);
  }
  button.disabled = false;
  renderHistory();
}

function exportCsv() {
  if (!history.length) { alert("Няма товарителници за експорт."); return; }
  const header = ["Дата", "Номер", "Получател", "Телефон", "Имейл", "Офис", "Сума НП", "Валута", "Описание", "Статус", "Среда"];
  const cell = (value) => `"${String(value ?? "").replace(/"/g, '""')}"`;
  const lines = [header.map(cell).join(";")];
  for (const r of history) {
    lines.push([formatDate(r.createdAt), r.number, r.name, r.phone, r.email, r.officeName, money(r.amount),
      r.currency, r.description, r.status, ENV_NAMES[r.env]].map(cell).join(";"));
  }
  const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `tovaritelnici_${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 5000);
}

/* ---------- настройки ---------- */
function fillSenderOffices() {
  const select = $("sOffice");
  const candidates = officesInCity(settings.sender.city);
  select.replaceChildren();
  if (!candidates.length) select.append(new Option("— няма намерен офис —", ""));
  for (const office of candidates) select.append(new Option(officeDisplay(office), office.code));
  select.value = settings.sender.officeCode[env()] || (candidates[0] ? candidates[0].code : "");
}

function fillSettingsForm() {
  const { sender, shipment, services } = settings;
  $("sName").value = sender.name;
  $("sPhone").value = sender.phone;
  $("sEmail").value = sender.email;
  $("sCity").value = sender.city;
  $("pCount").value = shipment.packCount;
  $("pWeight").value = shipment.weightKg;
  $("pL").value = shipment.lengthCm;
  $("pW").value = shipment.widthCm;
  $("pH").value = shipment.heightCm;
  $("pDesc").value = shipment.descriptions.join(", ");
  $("vReview").checked = services.review;
  $("vTest").checked = services.reviewAndTest;
  $("vSms").checked = services.smsNotification;
  $("vEmail").checked = services.emailNotification;
  $("vDelivery").value = services.deliveryPayer;
  $("vReturn").value = services.returnPayer;
  fillSenderOffices();
  for (const button of document.querySelectorAll(".segmented button")) {
    button.classList.toggle("active", button.dataset.env === env());
  }
  $("setupNote").hidden = Boolean(sender.name && sender.phone && sender.email);
}

function settingsMessage(text, kind) {
  $("settingsMessage").textContent = text;
  $("settingsMessage").className = "message " + kind;
}

function onSaveSettings() {
  const number = (id, title, integer = false) => {
    const value = Number($(id).value.trim().replace(",", "."));
    if (!Number.isFinite(value) || value <= 0 || (integer && !Number.isInteger(value))) {
      throw new ValidationError(`„${title}“ трябва да е положително число.`);
    }
    return value;
  };
  try {
    const name = $("sName").value.trim().replace(/\s+/g, " ");
    if (!name) throw new ValidationError("Въведи име на подателя.");
    const phone = normalizePhone($("sPhone").value, "подателя");
    const email = validateEmail($("sEmail").value, "подателя");
    const city = $("sCity").value.trim().replace(/\s+/g, " ");
    if (!city) throw new ValidationError("Въведи град на изпращане.");
    const descriptions = $("pDesc").value.split(",").map((d) => d.trim()).filter(Boolean);
    if (!descriptions.length) throw new ValidationError("Въведи поне едно описание на съдържанието.");
    const shipment = {
      type: "pack", packCount: number("pCount", "Брой", true), weightKg: number("pWeight", "Тегло"),
      lengthCm: number("pL", "Дължина"), widthCm: number("pW", "Ширина"), heightCm: number("pH", "Височина"),
      descriptions,
    };
    const cityChanged = city.toLowerCase() !== settings.sender.city.toLowerCase();
    Object.assign(settings.sender, { name, phone, email, city });
    if (cityChanged) settings.sender.officeCode = { test: "", real: "" };
    else if ($("sOffice").value) settings.sender.officeCode[env()] = $("sOffice").value;
    settings.shipment = shipment;
    Object.assign(settings.services, {
      review: $("vReview").checked, reviewAndTest: $("vTest").checked, smsNotification: $("vSms").checked,
      emailNotification: $("vEmail").checked, deliveryPayer: $("vDelivery").value, returnPayer: $("vReturn").value,
    });
    saveSettings();
    if (cityChanged) ensureSenderOffice();
    if (!settings.shipment.descriptions.includes(description)) description = pickDescription();
    fillSettingsForm();
    renderSummary();
    settingsMessage("Настройките са запазени.", "ok");
  } catch (e) {
    settingsMessage(e.message, "error");
  }
}

function switchEnvironment(environment) {
  if (environment === env()) return;
  if (environment === "real" && !confirm("Превключване към РЕАЛНАТА среда на Еконт.\n\nОттук нататък ще се създават истински товарителници.\nДа продължа ли?")) return;
  settings.environment = environment;
  saveSettings();
  chooseOffice(null);
  $("result").hidden = true;
  showMessage("");
  startEnvironment();
}

function renderBadge() {
  const badge = $("envBadge");
  badge.textContent = env() === "test" ? "ТЕСТОВА СРЕДА" : "РЕАЛНА СРЕДА";
  badge.className = "badge " + env();
}

function startEnvironment() {
  renderBadge();
  if (loadOfficesFromCache()) ensureSenderOffice();
  else refreshOffices();
  renderOfficesInfo();
  fillSettingsForm();
  renderSummary();
}

/* ---------- навигация и старт ---------- */
function showTab(name) {
  for (const section of document.querySelectorAll(".tab")) section.hidden = section.id !== `tab-${name}`;
  for (const button of document.querySelectorAll("nav button")) button.classList.toggle("active", button.dataset.tab === name);
  if (name === "history") renderHistory();
  if (name === "settings") fillSettingsForm();
  if (name === "create") renderSummary();
  window.scrollTo(0, 0);
}

function init() {
  description = pickDescription();
  for (const button of document.querySelectorAll("nav button")) button.onclick = () => showTab(button.dataset.tab);
  for (const button of document.querySelectorAll(".segmented button")) button.onclick = () => switchEnvironment(button.dataset.env);

  for (const id of ["name", "phone", "email", "amount"]) $(id).addEventListener("input", renderSummary);
  const order = ["name", "phone", "email", "office", "amount"];
  for (const id of order) {
    $(id).addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      if (id === "office") {
        const first = searchOffices($("office").value)[0];
        if (!selectedOffice && first) chooseOffice(first);
        $("amount").focus();
      } else if (id === "amount") {
        onCreate();
      } else {
        $(order[order.indexOf(id) + 1]).focus();
      }
    });
  }
  $("office").addEventListener("input", () => {
    if (selectedOffice && $("office").value !== officeDisplay(selectedOffice)) selectedOffice = null;
    renderOfficeList();
    renderSummary();
  });
  $("office").addEventListener("focus", () => { if (!selectedOffice) renderOfficeList(); else $("office").select(); });
  document.addEventListener("click", (event) => {
    if (!event.target.closest("#office, #officeList")) $("officeList").hidden = true;
  });

  $("refreshOffices").onclick = refreshOffices;
  $("calcBtn").onclick = onCalculate;
  $("createBtn").onclick = onCreate;
  $("copyBtn").onclick = () => copyText($("resultNumber").textContent, $("copyBtn"));
  $("search").addEventListener("input", renderHistory);
  $("refreshStatuses").onclick = refreshStatuses;
  $("exportCsv").onclick = exportCsv;
  $("saveSettings").onclick = onSaveSettings;

  startEnvironment();
  const senderReady = settings.sender.name && settings.sender.phone && settings.sender.email;
  showTab(senderReady ? "create" : "settings");
}

init();
